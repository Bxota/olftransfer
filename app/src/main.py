import hashlib
import os
import secrets
import shutil
import tempfile
import zipfile
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
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
from .email import send_download_notification, send_invite
from .models import (
    AbortUploadRequest,
    BatchDeleteRequest,
    BatchDeleteResponse,
    CompleteUploadRequest,
    ConfirmTransferRequest,
    CreateTransferRequest,
    CreateTransferResponse,
    DownloadResponse,
    DownloadUrl,
    FileInfo,
    InviteRequest,
    InviteResponse,
    InviteValidateResponse,
    LoginRequest,
    MeResponse,
    OkResponse,
    PartUrlRequest,
    PartUrlResponse,
    PendingTransferInfo,
    RegisterRequest,
    ResumeTransferResponse,
    ResumeUploadInfo,
    SetQuotaRequest,
    SetTrustedRequest,
    TransferInfo,
    UploadUrl,
    UserListItem,
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
    list_upload_parts,
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


app = FastAPI(
    title="OlfTransfer",
    version="1.0.0",
    description="""
Service de partage de fichiers sécurisé avec liens temporaires et protection par mot de passe.

## Flux d'upload
1. **`POST /transfers`** — créer un transfert, obtenir les URLs d'upload presignées
2. Uploader les fichiers directement vers S3 via les URLs signées
3. **`POST /transfers/{token}/confirm`** — confirmer le transfert (déclenche l'analyse antivirus)

## Authentification
Les endpoints protégés nécessitent une session cookie valide (obtenue via `POST /auth/login`).
Les endpoints `/admin/*` sont réservés aux administrateurs.
""",
    openapi_tags=[
        {"name": "Auth", "description": "Authentification et gestion de session"},
        {"name": "Transfers", "description": "Création, consultation et suppression de transferts"},
        {"name": "Uploads", "description": "Upload multipart pour les fichiers volumineux"},
        {"name": "Admin", "description": "Administration — réservé aux administrateurs"},
        {"name": "System", "description": "Santé et maintenance du service"},
    ],
    lifespan=lifespan,
)

_cors_origins = [o.strip().rstrip("/") for o in os.environ.get("CORS_ALLOWED_ORIGINS", BASE_URL).split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_assets_dir = os.path.join(STATIC_DIR, "assets")
if os.path.isdir(_assets_dir):
    app.mount("/assets", StaticFiles(directory=_assets_dir), name="assets")

NO_STORE = {"Cache-Control": "no-store"}


def _spa_response():
    index_file = os.path.join(STATIC_DIR, "index.html")
    if os.path.isfile(index_file):
        return FileResponse(index_file, headers=NO_STORE)
    raise HTTPException(status_code=503, detail="Frontend not built")


def _download_file_rows(token: str, password: str | None):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT t.id, t.expires_at, t.password_hash, t.download_count, t.max_downloads, u.email
            FROM transfers t
            JOIN users u ON u.id = t.user_id
            WHERE t.token = %s AND t.confirmed_at IS NOT NULL
            """,
            (token,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transfer not found")

        transfer_id, expires_at, password_hash, download_count, max_downloads, sender_email = row

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

    return rows, sender_email


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


# ── Auth ──────────────────────────────────────────────────────────────────────

@app.post("/auth/login", tags=["Auth"], summary="Connexion", response_model=OkResponse)
def login(body: LoginRequest, response: Response):
    email = body.email.lower().strip()
    password = body.password

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
    return OkResponse()


@app.post("/auth/logout", tags=["Auth"], summary="Déconnexion", response_model=OkResponse)
def logout(response: Response):
    response.delete_cookie("session")
    return OkResponse()


@app.get("/auth/me", tags=["Auth"], summary="Profil de l'utilisateur connecté", response_model=MeResponse)
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
    return MeResponse(
        email=user["email"],
        is_admin=user["is_admin"],
        storage_quota_bytes=user["storage_quota_bytes"],
        storage_used_bytes=used_bytes,
    )


@app.post("/auth/register", tags=["Auth"], summary="Créer un compte via invitation", response_model=OkResponse)
def register(body: RegisterRequest, response: Response):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, email FROM invitations
            WHERE token = %s AND used_at IS NULL AND expires_at > NOW()
            """,
            (body.token,),
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
            (email, hash_password(body.password)),
        )
        user_id = cur.fetchone()[0]

        cur.execute("UPDATE invitations SET used_at = NOW() WHERE id = %s", (invite_id,))

    response.set_cookie(
        "session", create_session(str(user_id)),
        httponly=True, secure=True, samesite="lax",
        max_age=60 * 60 * 24 * 7,
    )
    return OkResponse()


# ── Admin ─────────────────────────────────────────────────────────────────────

@app.post("/admin/invite", tags=["Admin"], summary="Envoyer une invitation", response_model=InviteResponse, dependencies=[Depends(require_admin)])
def invite_user(body: InviteRequest, user: dict = Depends(require_admin)):
    email = body.email.lower().strip()
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
        return InviteResponse(ok=True, invite_url=invite_url, smtp_error=str(e))

    return InviteResponse(ok=True, invite_url=invite_url)


@app.get("/admin/invite/{token}", tags=["Admin"], summary="Valider un token d'invitation", response_model=InviteValidateResponse)
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
    return InviteValidateResponse(email=row[0])


@app.get("/admin/users", tags=["Admin"], summary="Lister les utilisateurs", response_model=list[UserListItem], dependencies=[Depends(require_admin)])
def list_users():
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, email, is_admin, is_trusted, created_at, storage_quota_bytes FROM users ORDER BY created_at")
        rows = cur.fetchall()
    return [UserListItem(id=str(r[0]), email=r[1], is_admin=r[2], is_trusted=r[3], created_at=r[4], storage_quota_bytes=r[5]) for r in rows]


@app.patch("/admin/users/{user_id}/quota", tags=["Admin"], summary="Modifier le quota de stockage", response_model=OkResponse, dependencies=[Depends(require_admin)])
def set_user_quota(user_id: str, body: SetQuotaRequest):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE users SET storage_quota_bytes = %s WHERE id = %s", (body.storage_quota_bytes, user_id))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Utilisateur introuvable")
    return OkResponse()


