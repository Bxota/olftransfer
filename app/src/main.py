import hashlib
import os
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import Cookie, Depends, FastAPI, HTTPException, Query, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .auth import (
    create_session,
    get_current_user,
    get_session_user_id,
    hash_password,
    require_admin,
    seed_admin,
    verify_password,
)
from .cron import _do_cleanup, cleanup_expired, scheduler
from .db import get_conn
from .email import send_invite
from .models import (
    CreateTransferRequest,
    CreateTransferResponse,
    DownloadResponse,
    DownloadUrl,
    FileInfo,
    TransferInfo,
    UploadUrl,
    UserTransfer,
)
from .r2 import presigned_download_url, presigned_upload_url

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
BASE_URL = os.environ.get("BASE_URL", "https://olf-transfer.bxota.com")


@asynccontextmanager
async def lifespan(app: FastAPI):
    seed_admin()
    scheduler.start()
    cleanup_expired()
    yield
    scheduler.shutdown()


app = FastAPI(title="olftransfer", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ── Pages HTML ────────────────────────────────────────────────────────────────

NO_STORE = {"Cache-Control": "no-store"}


@app.get("/", include_in_schema=False)
def index_page(session: str | None = Cookie(default=None)):
    if not get_session_user_id(session):
        return FileResponse(os.path.join(STATIC_DIR, "login.html"), headers=NO_STORE)
    return FileResponse(os.path.join(STATIC_DIR, "index.html"), headers=NO_STORE)


@app.get("/login", include_in_schema=False)
def login_page():
    return FileResponse(os.path.join(STATIC_DIR, "login.html"), headers=NO_STORE)


@app.get("/register", include_in_schema=False)
def register_page():
    return FileResponse(os.path.join(STATIC_DIR, "register.html"))


@app.get("/admin", include_in_schema=False)
def admin_page(session: str | None = Cookie(default=None)):
    if not get_session_user_id(session):
        return FileResponse(os.path.join(STATIC_DIR, "login.html"), headers=NO_STORE)
    return FileResponse(os.path.join(STATIC_DIR, "admin.html"), headers=NO_STORE)


@app.get("/t/{token}", include_in_schema=False)
def transfer_page(token: str):
    return FileResponse(os.path.join(STATIC_DIR, "transfer.html"))


# ── Auth ──────────────────────────────────────────────────────────────────────

@app.post("/auth/login")
def login(body: dict, response: Response):
    email = body.get("email", "").lower().strip()
    password = body.get("password", "")

    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, password_hash FROM users WHERE email = %s", (email,))
        row = cur.fetchone()

    if not row or not verify_password(password, row[1]):
        raise HTTPException(status_code=401, detail="Email ou mot de passe incorrect")

    response.set_cookie(
        "session", create_session(str(row[0])),
        httponly=True, secure=True, samesite="lax",
        max_age=60 * 60 * 24 * 7,
    )
    return {"ok": True}


@app.post("/auth/logout")
def logout(response: Response):
    response.delete_cookie("session")
    return {"ok": True}


@app.get("/auth/me")
def me(user: dict = Depends(get_current_user)):
    return {"email": user["email"], "is_admin": user["is_admin"]}


@app.post("/auth/register")
def register(body: dict, response: Response):
    token = body.get("token", "")
    password = body.get("password", "")

    if len(password) < 8:
        raise HTTPException(status_code=422, detail="Mot de passe trop court (8 caractères min)")

    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, email FROM invitations
            WHERE token = %s AND used_at IS NULL AND expires_at > NOW()
            """,
            (token,),
        )
        invite = cur.fetchone()
        if not invite:
            raise HTTPException(status_code=400, detail="Invitation invalide ou expirée")

        invite_id, email = invite

        cur.execute("SELECT id FROM users WHERE email = %s", (email,))
        if cur.fetchone():
            raise HTTPException(status_code=409, detail="Ce compte existe déjà")

        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id",
            (email, hash_password(password)),
        )
        user_id = cur.fetchone()[0]

        cur.execute("UPDATE invitations SET used_at = NOW() WHERE id = %s", (invite_id,))

    response.set_cookie(
        "session", create_session(str(user_id)),
        httponly=True, secure=True, samesite="lax",
        max_age=60 * 60 * 24 * 7,
    )
    return {"ok": True}


# ── Admin ─────────────────────────────────────────────────────────────────────

@app.post("/admin/invite", dependencies=[Depends(require_admin)])
def invite_user(body: dict, user: dict = Depends(require_admin)):
    email = body.get("email", "").lower().strip()
    if not email or "@" not in email:
        raise HTTPException(status_code=422, detail="Email invalide")

    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(hours=48)

    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM users WHERE email = %s", (email,))
        if cur.fetchone():
            raise HTTPException(status_code=409, detail="Un compte existe déjà pour cet email")

        cur.execute(
            """
            INSERT INTO invitations (token, email, invited_by, expires_at)
            VALUES (%s, %s, %s, %s)
            """,
            (token, email, user["id"], expires_at),
        )

    invite_url = f"{BASE_URL}/register?token={token}"
    try:
        send_invite(email, invite_url, user["email"])
    except Exception as e:
        # En cas d'erreur SMTP, on retourne le lien pour l'envoyer manuellement
        return {"ok": True, "invite_url": invite_url, "smtp_error": str(e)}

    return {"ok": True, "invite_url": invite_url}


@app.get("/admin/invite/{token}")
def validate_invite(token: str):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT email FROM invitations WHERE token = %s AND used_at IS NULL AND expires_at > NOW()",
            (token,),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=400, detail="Invitation invalide ou expirée")
    return {"email": row[0]}


@app.get("/admin/users", dependencies=[Depends(require_admin)])
def list_users():
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT email, is_admin, created_at FROM users ORDER BY created_at")
        rows = cur.fetchall()
    return [{"email": r[0], "is_admin": r[1], "created_at": r[2]} for r in rows]


@app.post("/admin/cleanup", dependencies=[Depends(require_admin)])
def trigger_cleanup():
    _do_cleanup()
    return {"ok": True}


# ── API ───────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/transfers", response_model=CreateTransferResponse, status_code=201)
def create_transfer(body: CreateTransferRequest, user: dict = Depends(get_current_user)):
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(hours=body.expires_in_hours)
    password_hash = (
        hashlib.sha256(body.password.encode()).hexdigest() if body.password else None
    )

    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO transfers (user_id, token, expires_at, password_hash, max_downloads)
            VALUES (%s, %s, %s, %s, %s) RETURNING id
            """,
            (user["id"], token, expires_at, password_hash, body.max_downloads),
        )
        transfer_id = cur.fetchone()[0]

        uploads = []
        for f in body.files:
            r2_key = f"{transfer_id}/{secrets.token_hex(8)}_{f.filename}"
            cur.execute(
                """
                INSERT INTO files (transfer_id, filename, size_bytes, mime_type, r2_key)
                VALUES (%s, %s, %s, %s, %s) RETURNING id
                """,
                (transfer_id, f.filename, f.size_bytes, f.mime_type, r2_key),
            )
            file_id = cur.fetchone()[0]
            uploads.append(UploadUrl(
                file_id=str(file_id),
                filename=f.filename,
                upload_url=presigned_upload_url(r2_key, f.mime_type),
            ))

    return CreateTransferResponse(
        token=token,
        share_url=f"{BASE_URL}/t/{token}",
        expires_at=expires_at,
        uploads=uploads,
    )


