import base64
import hashlib
import hmac
import json
import os
import secrets
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass

import jwt
from fastapi import HTTPException
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from .db import get_conn

TRANSACTION_MAX_AGE = 10 * 60
TRANSACTION_COOKIE = "__Host-olf_oidc_transaction"
TRANSACTION_FALLBACK_COOKIE = "olf_oidc_transaction"


def transaction_from_cookies(cookies: Mapping[str, str]) -> str | None:
    """Prefer the browser-enforced __Host cookie, with a secure proxy fallback."""
    return cookies.get(TRANSACTION_COOKIE) or cookies.get(TRANSACTION_FALLBACK_COOKIE)


@dataclass(frozen=True)
class OIDCConfig:
    issuer: str
    client_id: str
    redirect_uri: str
    backchannel_url: str


@dataclass(frozen=True)
class OIDCResult:
    claims: dict
    id_token: str
    access_token: str
    refresh_token: str | None


def config() -> OIDCConfig:
    issuer = os.environ["OIDC_ISSUER"].rstrip("/")
    return OIDCConfig(
        issuer=issuer,
        client_id=os.environ["OIDC_CLIENT_ID"],
        redirect_uri=os.environ["OIDC_REDIRECT_URI"],
        backchannel_url=os.environ.get("OIDC_BACKCHANNEL_URL", issuer).rstrip("/"),
    )


def _transaction_signer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(os.environ["APP_SECRET"], salt="oidc-transaction")


def begin_authorization(prompt: str = "") -> tuple[str, str]:
    cfg = config()
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    transaction = _transaction_signer().dumps({"state": state, "nonce": nonce, "verifier": verifier})
    parameters = {
        "response_type": "code",
        "client_id": cfg.client_id,
        "redirect_uri": cfg.redirect_uri,
        "scope": "openid email profile",
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    if prompt == "login":
        parameters["prompt"] = "login"
    query = urllib.parse.urlencode(parameters)
    return f"{cfg.issuer}/authorize?{query}", transaction


def complete_authorization(code: str, state: str, transaction: str | None) -> OIDCResult:
    if not code or not state or not transaction:
        raise HTTPException(status_code=400, detail="Réponse OIDC incomplète")
    try:
        saved = _transaction_signer().loads(transaction, max_age=TRANSACTION_MAX_AGE)
    except (BadSignature, SignatureExpired) as exc:
        raise HTTPException(status_code=400, detail="Transaction OIDC invalide ou expirée") from exc
    if not hmac.compare_digest(str(saved.get("state", "")), state):
        raise HTTPException(status_code=400, detail="État OIDC invalide")

    cfg = config()
    metadata = _get_json(f"{cfg.backchannel_url}/.well-known/openid-configuration")
    if metadata.get("issuer") != cfg.issuer:
        raise HTTPException(status_code=502, detail="Issuer OIDC incohérent")
    token_payload = _post_form(
        _backchannel_endpoint(cfg, metadata["token_endpoint"]),
        {
            "grant_type": "authorization_code",
            "client_id": cfg.client_id,
            "redirect_uri": cfg.redirect_uri,
            "code": code,
            "code_verifier": saved["verifier"],
        },
    )
    id_token = token_payload.get("id_token")
    if not isinstance(id_token, str):
        raise HTTPException(status_code=502, detail="Le fournisseur OIDC n’a pas renvoyé de jeton d’identité")
    access_token = token_payload.get("access_token")
    if not isinstance(access_token, str):
        raise HTTPException(status_code=502, detail="Le fournisseur OIDC n’a pas renvoyé de jeton d’accès")

    try:
        jwks_uri = _backchannel_endpoint(cfg, metadata["jwks_uri"])
        signing_key = jwt.PyJWKClient(jwks_uri, timeout=5).get_signing_key_from_jwt(id_token)
        claims = jwt.decode(
            id_token,
            signing_key.key,
            algorithms=["RS256"],
            audience=cfg.client_id,
            issuer=cfg.issuer,
            options={"require": ["exp", "iat", "iss", "sub", "aud", "nonce"]},
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Jeton d’identité OIDC invalide") from exc
    if not hmac.compare_digest(str(claims.get("nonce", "")), str(saved.get("nonce", ""))):
        raise HTTPException(status_code=401, detail="Nonce OIDC invalide")
    if claims.get("email_verified") is not True or not isinstance(claims.get("email"), str):
        raise HTTPException(status_code=403, detail="Une adresse email vérifiée est requise")
    userinfo_endpoint = metadata.get("userinfo_endpoint")
    if not isinstance(userinfo_endpoint, str):
        raise HTTPException(status_code=502, detail="Endpoint userinfo OIDC absent")
    userinfo = _get_json(_backchannel_endpoint(cfg, userinfo_endpoint), access_token)
    if not isinstance(userinfo.get("sub"), str) or not hmac.compare_digest(userinfo["sub"], str(claims["sub"])):
        raise HTTPException(status_code=401, detail="Sujet userinfo OIDC incohérent")
    if userinfo.get("email_verified") is not True or not isinstance(userinfo.get("email"), str):
        raise HTTPException(status_code=403, detail="Une adresse email vérifiée est requise")
    refresh_token = token_payload.get("refresh_token")
    return OIDCResult(
        claims=userinfo,
        id_token=id_token,
        access_token=access_token,
        refresh_token=refresh_token if isinstance(refresh_token, str) else None,
    )


def find_or_create_user(claims: dict) -> str:
    cfg = config()
    subject = str(claims["sub"])
    email = str(claims["email"]).lower().strip()
    pseudonym = claims.get("preferred_username")
    if not isinstance(pseudonym, str) or not (pseudonym := pseudonym.strip()):
        pseudonym = None
    elif len(pseudonym) > 100:
        raise HTTPException(status_code=400, detail="Pseudo OIDC invalide")
    if not subject or len(subject) > 255 or not email or len(email) > 254:
        raise HTTPException(status_code=400, detail="Identité OIDC invalide")

    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, email, pseudonym FROM users WHERE oidc_issuer = %s AND oidc_subject = %s FOR UPDATE",
            (cfg.issuer, subject),
        )
        row = cur.fetchone()
        if row:
            if row[1] != email or row[2] != pseudonym:
                cur.execute("UPDATE users SET email = %s, pseudonym = %s WHERE id = %s", (email, pseudonym, row[0]))
            return str(row[0])

        cur.execute("SELECT id, oidc_issuer, oidc_subject FROM users WHERE lower(email) = %s FOR UPDATE", (email,))
        row = cur.fetchone()
        if row:
            if row[1] is not None and (row[1] != cfg.issuer or row[2] != subject):
                raise HTTPException(status_code=409, detail="Cette adresse email est déjà liée à une autre identité")
            cur.execute(
                "UPDATE users SET oidc_issuer = %s, oidc_subject = %s, pseudonym = %s WHERE id = %s",
                (cfg.issuer, subject, pseudonym, row[0]),
            )
            return str(row[0])

        cur.execute(
            """
            INSERT INTO users (email, password_hash, oidc_issuer, oidc_subject, pseudonym)
            VALUES (%s, '!oidc', %s, %s, %s)
            RETURNING id
            """,
            (email, cfg.issuer, subject, pseudonym),
        )
        return str(cur.fetchone()[0])


def is_user_authorized(subject: str) -> bool | None:
    """Return None when the entitlement service is temporarily unavailable.

    A missing or older Passerelle endpoint must not turn a valid session into an
    OIDC redirect loop during a rolling deployment. A confirmed `false` still
    revokes the session immediately.
    """
    if not subject:
        return False
    cfg = config()
    try:
        client_id = urllib.parse.quote(cfg.client_id, safe="")
        user_id = urllib.parse.quote(subject, safe="")
        payload = _get_json(f"{cfg.backchannel_url}/internal/applications/{client_id}/authorizations/{user_id}")
    except HTTPException:
        return None
    authorized = payload.get("authorized")
    return authorized if isinstance(authorized, bool) else None


def _get_json(endpoint: str, bearer_token: str = "") -> dict:
    try:
        request = urllib.request.Request(endpoint, headers={"Accept": "application/json"})
        if bearer_token:
            request.add_header("Authorization", f"Bearer {bearer_token}")
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)
    except (OSError, ValueError, urllib.error.HTTPError) as exc:
        raise HTTPException(status_code=502, detail="Fournisseur OIDC indisponible") from exc


