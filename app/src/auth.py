import os
import bcrypt
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from fastapi import Cookie, Depends, HTTPException

from .db import get_conn

SESSION_MAX_AGE = 60 * 60 * 24 * 7  # 7 jours


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
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


def get_current_user(session: str | None = Cookie(default=None)) -> dict:
    user_id = get_session_user_id(session)
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, email, is_admin FROM users WHERE id = %s", (user_id,))
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {"id": str(row[0]), "email": row[1], "is_admin": row[2]}


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