@app.get("/transfers", response_model=list[UserTransfer])
def list_my_transfers(user: dict = Depends(get_current_user)):
    now = datetime.now(timezone.utc)
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, token, created_at, expires_at, download_count, max_downloads,
                   password_hash IS NOT NULL AS has_password
            FROM transfers WHERE user_id = %s ORDER BY created_at DESC
            """,
            (user["id"],),
        )
        transfers = cur.fetchall()

        result = []
        for t in transfers:
            t_id, token, created_at, expires_at, dl_count, max_dl, has_pw = t
            cur.execute(
                "SELECT filename, size_bytes, mime_type FROM files WHERE transfer_id = %s",
                (t_id,),
            )
            files = [FileInfo(filename=r[0], size_bytes=r[1], mime_type=r[2]) for r in cur.fetchall()]
            expires_aware = expires_at.replace(tzinfo=timezone.utc) if expires_at.tzinfo is None else expires_at
            result.append(UserTransfer(
                token=token,
                share_url=f"{BASE_URL}/t/{token}",
                created_at=created_at,
                expires_at=expires_at,
                is_expired=expires_aware < now,
                download_count=dl_count,
                max_downloads=max_dl,
                has_password=has_pw,
                files=files,
            ))
    return result


@app.get("/transfers/{token}", response_model=TransferInfo)
def get_transfer(token: str):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, expires_at, download_count, max_downloads FROM transfers WHERE token = %s",
            (token,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transfer not found")

        transfer_id, expires_at, download_count, max_downloads = row

        if expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
            raise HTTPException(status_code=410, detail="Transfer expired")

        cur.execute(
            "SELECT filename, size_bytes, mime_type FROM files WHERE transfer_id = %s",
            (transfer_id,),
        )
        files = [FileInfo(filename=r[0], size_bytes=r[1], mime_type=r[2]) for r in cur.fetchall()]

    return TransferInfo(
        token=token,
        expires_at=expires_at,
        download_count=download_count,
        max_downloads=max_downloads,
        files=files,
    )


@app.get("/transfers/{token}/download", response_model=DownloadResponse)
def download_transfer(token: str, password: str | None = Query(default=None)):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, expires_at, password_hash, download_count, max_downloads
            FROM transfers WHERE token = %s
            """,
            (token,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transfer not found")

        transfer_id, expires_at, password_hash, download_count, max_downloads = row

        if expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
            raise HTTPException(status_code=410, detail="Transfer expired")

        if max_downloads and download_count >= max_downloads:
            raise HTTPException(status_code=410, detail="Download limit reached")

        if password_hash:
            if not password:
                raise HTTPException(status_code=401, detail="Password required")
            if hashlib.sha256(password.encode()).hexdigest() != password_hash:
                raise HTTPException(status_code=403, detail="Wrong password")

        cur.execute(
            "SELECT filename, size_bytes, r2_key FROM files WHERE transfer_id = %s",
            (transfer_id,),
        )
        rows = cur.fetchall()

        cur.execute(
            "UPDATE transfers SET download_count = download_count + 1 WHERE id = %s",
            (transfer_id,),
        )

    return DownloadResponse(files=[
        DownloadUrl(filename=r[0], size_bytes=r[1], download_url=presigned_download_url(r[2], r[0]))
        for r in rows
    ])
