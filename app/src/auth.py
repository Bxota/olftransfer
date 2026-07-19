import hashlib
import hmac
import os

import bcrypt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi import Cookie, Depends, Header, HTTPException
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from .db import get_conn

SESSION_MAX_AGE = 60 * 60 * 24 * 7  # 7 jours
_password_hasher = PasswordHasher()


def _signer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(os.environ["APP_SECRET"])


def create_session(user_id: str) -> str:
    return _signer().dumps(user_id)


def get_session_user_id(session: str | None) -> str | None:
    if not session:
        return None
    try:
        return _signer().loads(session, max_age=SESSION_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return None


def hash_password(password: str) -> str:
    return _password_hasher.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    if hashed.startswith("$argon2"):
        try:
            return _password_hasher.verify(hashed, password)
        except (InvalidHashError, VerificationError, VerifyMismatchError):
            return False

    # Compatibilité temporaire : comptes créés avant la migration Argon2.
    if hashed.startswith(("$2a$", "$2b$", "$2y$")):
        try:
            return bcrypt.checkpw(password.encode(), hashed.encode())
        except ValueError:
            return False

    # Compatibilité temporaire : mots de passe de transfert historiquement
    # stockés sous forme d'un SHA-256 hexadécimal non salé.
    if len(hashed) == 64:
        legacy_digest = hashlib.sha256(password.encode()).hexdigest()
        return hmac.compare_digest(legacy_digest, hashed)

    return False


def password_needs_rehash(hashed: str) -> bool:
    if not hashed.startswith("$argon2"):
        return True
    try:
        return _password_hasher.check_needs_rehash(hashed)
    except InvalidHashError:
        return True


def get_current_user(
    session: str | None = Cookie(default=None),
    x_api_key: str | None = Header(default=None, alias="X-Api-Key"),
) -> dict:
    # API key auth (for service accounts like liveslide)
    expected_key = os.environ.get("LIVESLIDE_API_KEY")
    if x_api_key and expected_key and x_api_key == expected_key:
        with get_conn() as conn:
            cur = conn.cursor()
            cur.execute("SELECT id, email, is_admin, storage_quota_bytes FROM users WHERE is_admin = TRUE LIMIT 1")
            row = cur.fetchone()
        if row:
            return {"id": str(row[0]), "email": row[1], "is_admin": row[2], "storage_quota_bytes": row[3]}

    # Session cookie auth
    user_id = get_session_user_id(session)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, email, is_admin, storage_quota_bytes FROM users WHERE id = %s", (user_id,))
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {"id": str(row[0]), "email": row[1], "is_admin": row[2], "storage_quota_bytes": row[3]}


def get_optional_user(session: str | None = Cookie(default=None)) -> dict | None:
    user_id = get_session_user_id(session)
    if not user_id:
        return None
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, email, is_admin, storage_quota_bytes FROM users WHERE id = %s", (user_id,))
        row = cur.fetchone()
    if not row:
        return None
    return {"id": str(row[0]), "email": row[1], "is_admin": row[2], "storage_quota_bytes": row[3]}


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if not user["is_admin"]:
        raise HTTPException(status_code=403, detail="Admin required")
    return user


def seed_admin():
    """Crée le compte admin par défaut au premier démarrage."""
    email = os.environ.get("ADMIN_EMAIL", "")
    password = os.environ.get("ADMIN_PASSWORD", "")
    if not email or not password:
        return
    try:
        with get_conn() as conn:
            cur = conn.cursor()
            cur.execute("SELECT id FROM users WHERE email = %s", (email,))
            if cur.fetchone():
                return
            cur.execute(
                "INSERT INTO users (email, password_hash, is_admin) VALUES (%s, %s, TRUE)",
                (email, hash_password(password)),
            )
    except Exception:
        pass  # table peut ne pas encore exister