@app.patch("/admin/users/{user_id}/trusted", tags=["Admin"], summary="Modifier le statut de confiance", response_model=OkResponse, dependencies=[Depends(require_admin)])
def set_user_trusted(user_id: str, body: SetTrustedRequest):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE users SET is_trusted = %s WHERE id = %s", (body.is_trusted, user_id))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Utilisateur introuvable")
    return OkResponse()


@app.get("/admin/stats", tags=["Admin"], summary="Statistiques globales", dependencies=[Depends(require_admin)])
def admin_stats(refresh: bool = Query(default=False, description="Forcer le rafraîchissement du cache S3")):
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


@app.post("/admin/cleanup", tags=["Admin"], summary="Déclencher le nettoyage manuellement", response_model=OkResponse, dependencies=[Depends(require_admin)])
def trigger_cleanup():
    _do_cleanup()
    return OkResponse()


@app.get("/admin/logs", tags=["Admin"], summary="Lister les logs d'accès S3", dependencies=[Depends(require_admin)])
def list_access_logs(prefix: str = Query(default="", description="Filtrer par préfixe de clé S3")):
    objects = list_log_objects(prefix=prefix)
    return [
        {
            "key": o["Key"],
            "size": o["Size"],
            "last_modified": o["LastModified"].isoformat(),
        }
        for o in sorted(objects, key=lambda x: x["LastModified"], reverse=True)
    ]


