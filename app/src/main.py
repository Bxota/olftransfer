import hashlib
import os
import secrets
import shutil
import tempfile
import zipfile
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import Cookie, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

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
from .scanner import scan_bytes
from .storage import (
    abort_multipart_upload,
    complete_multipart_upload,
    create_multipart_upload,
    delete_objects,
    download_object,
    get_bucket_stats,
    get_client,
    get_log_content,
    list_log_objects,
    MULTIPART_THRESHOLD,
    presigned_download_url,
    presigned_upload_part,
    presigned_upload_url,
    write_log_event,
)

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
BASE_URL = os.environ.get("BASE_URL", "https://olf-transfer.bxota.com")


def _fmt_bytes(n: int) -> str:
    for unit in ("o", "Ko", "Mo", "Go", "To"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "o" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} Po"


@asynccontextmanager
async def lifespan(app: FastAPI):
    seed_admin()
    scheduler.start()
    cleanup_expired()
    yield
    scheduler.shutdown()


app = FastAPI(title="olftransfer", lifespan=lifespan)

_cors_origins = [o.strip().rstrip("/") for o in os.environ.get("CORS_ALLOWED_ORIGINS", BASE_URL).split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ── Pages HTML ────────────────────────────────────────────────────────────────

NO_STORE = {"Cache-Control": "no-store"}


def _download_file_rows(token: str, password: str | None):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, expires_at, password_hash, download_count, max_downloads
            FROM transfers WHERE token = %s AND confirmed_at IS NOT NULL
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

    return rows


def _zip_entry_name(filename: str, used_names: set[str]) -> str:
    base_name = os.path.basename(filename).strip() or "file"
    candidate = base_name
    stem, extension = os.path.splitext(base_name)
    index = 2

    while candidate in used_names:
        candidate = f"{stem} ({index}){extension}"
        index += 1

    used_names.add(candidate)
    return candidate


def _build_transfer_zip(rows) -> str:
    zip_file = tempfile.NamedTemporaryFile(prefix="transfer-", suffix=".zip", delete=False)
    zip_path = zip_file.name
    zip_file.close()

    bucket_name = os.environ["S3_BUCKET_NAME"].strip()
    used_names: set[str] = set()

    try:
        with zipfile.ZipFile(zip_path, mode="w") as archive:
            for filename, _, object_key in rows:
                archive_name = _zip_entry_name(filename, used_names)
                response = get_client().get_object(Bucket=bucket_name, Key=object_key)
                body = response["Body"]
                try:
                    with archive.open(archive_name, mode="w") as target:
                        shutil.copyfileobj(body, target, length=1024 * 1024)
                finally:
                    body.close()
    except Exception:
        try:
            os.remove(zip_path)
        except OSError:
            pass
        raise

    return zip_path


def _cleanup_file(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


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
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT COALESCE(SUM(f.size_bytes), 0)
            FROM files f
            JOIN transfers t ON f.transfer_id = t.id
            WHERE t.user_id = %s AND t.confirmed_at IS NOT NULL AND t.files_purged_at IS NULL
            """,
            (user["id"],),
        )
        used_bytes = int(cur.fetchone()[0])
    return {
        "email": user["email"],
        "is_admin": user["is_admin"],
        "storage_quota_bytes": user["storage_quota_bytes"],
        "storage_used_bytes": used_bytes,
    }


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
        cur.execute("SELECT id, email, is_admin, is_trusted, created_at, storage_quota_bytes FROM users ORDER BY created_at")
        rows = cur.fetchall()
    return [{"id": str(r[0]), "email": r[1], "is_admin": r[2], "is_trusted": r[3], "created_at": r[4], "storage_quota_bytes": r[5]} for r in rows]


@app.patch("/admin/users/{user_id}/quota", dependencies=[Depends(require_admin)])
def set_user_quota(user_id: str, body: dict):
    quota_bytes = body.get("storage_quota_bytes")
    if not isinstance(quota_bytes, int) or quota_bytes < 0:
        raise HTTPException(status_code=422, detail="storage_quota_bytes doit être un entier positif")
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE users SET storage_quota_bytes = %s WHERE id = %s", (quota_bytes, user_id))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Utilisateur introuvable")
    return {"ok": True}


@app.patch("/admin/users/{user_id}/trusted", dependencies=[Depends(require_admin)])
def set_user_trusted(user_id: str, body: dict):
    is_trusted = body.get("is_trusted")
    if not isinstance(is_trusted, bool):
        raise HTTPException(status_code=422, detail="is_trusted doit être un booléen")
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE users SET is_trusted = %s WHERE id = %s", (is_trusted, user_id))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Utilisateur introuvable")
    return {"ok": True}


@app.get("/admin/stats", dependencies=[Depends(require_admin)])
def admin_stats(refresh: bool = Query(default=False)):
    with get_conn() as conn:
        cur = conn.cursor()

        cur.execute("""
            SELECT COALESCE(SUM(f.size_bytes), 0)
            FROM files f JOIN transfers t ON f.transfer_id = t.id
            WHERE t.files_purged_at IS NULL AND t.confirmed_at IS NOT NULL
        """)
        db_active_bytes = int(cur.fetchone()[0])

        cur.execute("SELECT COALESCE(SUM(size_bytes), 0) FROM files")
        db_total_bytes = int(cur.fetchone()[0])

        cur.execute("""
            SELECT COUNT(*) FROM transfers
            WHERE confirmed_at IS NOT NULL AND files_purged_at IS NULL AND expires_at > NOW()
        """)
        active_transfers = cur.fetchone()[0]

        cur.execute("SELECT COUNT(*) FROM transfers WHERE confirmed_at IS NOT NULL")
        total_transfers = cur.fetchone()[0]

        cur.execute("""
            SELECT COALESCE(SUM(download_count), 0) FROM transfers WHERE confirmed_at IS NOT NULL
        """)
        total_downloads = int(cur.fetchone()[0])

        cur.execute("""
            SELECT u.email,
                   u.storage_quota_bytes,
                   (SELECT COUNT(*) FROM transfers t
                    WHERE t.user_id = u.id AND t.confirmed_at IS NOT NULL
                    AND t.files_purged_at IS NULL AND t.expires_at > NOW()) AS active_transfers,
                   (SELECT COUNT(*) FROM transfers t
                    WHERE t.user_id = u.id AND t.confirmed_at IS NOT NULL) AS total_transfers,
                   (SELECT COALESCE(SUM(f.size_bytes), 0) FROM files f
                    JOIN transfers t ON f.transfer_id = t.id
                    WHERE t.user_id = u.id AND t.files_purged_at IS NULL
                    AND t.confirmed_at IS NOT NULL) AS active_bytes,
                   (SELECT COALESCE(SUM(t.download_count), 0) FROM transfers t
                    WHERE t.user_id = u.id AND t.confirmed_at IS NOT NULL) AS downloads
            FROM users u ORDER BY active_bytes DESC
        """)
        users_stats = [
            {
                "email": r[0],
                "storage_quota_bytes": r[1],
                "active_transfers": r[2],
                "total_transfers": r[3],
                "active_bytes": int(r[4]),
                "downloads": int(r[5]),
            }
            for r in cur.fetchall()
        ]

    try:
        s3 = get_bucket_stats(force_refresh=refresh)
    except Exception as e:
        s3 = {"total_bytes": None, "object_count": None, "last_upload": None, "from_cache": False, "error": str(e)}

    phantom = s3["total_bytes"] - db_active_bytes if s3["total_bytes"] is not None else None

    return {
        "s3": s3,
        "db": {
            "active_bytes": db_active_bytes,
            "total_bytes": db_total_bytes,
            "active_transfers": active_transfers,
            "total_transfers": total_transfers,
            "total_downloads": total_downloads,
        },
        "phantom_bytes": max(0, phantom) if phantom is not None else None,
        "users": users_stats,
    }


@app.post("/admin/cleanup", dependencies=[Depends(require_admin)])
def trigger_cleanup():
    _do_cleanup()
    return {"ok": True}


@app.get("/admin/logs", dependencies=[Depends(require_admin)])
def list_access_logs(prefix: str = Query(default="")):
    objects = list_log_objects(prefix=prefix)
    return [
        {
            "key": o["Key"],
            "size": o["Size"],
            "last_modified": o["LastModified"].isoformat(),
        }
        for o in sorted(objects, key=lambda x: x["LastModified"], reverse=True)
    ]


@app.get("/admin/logs/content", dependencies=[Depends(require_admin)])
def get_access_log(key: str = Query(...)):
    if not os.environ.get("S3_LOGS_BUCKET"):
        raise HTTPException(status_code=503, detail="S3_LOGS_BUCKET non configuré")
    try:
        return {"key": key, "content": get_log_content(key)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── API ───────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/transfers", response_model=CreateTransferResponse, status_code=201)
def create_transfer(body: CreateTransferRequest, request: Request, user: dict = Depends(get_current_user)):
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(hours=body.expires_in_hours)
    password_hash = (
        hashlib.sha256(body.password.encode()).hexdigest() if body.password else None
    )
    requested_bytes = sum(f.size_bytes for f in body.files)

    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT COALESCE(SUM(f.size_bytes), 0)
            FROM files f
            JOIN transfers t ON f.transfer_id = t.id
            WHERE t.user_id = %s AND t.confirmed_at IS NOT NULL AND t.files_purged_at IS NULL
            """,
            (user["id"],),
        )
        used_bytes = int(cur.fetchone()[0])
        if used_bytes + requested_bytes > user["storage_quota_bytes"]:
            raise HTTPException(
                status_code=507,
                detail=f"Quota de stockage dépassé ({_fmt_bytes(used_bytes + requested_bytes)} utilisés / {_fmt_bytes(user['storage_quota_bytes'])})",
            )

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
            if f.size_bytes >= MULTIPART_THRESHOLD:
                mp_upload_id = create_multipart_upload(r2_key, f.mime_type)
                uploads.append(UploadUrl(
                    file_id=str(file_id),
                    filename=f.filename,
                    multipart_upload_id=mp_upload_id,
                ))
            else:
                uploads.append(UploadUrl(
                    file_id=str(file_id),
                    filename=f.filename,
                    upload_url=presigned_upload_url(r2_key, f.mime_type),
                ))

    write_log_event("transfer_created", token, {
        "user_email": user["email"],
        "file_count": len(body.files),
        "total_bytes": sum(f.size_bytes for f in body.files),
        "expires_in_hours": body.expires_in_hours,
        "has_password": bool(body.password),
        "max_downloads": body.max_downloads,
        "ip": request.headers.get("x-forwarded-for", request.client.host if request.client else None),
    })
    return CreateTransferResponse(
        token=token,
        share_url=f"{BASE_URL}/t/{token}",
        expires_at=expires_at,
        uploads=uploads,
    )


@app.post("/uploads/{file_id}/part-url")
def get_part_url(file_id: str, body: dict, user: dict = Depends(get_current_user)):
    upload_id = body.get("upload_id")
    part_number = body.get("part_number")
    if not upload_id or not isinstance(part_number, int):
        raise HTTPException(status_code=422, detail="upload_id et part_number requis")
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT f.r2_key FROM files f JOIN transfers t ON f.transfer_id = t.id WHERE f.id = %s AND t.user_id = %s",
            (file_id, user["id"]),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404)
    return {"url": presigned_upload_part(row[0], upload_id, part_number)}