def _backchannel_endpoint(cfg: OIDCConfig, published_endpoint: str) -> str:
    parsed = urllib.parse.urlparse(published_endpoint)
    issuer = urllib.parse.urlparse(cfg.issuer)
    if parsed.scheme != issuer.scheme or parsed.netloc != issuer.netloc or not parsed.path.startswith("/"):
        raise HTTPException(status_code=502, detail="Endpoint OIDC incohérent")
    return cfg.backchannel_url + parsed.path


def _post_form(endpoint: str, values: dict[str, str]) -> dict:
    request = urllib.request.Request(
        endpoint,
        data=urllib.parse.urlencode(values).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)
    except (OSError, ValueError, urllib.error.HTTPError) as exc:
        raise HTTPException(status_code=502, detail="Échange de jeton OIDC impossible") from exc


def end_session_url(id_token: str) -> str:
    cfg = config()
    metadata = _get_json(f"{cfg.backchannel_url}/.well-known/openid-configuration")
    endpoint = metadata.get("end_session_endpoint")
    if not isinstance(endpoint, str):
        raise HTTPException(status_code=502, detail="Endpoint de déconnexion OIDC absent")
    published_endpoint = urllib.parse.urlparse(endpoint)
    issuer = urllib.parse.urlparse(cfg.issuer)
    if published_endpoint.scheme != issuer.scheme or published_endpoint.netloc != issuer.netloc:
        raise HTTPException(status_code=502, detail="Endpoint OIDC incohérent")
    application_origin = urllib.parse.urlparse(cfg.redirect_uri)
    post_logout_redirect_uri = urllib.parse.urlunparse((application_origin.scheme, application_origin.netloc, "/auth/logout", "", "logged_out=1", ""))
    return endpoint + "?" + urllib.parse.urlencode({
        "id_token_hint": id_token,
        "client_id": cfg.client_id,
        "post_logout_redirect_uri": post_logout_redirect_uri,
    })