@app.get("/admin/logs/content", tags=["Admin"], summary="Lire le contenu d'un log", dependencies=[Depends(require_admin)])
def get_access_log(key: str = Query(..., description="Clé S3 du fichier de log")):
    if not os.environ.get("S3_LOGS_BUCKET"):
        raise HTTPException(status_code=503, detail="S3_LOGS_BUCKET non configuré")
    try:
        return {"key": key, "content": get_log_content(key)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── System ────────────────────────────────────────────────────────────────────

@app.get("/health", tags=["System"], summary="État du service")
def health():
    return {"status": "ok"}


# ── Transfers ─────────────────────────────────────────────────────────────────

@app.post("/transfers", tags=["Transfers"], summary="Créer un transfert", response_model=CreateTransferResponse, status_code=201)
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
            mp_upload_id = create_multipart_upload(r2_key, f.mime_type) if f.size_bytes >= MULTIPART_THRESHOLD else None
            cur.execute(
                """
                INSERT INTO files (transfer_id, filename, size_bytes, mime_type, r2_key, multipart_upload_id)
                VALUES (%s, %s, %s, %s, %s, %s) RETURNING id
                """,
                (transfer_id, f.filename, f.size_bytes, f.mime_type, r2_key, mp_upload_id),
            )
            file_id = cur.fetchone()[0]
            if mp_upload_id:
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


@app.post("/transfers/{token}/confirm", tags=["Transfers"], summary="Confirmer un transfert (déclenche l'antivirus)")
def confirm_transfer(token: str, body: ConfirmTransferRequest, user: dict = Depends(get_current_user)):
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

    for r2_key, filename in files:
        try:
            data = download_object(r2_key)
            virus = scan_bytes(data)
        except Exception as e:
            write_log_event("scan_error", token, {"user_email": user["email"], "filename": filename, "error": str(e)})
            continue

        if virus:
            if not user["is_trusted"]:
                r2_keys = [f[0] for f in files]
                delete_objects(r2_keys)
                with get_conn() as conn:
                    cur = conn.cursor()
                    cur.execute("DELETE FROM transfers WHERE id = %s", (transfer_id,))
                write_log_event("scan_blocked", token, {"user_email": user["email"], "filename": filename, "virus": virus})
                raise HTTPException(status_code=400, detail=f"Fichier refusé : détection antivirus ({virus})")

            if not body.acknowledge_risk:
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


@app.get("/transfers", tags=["Transfers"], summary="Lister mes transferts", response_model=list[UserTransfer])
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


@app.delete("/transfers", tags=["Transfers"], summary="Supprimer plusieurs transferts", response_model=BatchDeleteResponse, status_code=200)
def batch_delete_transfers(payload: BatchDeleteRequest, request: Request, user: dict = Depends(get_current_user)):
    ip = request.headers.get("x-forwarded-for", request.client.host if request.client else None)
    deleted_tokens = []
    for token in payload.tokens:
        with get_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT id, files_purged_at FROM transfers WHERE token = %s AND user_id = %s AND confirmed_at IS NOT NULL",
                (token, user["id"]),
            )
            row = cur.fetchone()
            if not row:
                continue
            transfer_id, files_purged_at = row
            if not files_purged_at:
                cur.execute("SELECT r2_key FROM files WHERE transfer_id = %s", (transfer_id,))
                r2_keys = [r[0] for r in cur.fetchall()]
                delete_objects(r2_keys)
            cur.execute("DELETE FROM transfers WHERE id = %s", (transfer_id,))
        write_log_event("transfer_deleted", token, {
            "user_email": user["email"],
            "reason": "manual_batch",
            "ip": ip,
        })
        deleted_tokens.append(token)
    return BatchDeleteResponse(deleted=deleted_tokens)


@app.delete("/transfers/{token}", tags=["Transfers"], summary="Supprimer un transfert", status_code=204)
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