@app.post("/uploads/{file_id}/complete", status_code=204)
def complete_upload(file_id: str, body: dict, user: dict = Depends(get_current_user)):
    upload_id = body.get("upload_id")
    if not upload_id:
        raise HTTPException(status_code=422, detail="upload_id requis")
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT f.r2_key FROM files f JOIN transfers t ON f.transfer_id = t.id WHERE f.id = %s AND t.user_id = %s",
            (file_id, user["id"]),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404)
    complete_multipart_upload(row[0], upload_id)


@app.post("/uploads/{file_id}/abort", status_code=204)
def abort_upload(file_id: str, body: dict, user: dict = Depends(get_current_user)):
    upload_id = body.get("upload_id")
    if not upload_id:
        raise HTTPException(status_code=422, detail="upload_id requis")
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT f.r2_key FROM files f JOIN transfers t ON f.transfer_id = t.id WHERE f.id = %s AND t.user_id = %s",
            (file_id, user["id"]),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404)
    abort_multipart_upload(row[0], upload_id)


@app.post("/transfers/{token}/confirm")
def confirm_transfer(token: str, body: dict = None, user: dict = Depends(get_current_user)):
    acknowledge_risk = (body or {}).get("acknowledge_risk", False)

    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id FROM transfers WHERE token = %s AND user_id = %s AND confirmed_at IS NULL",
            (token, user["id"]),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transfer not found or already confirmed")
        transfer_id = row[0]

        cur.execute("SELECT r2_key, filename FROM files WHERE transfer_id = %s", (transfer_id,))
        files = cur.fetchall()

    # Scan each file with ClamAV
    for r2_key, filename in files:
        try:
            data = download_object(r2_key)
            virus = scan_bytes(data)
        except Exception as e:
            # ClamAV unavailable — log and allow through to avoid blocking all uploads
            write_log_event("scan_error", token, {"user_email": user["email"], "filename": filename, "error": str(e)})
            continue

        if virus:
            if not user["is_trusted"]:
                # Delete all files and the transfer
                r2_keys = [f[0] for f in files]
                delete_objects(r2_keys)
                with get_conn() as conn:
                    cur = conn.cursor()
                    cur.execute("DELETE FROM transfers WHERE id = %s", (transfer_id,))
                write_log_event("scan_blocked", token, {"user_email": user["email"], "filename": filename, "virus": virus})
                raise HTTPException(status_code=400, detail=f"Fichier refusé : détection antivirus ({virus})")

            if not acknowledge_risk:
                write_log_event("scan_warning", token, {"user_email": user["email"], "filename": filename, "virus": virus})
                from fastapi.responses import JSONResponse
                return JSONResponse(
                    status_code=202,
                    content={"requires_acknowledgment": True, "virus": virus, "filename": filename},
                )

            write_log_event("scan_acknowledged", token, {"user_email": user["email"], "filename": filename, "virus": virus})

    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE transfers SET confirmed_at = NOW() WHERE token = %s AND user_id = %s AND confirmed_at IS NULL",
            (token, user["id"]),
        )
    return Response(status_code=204)