@app.get("/transfers/pending", tags=["Transfers"], summary="Transferts en attente de confirmation", response_model=list[PendingTransferInfo])
def list_pending_transfers(user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, token, created_at
            FROM transfers
            WHERE user_id = %s AND confirmed_at IS NULL AND expires_at > NOW()
            ORDER BY created_at DESC
            """,
            (user["id"],),
        )
        transfers = cur.fetchall()
        result = []
        for t_id, token, created_at in transfers:
            cur.execute(
                "SELECT id, filename, size_bytes FROM files WHERE transfer_id = %s",
                (t_id,),
            )
            files = [{"file_id": str(r[0]), "filename": r[1], "size_bytes": r[2]} for r in cur.fetchall()]
            if files:
                result.append({"token": token, "created_at": created_at, "files": files})
    return result


@app.get("/transfers/{token}/resume", tags=["Transfers"], summary="État d'un upload interrompu", response_model=ResumeTransferResponse)
def resume_transfer(token: str, user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id FROM transfers WHERE token = %s AND user_id = %s AND confirmed_at IS NULL AND expires_at > NOW()",
            (token, user["id"]),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transfer not found or already confirmed")
        transfer_id = row[0]

        cur.execute(
            "SELECT id, filename, size_bytes, mime_type, r2_key, multipart_upload_id FROM files WHERE transfer_id = %s",
            (transfer_id,),
        )
        file_rows = cur.fetchall()

    uploads = []
    for file_id, filename, size_bytes, mime_type, r2_key, mp_upload_id in file_rows:
        if mp_upload_id:
            try:
                completed_parts = list_upload_parts(r2_key, mp_upload_id)
            except Exception:
                # L'upload S3 a expiré — en créer un nouveau
                mp_upload_id = create_multipart_upload(r2_key, mime_type)
                with get_conn() as conn:
                    cur = conn.cursor()
                    cur.execute(
                        "UPDATE files SET multipart_upload_id = %s WHERE id = %s",
                        (mp_upload_id, file_id),
                    )
                completed_parts = []
            uploads.append(ResumeUploadInfo(
                file_id=str(file_id),
                filename=filename,
                size_bytes=size_bytes,
                multipart_upload_id=mp_upload_id,
                completed_parts=completed_parts,
            ))
        else:
            uploads.append(ResumeUploadInfo(
                file_id=str(file_id),
                filename=filename,
                size_bytes=size_bytes,
                upload_url=presigned_upload_url(r2_key, mime_type),
            ))

    return ResumeTransferResponse(
        token=token,
        share_url=f"{BASE_URL}/t/{token}",
        uploads=uploads,
    )


@app.get("/transfers/{token}", tags=["Transfers"], summary="Informations d'un transfert public", response_model=TransferInfo)
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


@app.get("/transfers/{token}/download", tags=["Transfers"], summary="Obtenir les URLs de téléchargement", response_model=DownloadResponse)
def download_transfer(token: str, request: Request, password: str | None = Query(default=None, description="Mot de passe si le transfert est protégé")):
    rows, sender_email = _download_file_rows(token, password)

    file_count = len(rows)
    total_bytes = sum(r[1] for r in rows)
    write_log_event("download", token, {
        "ip": request.headers.get("x-forwarded-for", request.client.host if request.client else None),
        "user_agent": request.headers.get("user-agent"),
        "file_count": file_count,
        "total_bytes": total_bytes,
    })

    background = BackgroundTask(send_download_notification, sender_email, token, file_count, total_bytes)
    return Response(
        content=DownloadResponse(files=[
            DownloadUrl(filename=r[0], size_bytes=r[1], download_url=presigned_download_url(r[2], r[0]))
            for r in rows
        ]).model_dump_json(),
        media_type="application/json",
        background=background,
    )


@app.get("/transfers/{token}/download-zip", tags=["Transfers"], summary="Télécharger tous les fichiers en ZIP")
def download_transfer_zip(token: str, password: str | None = Query(default=None, description="Mot de passe si le transfert est protégé")):
    rows, sender_email = _download_file_rows(token, password)

    if len(rows) <= 1:
        raise HTTPException(status_code=400, detail="Zip download requires at least 2 files")

    file_count = len(rows)
    total_bytes = sum(r[1] for r in rows)
    zip_path = _build_transfer_zip(rows)

    def _cleanup_and_notify(path: str):
        _cleanup_file(path)
        send_download_notification(sender_email, token, file_count, total_bytes)

    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=f"{token}.zip",
        background=BackgroundTask(_cleanup_and_notify, zip_path),
    )


# ── Uploads ───────────────────────────────────────────────────────────────────

@app.post("/uploads/{file_id}/part-url", tags=["Uploads"], summary="Obtenir l'URL presignée d'une partie multipart", response_model=PartUrlResponse)
def get_part_url(file_id: str, body: PartUrlRequest, user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT f.r2_key FROM files f JOIN transfers t ON f.transfer_id = t.id WHERE f.id = %s AND t.user_id = %s",
            (file_id, user["id"]),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404)
    return PartUrlResponse(url=presigned_upload_part(row[0], body.upload_id, body.part_number))


@app.post("/uploads/{file_id}/complete", tags=["Uploads"], summary="Finaliser un upload multipart", status_code=204)
def complete_upload(file_id: str, body: CompleteUploadRequest, user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT f.r2_key FROM files f JOIN transfers t ON f.transfer_id = t.id WHERE f.id = %s AND t.user_id = %s",
            (file_id, user["id"]),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404)
    complete_multipart_upload(row[0], body.upload_id)


@app.post("/uploads/{file_id}/abort", tags=["Uploads"], summary="Annuler un upload multipart", status_code=204)
def abort_upload(file_id: str, body: AbortUploadRequest, user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT f.r2_key FROM files f JOIN transfers t ON f.transfer_id = t.id WHERE f.id = %s AND t.user_id = %s",
            (file_id, user["id"]),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404)
    abort_multipart_upload(row[0], body.upload_id)


# ── SPA fallback (must be last) ───────────────────────────────────────────────

@app.get("/", include_in_schema=False)
@app.get("/{path:path}", include_in_schema=False)
def spa_fallback(path: str = ""):  # noqa: ARG001
    return _spa_response()