@app.get("/transfers", response_model=list[UserTransfer])
def list_my_transfers(user: dict = Depends(get_current_user)):
    now = datetime.now(timezone.utc)
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, token, created_at, expires_at, download_count, max_downloads,
                   password_hash IS NOT NULL AS has_password
            FROM transfers WHERE user_id = %s AND confirmed_at IS NOT NULL ORDER BY created_at DESC
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


@app.delete("/transfers/{token}", status_code=204)
def delete_transfer(token: str, request: Request, user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, files_purged_at FROM transfers WHERE token = %s AND user_id = %s AND confirmed_at IS NOT NULL",
            (token, user["id"]),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transfer not found")

        transfer_id, files_purged_at = row

        if not files_purged_at:
            cur.execute("SELECT r2_key FROM files WHERE transfer_id = %s", (transfer_id,))
            r2_keys = [r[0] for r in cur.fetchall()]
            delete_objects(r2_keys)

        cur.execute("DELETE FROM transfers WHERE id = %s", (transfer_id,))

    write_log_event("transfer_deleted", token, {
        "user_email": user["email"],
        "reason": "manual",
        "ip": request.headers.get("x-forwarded-for", request.client.host if request.client else None),
    })


@app.get("/transfers/{token}", response_model=TransferInfo)
def get_transfer(token: str):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, expires_at, download_count, max_downloads FROM transfers WHERE token = %s AND confirmed_at IS NOT NULL",
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
def download_transfer(token: str, request: Request, password: str | None = Query(default=None)):
    rows = _download_file_rows(token, password)

    write_log_event("download", token, {
        "ip": request.headers.get("x-forwarded-for", request.client.host if request.client else None),
        "user_agent": request.headers.get("user-agent"),
        "file_count": len(rows),
        "total_bytes": sum(r[1] for r in rows),
    })
    return DownloadResponse(files=[
        DownloadUrl(filename=r[0], size_bytes=r[1], download_url=presigned_download_url(r[2], r[0]))
        for r in rows
    ])


@app.get("/transfers/{token}/download-zip")
def download_transfer_zip(token: str, password: str | None = Query(default=None)):
    rows = _download_file_rows(token, password)

    if len(rows) <= 1:
        raise HTTPException(status_code=400, detail="Zip download requires at least 2 files")

    zip_path = _build_transfer_zip(rows)
    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=f"{token}.zip",
        background=BackgroundTask(_cleanup_file, zip_path),
    )
