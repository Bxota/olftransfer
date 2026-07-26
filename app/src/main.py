import os
import secrets
import shutil
import tempfile
import zipfile
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from io import BytesIO

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.background import BackgroundTask

from .auth import (
    create_session,
    get_current_user,
    get_optional_user,
    hash_password,
    password_needs_rehash,
    require_admin,
    seed_admin,
    verify_password,
)
from .cron import _do_cleanup, _do_cleanup_abandoned, cleanup_expired, scheduler
from .db import apply_schema, get_conn
from .email import send_download_notification, send_invite
from .models import (
    AbortUploadRequest,
    AddFilesRequest,
    AddFilesResponse,
    BatchDeleteRequest,
    BatchDeleteResponse,
    CompleteUploadRequest,
    CreateFileRequestRequest,
    CreateTransferRequest,
    CreateTransferResponse,
    DownloadResponse,
    DownloadUrl,
    FileInfo,
    FileRequestInfo,
    FileRequestPublicInfo,
    InviteRequest,
    InviteResponse,
    InviteValidateResponse,
    LoginRequest,
    MeResponse,
    OkResponse,
    PartsListResponse,
    PartUrlItem,
    PartUrlRequest,
    PartUrlResponse,
    PartUrlsRequest,
    PartUrlsResponse,
    PatchTransferRequest,
    PendingTransferInfo,
    RegisterRequest,
    RestoreTransferResponse,
    ResumeTransferResponse,
    ResumeUploadInfo,
    SetQuotaRequest,
    TransferInfo,
    UploadUrl,
    UserListItem,
    UserTransfer,
)
from .oidc import (
    TRANSACTION_COOKIE,
    begin_authorization,
    complete_authorization,
    find_or_create_user,
)
from .storage import (
    MULTIPART_THRESHOLD,
    abort_multipart_upload,
    complete_multipart_upload,
    create_multipart_upload,
    delete_objects,
    download_object,
    get_bucket_stats,
    get_client,
    get_object_size,
    list_upload_parts,
    presigned_download_url,
    presigned_upload_part,
    presigned_upload_url,
    restore_objects,
)

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
BASE_URL = os.environ.get("BASE_URL", "https://olf-transfer.bxota.com")
MAX_ZIP_SIZE_BYTES = int(os.environ.get("MAX_ZIP_SIZE_BYTES", str(1024**3)))
THUMBNAIL_MAX_SIZE = (480, 480)
THUMBNAIL_TOKEN_MAX_AGE = 60 * 60


def _thumbnail_signer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(os.environ["APP_SECRET"], salt="transfer-thumbnail")


def _thumbnail_url(token: str, file_id: str) -> str:
    signature = _thumbnail_signer().dumps({"transfer": token, "file": file_id})
    return f"/transfers/{token}/thumbnails/{file_id}?signature={signature}"


def _fmt_bytes(n: int) -> str:
    for unit in ("o", "Ko", "Mo", "Go", "To"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "o" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} Po"


@asynccontextmanager
async def lifespan(app: FastAPI):
    apply_schema()
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
3. **`POST /transfers/{token}/confirm`** — vérifier les fichiers et confirmer le transfert

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


def _verify_and_upgrade_password(cur, transfer_id, password: str | None, password_hash: str | None) -> None:
    if not password_hash:
        return
    if not password:
        raise HTTPException(status_code=401, detail="Password required")
    if not verify_password(password, password_hash):
        raise HTTPException(status_code=403, detail="Wrong password")
    if password_needs_rehash(password_hash):
        cur.execute(
            "UPDATE transfers SET password_hash = %s WHERE id = %s",
            (hash_password(password), transfer_id),
        )


def _verify_pending_files(cur, transfer_id) -> None:
    cur.execute(
        """
        SELECT id, filename, size_bytes, storage_key
        FROM files
        WHERE transfer_id = %s AND uploaded_at IS NULL
        """,
        (transfer_id,),
    )
    pending_files = cur.fetchall()
    if not pending_files:
        return

    verified_ids = []
    for file_id, filename, expected_size, storage_key in pending_files:
        try:
            actual_size = get_object_size(storage_key)
        except Exception as exc:
            raise HTTPException(
                status_code=503,
                detail=f"Impossible de vérifier le fichier {filename} dans le stockage.",
            ) from exc
        if actual_size is None:
            raise HTTPException(status_code=409, detail=f"Upload incomplet : {filename} est absent du stockage.")
        if actual_size != expected_size:
            raise HTTPException(
                status_code=409,
                detail=f"Taille invalide pour {filename} ({actual_size} octets reçus, {expected_size} attendus).",
            )
        verified_ids.append(file_id)

    cur.execute(
        "UPDATE files SET uploaded_at = NOW() WHERE id = ANY(%s::uuid[])",
        (verified_ids,),
    )


def _download_file_rows(
    token: str,
    password: str | None,
    notify: bool = True,
    max_total_size: int | None = None,
    consume_download: bool = True,
):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT t.id, t.expires_at, t.password_hash, t.download_count, t.max_downloads, u.email, t.name, t.archived_at
            FROM transfers t
            JOIN users u ON u.id = t.user_id
            WHERE t.token = %s AND t.confirmed_at IS NOT NULL
            """,
            (token,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transfer not found")

        transfer_id, expires_at, password_hash, download_count, max_downloads, sender_email, transfer_name, archived_at = row

        if archived_at:
            raise HTTPException(status_code=410, detail="Transfer archived")

        if expires_at.replace(tzinfo=UTC) < datetime.now(UTC):
            raise HTTPException(status_code=410, detail="Transfer expired")

        if consume_download and max_downloads and download_count >= max_downloads:
            raise HTTPException(status_code=410, detail="Download limit reached")

        _verify_and_upgrade_password(cur, transfer_id, password, password_hash)

        cur.execute(
            """
            SELECT filename, size_bytes, storage_key, id FROM files
            WHERE transfer_id = %s AND uploaded_at IS NOT NULL
            ORDER BY created_at, id
            """,
            (transfer_id,),
        )
        rows = cur.fetchall()

        if max_total_size is not None and sum(row[1] for row in rows) > max_total_size:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"Le téléchargement ZIP est limité à {_fmt_bytes(max_total_size)}. "
                    "Téléchargez les fichiers séparément."
                ),
            )

        if consume_download:
            cur.execute(
                "UPDATE transfers SET download_count = download_count + 1 WHERE id = %s",
                (transfer_id,),
            )

        # Throttle : au plus une notification mail par transfert toutes les 5 minutes
        # (UPDATE atomique pour éviter les doublons entre requêtes concurrentes).
        should_notify = False
        if notify and consume_download:
            cur.execute(
                """
                UPDATE transfers SET last_notified_at = NOW()
                WHERE id = %s AND (last_notified_at IS NULL OR last_notified_at < NOW() - INTERVAL '5 minutes')
                RETURNING id
                """,
                (transfer_id,),
            )
            should_notify = cur.fetchone() is not None

    return rows, sender_email, transfer_name, should_notify


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

@app.get("/auth/oidc/login", tags=["Auth"], summary="Démarrer la connexion OpenID Connect")
def oidc_login(prompt: str = Query(default="")):
    if prompt not in ("", "login"):
        raise HTTPException(status_code=400, detail="Paramètre prompt non pris en charge")
    authorization_url, transaction = begin_authorization(prompt)
    response = RedirectResponse(authorization_url, status_code=302)
    response.set_cookie(
        TRANSACTION_COOKIE,
        transaction,
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=10 * 60,
        path="/",
    )
    return response


@app.get("/auth/oidc/callback", tags=["Auth"], summary="Terminer la connexion OpenID Connect")
def oidc_callback(
    request: Request,
    code: str = Query(default=""),
    state: str = Query(default=""),
    error: str = Query(default=""),
):
    if error:
        raise HTTPException(status_code=401, detail=f"Connexion refusée par le fournisseur d’identité ({error})")
    claims = complete_authorization(code, state, request.cookies.get(TRANSACTION_COOKIE))
    user_id = find_or_create_user(claims)
    response = RedirectResponse("/", status_code=303)
    response.delete_cookie(TRANSACTION_COOKIE, path="/", secure=True, httponly=True, samesite="lax")
    response.set_cookie(
        "session",
        create_session(user_id),
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 7,
    )
    return response


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

    if password_needs_rehash(row[1]):
        with get_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "UPDATE users SET password_hash = %s WHERE id = %s",
                (hash_password(password), row[0]),
            )

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
            WHERE t.user_id = %s AND t.confirmed_at IS NOT NULL
              AND t.files_purged_at IS NULL AND f.uploaded_at IS NOT NULL
            """,
            (user["id"],),
        )
        used_bytes = int(cur.fetchone()[0])
    return MeResponse(
        email=user["email"],
        pseudonym=user["pseudonym"],
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
    expires_at = datetime.now(UTC) + timedelta(hours=48)

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
        cur.execute("SELECT id, email, is_admin, created_at, storage_quota_bytes FROM users ORDER BY created_at")
        rows = cur.fetchall()
    return [UserListItem(id=str(r[0]), email=r[1], is_admin=r[2], created_at=r[3], storage_quota_bytes=r[4]) for r in rows]


@app.patch("/admin/users/{user_id}/quota", tags=["Admin"], summary="Modifier le quota de stockage", response_model=OkResponse, dependencies=[Depends(require_admin)])
def set_user_quota(user_id: str, body: SetQuotaRequest):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE users SET storage_quota_bytes = %s WHERE id = %s", (body.storage_quota_bytes, user_id))
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
              AND f.uploaded_at IS NOT NULL
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
                    AND t.confirmed_at IS NOT NULL AND f.uploaded_at IS NOT NULL) AS active_bytes,
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
    _do_cleanup_abandoned()
    return OkResponse()



# ── System ────────────────────────────────────────────────────────────────────

@app.get("/health", tags=["System"], summary="État du service")
def health():
    return {"status": "ok"}


# ── Transfers ─────────────────────────────────────────────────────────────────

@app.post("/transfers", tags=["Transfers"], summary="Créer un transfert", response_model=CreateTransferResponse, status_code=201)
def create_transfer(body: CreateTransferRequest, user: dict = Depends(get_current_user)):
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(UTC) + timedelta(hours=body.expires_in_hours)
    password_hash = hash_password(body.password) if body.password else None
    requested_bytes = sum(f.size_bytes for f in body.files)

    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT COALESCE(SUM(f.size_bytes), 0)
            FROM files f
            JOIN transfers t ON f.transfer_id = t.id
            WHERE t.user_id = %s AND t.files_purged_at IS NULL
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
            INSERT INTO transfers (user_id, token, expires_at, password_hash, max_downloads, name, view_mode)
            VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id
            """,
            (user["id"], token, expires_at, password_hash, body.max_downloads, body.name, body.view_mode),
        )
        transfer_id = cur.fetchone()[0]

        uploads = []
        for f in body.files:
            storage_key = f"{transfer_id}/{secrets.token_hex(8)}_{f.filename}"
            mp_upload_id = create_multipart_upload(storage_key, f.mime_type) if f.size_bytes >= MULTIPART_THRESHOLD else None
            cur.execute(
                """
                INSERT INTO files (transfer_id, filename, size_bytes, mime_type, storage_key, multipart_upload_id)
                VALUES (%s, %s, %s, %s, %s, %s) RETURNING id
                """,
                (transfer_id, f.filename, f.size_bytes, f.mime_type, storage_key, mp_upload_id),
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
                    upload_url=presigned_upload_url(storage_key, f.mime_type),
                ))

    return CreateTransferResponse(
        token=token,
        share_url=f"{BASE_URL}/t/{token}",
        expires_at=expires_at,
        uploads=uploads,
    )


@app.post("/transfers/{token}/files", tags=["Transfers"], summary="Ajouter des fichiers à un transfert non confirmé", response_model=AddFilesResponse)
def add_files_to_transfer(token: str, body: AddFilesRequest, user: dict = Depends(get_current_user)):
    requested_bytes = sum(f.size_bytes for f in body.files)

    with get_conn() as conn:
        cur = conn.cursor()
        # Confirmé ou non : on peut alimenter un transfert tant qu'il est vivant
        # (non expiré, non purgé, non archivé au froid).
        cur.execute(
            """
            SELECT id FROM transfers
            WHERE token = %s AND user_id = %s AND expires_at > NOW()
              AND files_purged_at IS NULL AND archived_at IS NULL
            """,
            (token, user["id"]),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transfert introuvable ou indisponible.")
        transfer_id = row[0]

        # Tous les fichiers actifs, confirmés ou en attente, réservent du quota.
        cur.execute(
            """
            SELECT COALESCE(SUM(f.size_bytes), 0)
            FROM files f
            JOIN transfers t ON f.transfer_id = t.id
            WHERE t.user_id = %s AND t.files_purged_at IS NULL
            """,
            (user["id"],),
        )
        used_bytes = int(cur.fetchone()[0])
        if used_bytes + requested_bytes > user["storage_quota_bytes"]:
            raise HTTPException(
                status_code=507,
                detail=f"Quota de stockage dépassé ({_fmt_bytes(used_bytes + requested_bytes)} / {_fmt_bytes(user['storage_quota_bytes'])})",
            )

        uploads = []
        for f in body.files:
            storage_key = f"{transfer_id}/{secrets.token_hex(8)}_{f.filename}"
            mp_upload_id = create_multipart_upload(storage_key, f.mime_type) if f.size_bytes >= MULTIPART_THRESHOLD else None
            cur.execute(
                """
                INSERT INTO files (transfer_id, filename, size_bytes, mime_type, storage_key, multipart_upload_id)
                VALUES (%s, %s, %s, %s, %s, %s) RETURNING id
                """,
                (transfer_id, f.filename, f.size_bytes, f.mime_type, storage_key, mp_upload_id),
            )
            file_id = cur.fetchone()[0]
            if mp_upload_id:
                uploads.append(UploadUrl(file_id=str(file_id), filename=f.filename, multipart_upload_id=mp_upload_id))
            else:
                uploads.append(UploadUrl(file_id=str(file_id), filename=f.filename, upload_url=presigned_upload_url(storage_key, f.mime_type)))

    return AddFilesResponse(uploads=uploads)


@app.post("/transfers/{token}/confirm", tags=["Transfers"], summary="Vérifier et confirmer un transfert")
def confirm_transfer(token: str, user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id FROM transfers WHERE token = %s AND user_id = %s",
            (token, user["id"]),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transfer not found")

        _verify_pending_files(cur, row[0])
        cur.execute(
            "UPDATE transfers SET confirmed_at = COALESCE(confirmed_at, NOW()) WHERE token = %s AND user_id = %s",
            (token, user["id"]),
        )
    return Response(status_code=204)


@app.get("/transfers", tags=["Transfers"], summary="Lister mes transferts", response_model=list[UserTransfer])
def list_my_transfers(user: dict = Depends(get_current_user)):
    now = datetime.now(UTC)
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, token, created_at, expires_at, download_count, max_downloads,
                   password_hash IS NOT NULL AS has_password, name,
                   archived_at, restore_requested_at, view_mode
            FROM transfers WHERE user_id = %s AND confirmed_at IS NOT NULL ORDER BY created_at DESC
            """,
            (user["id"],),
        )
        transfers = cur.fetchall()

        result = []
        for t in transfers:
            t_id, token, created_at, expires_at, dl_count, max_dl, has_pw, name, archived_at, restore_requested_at, view_mode = t
            cur.execute(
                """
                SELECT filename, size_bytes, mime_type FROM files
                WHERE transfer_id = %s AND uploaded_at IS NOT NULL
                ORDER BY created_at, id
                """,
                (t_id,),
            )
            files = [FileInfo(filename=r[0], size_bytes=r[1], mime_type=r[2]) for r in cur.fetchall()]
            expires_aware = expires_at.replace(tzinfo=UTC) if expires_at.tzinfo is None else expires_at
            result.append(UserTransfer(
                token=token,
                name=name,
                share_url=f"{BASE_URL}/t/{token}",
                created_at=created_at,
                expires_at=expires_at,
                is_expired=expires_aware < now,
                is_archived=bool(archived_at),
                is_restoring=bool(restore_requested_at),
                download_count=dl_count,
                max_downloads=max_dl,
                has_password=has_pw,
                files=files,
                view_mode=view_mode,
            ))
    return result


@app.delete("/transfers", tags=["Transfers"], summary="Supprimer plusieurs transferts", response_model=BatchDeleteResponse, status_code=200)
def batch_delete_transfers(payload: BatchDeleteRequest, user: dict = Depends(get_current_user)):
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
                # delete_objects fonctionne sur STANDARD et COLD_ARCHIVE
                cur.execute("SELECT storage_key FROM files WHERE transfer_id = %s", (transfer_id,))
                storage_keys = [r[0] for r in cur.fetchall()]
                delete_objects(storage_keys)
            cur.execute("DELETE FROM transfers WHERE id = %s", (transfer_id,))
        deleted_tokens.append(token)
    return BatchDeleteResponse(deleted=deleted_tokens)


@app.patch("/transfers/{token}", tags=["Transfers"], summary="Modifier un transfert", response_model=OkResponse)
def patch_transfer(token: str, body: PatchTransferRequest, user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id FROM transfers WHERE token = %s AND user_id = %s AND confirmed_at IS NOT NULL",
            (token, user["id"]),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transfer not found")
        transfer_id = row[0]

        fields, params = [], []
        if body.expires_in_hours is not None:
            fields.append("expires_at = NOW() + (%s || ' hours')::interval")
            params.append(str(body.expires_in_hours))
        if body.remove_password:
            fields.append("password_hash = NULL")
        elif body.password is not None and body.password != "":
            fields.append("password_hash = %s")
            params.append(hash_password(body.password))
        if body.remove_max_downloads:
            fields.append("max_downloads = NULL")
        elif body.max_downloads is not None:
            fields.append("max_downloads = %s")
            params.append(body.max_downloads)
        if body.name is not None:
            fields.append("name = %s")
            params.append(body.name or None)
        if body.view_mode is not None:
            fields.append("view_mode = %s")
            params.append(body.view_mode)

        if fields:
            params.append(transfer_id)
            cur.execute(f"UPDATE transfers SET {', '.join(fields)} WHERE id = %s", params)

    return OkResponse()


@app.post("/transfers/{token}/restore", tags=["Transfers"], summary="Restaurer un transfert depuis le stockage froid", response_model=RestoreTransferResponse)
def restore_transfer(token: str, user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, archived_at, restore_requested_at, expires_at, files_purged_at
            FROM transfers
            WHERE token = %s AND user_id = %s AND confirmed_at IS NOT NULL
            """,
            (token, user["id"]),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transfer not found")

        transfer_id, archived_at, restore_requested_at, expires_at, files_purged_at = row

        if not archived_at:
            # Expiré mais pas encore passé en stockage froid par le cron :
            # les fichiers sont toujours en STANDARD, il suffit de prolonger.
            if files_purged_at:
                raise HTTPException(status_code=410, detail="Fichiers supprimés, restauration impossible")
            if expires_at.replace(tzinfo=UTC) >= datetime.now(UTC):
                raise HTTPException(status_code=409, detail="Transfer n'est pas expiré")
            cur.execute(
                "UPDATE transfers SET expires_at = NOW() + INTERVAL '7 days' WHERE id = %s",
                (transfer_id,),
            )
            return RestoreTransferResponse(status="restored")

        if restore_requested_at:
            return RestoreTransferResponse(status="restoring")

        cur.execute(
            "SELECT storage_key FROM files WHERE transfer_id = %s AND uploaded_at IS NOT NULL",
            (transfer_id,),
        )
        storage_keys = [r[0] for r in cur.fetchall()]

        restore_objects(storage_keys)

        cur.execute(
            "UPDATE transfers SET restore_requested_at = NOW() WHERE id = %s",
            (transfer_id,),
        )

    return RestoreTransferResponse(status="restoring")


@app.delete("/transfers/{token}", tags=["Transfers"], summary="Supprimer un transfert", status_code=204)
def delete_transfer(token: str, user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, files_purged_at, archived_at FROM transfers WHERE token = %s AND user_id = %s AND confirmed_at IS NOT NULL",
            (token, user["id"]),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transfer not found")

        transfer_id, files_purged_at, archived_at = row

        if not files_purged_at:
            cur.execute("SELECT storage_key FROM files WHERE transfer_id = %s", (transfer_id,))
            storage_keys = [r[0] for r in cur.fetchall()]
            # delete_objects fonctionne quelle que soit la classe de stockage (STANDARD ou COLD_ARCHIVE)
            delete_objects(storage_keys)

        cur.execute("DELETE FROM transfers WHERE id = %s", (transfer_id,))



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
            "SELECT id, filename, size_bytes, mime_type, storage_key, multipart_upload_id FROM files WHERE transfer_id = %s",
            (transfer_id,),
        )
        file_rows = cur.fetchall()

    uploads = []
    for file_id, filename, size_bytes, mime_type, storage_key, mp_upload_id in file_rows:
        if mp_upload_id:
            try:
                completed_parts = list_upload_parts(storage_key, mp_upload_id)
            except Exception:
                # L'upload S3 a expiré — en créer un nouveau
                mp_upload_id = create_multipart_upload(storage_key, mime_type)
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
                upload_url=presigned_upload_url(storage_key, mime_type),
            ))

    return ResumeTransferResponse(
        token=token,
        share_url=f"{BASE_URL}/t/{token}",
        uploads=uploads,
    )


@app.get("/transfers/{token}", tags=["Transfers"], summary="Informations d'un transfert public", response_model=TransferInfo)
def get_transfer(token: str, password: str | None = Query(default=None)):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT t.id, t.expires_at, t.download_count, t.max_downloads, t.name, t.password_hash, u.email, t.view_mode
            FROM transfers t LEFT JOIN users u ON u.id = t.user_id
            WHERE t.token = %s AND t.confirmed_at IS NOT NULL
            """,
            (token,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transfer not found")

        transfer_id, expires_at, download_count, max_downloads, name, password_hash, sender_email, view_mode = row
        sender_username = sender_email.split("@")[0] if sender_email else None
        has_password = bool(password_hash)

        if expires_at.replace(tzinfo=UTC) < datetime.now(UTC):
            raise HTTPException(status_code=410, detail="Transfer expired")

        password_unlocked = False
        if has_password and password:
            _verify_and_upgrade_password(cur, transfer_id, password, password_hash)
            password_unlocked = True

        if not has_password or password_unlocked:
            cur.execute(
                """
                SELECT filename, size_bytes, mime_type FROM files
                WHERE transfer_id = %s AND uploaded_at IS NOT NULL
                ORDER BY created_at, id
                """,
                (transfer_id,),
            )
            files = [FileInfo(filename=r[0], size_bytes=r[1], mime_type=r[2]) for r in cur.fetchall()]
        else:
            files = []

    return TransferInfo(
        token=token,
        name=name,
        expires_at=expires_at,
        download_count=download_count,
        max_downloads=max_downloads,
        has_password=has_password,
        files=files,
        sender_username=sender_username,
        zip_download_available=sum(file.size_bytes for file in files) <= MAX_ZIP_SIZE_BYTES,
        view_mode=view_mode,
    )



@app.get("/transfers/{token}/download", tags=["Transfers"], summary="Obtenir les URLs de téléchargement", response_model=DownloadResponse)
def download_transfer(token: str, password: str | None = Query(default=None, description="Mot de passe si le transfert est protégé"), inline: bool = Query(default=False, description="Si True, renvoie des URLs inline (aperçu) au lieu de attachment"), downloader: dict | None = Depends(get_optional_user)):
    rows, sender_email, transfer_name, should_notify = _download_file_rows(
        token,
        password,
        notify=not inline,
        consume_download=not inline,
    )

    total_bytes = sum(r[1] for r in rows)
    filenames = [r[0] for r in rows]
    downloader_email = downloader["email"] if downloader else None
    background = BackgroundTask(send_download_notification, sender_email, token, transfer_name, filenames, total_bytes, downloader_email) if should_notify else None
    return Response(
        content=DownloadResponse(files=[
            DownloadUrl(filename=r[0], size_bytes=r[1], download_url=presigned_download_url(r[2], r[0], inline=inline))
            for r in rows
        ]).model_dump_json(),
        media_type="application/json",
        background=background,
    )


@app.get("/transfers/{token}/preview", tags=["Transfers"], summary="Obtenir les URLs d'aperçu", response_model=DownloadResponse)
def preview_transfer(
    token: str,
    password: str | None = Query(default=None, description="Mot de passe si le transfert est protégé"),
):
    rows, _, _, _ = _download_file_rows(
        token,
        password,
        notify=False,
        consume_download=False,
    )
    return DownloadResponse(files=[
        DownloadUrl(
            filename=row[0],
            size_bytes=row[1],
            download_url=presigned_download_url(row[2], row[0], inline=True),
            thumbnail_url=_thumbnail_url(token, str(row[3])) if _is_thumbnailable(row[0]) else None,
        )
        for row in rows
    ])


def _is_thumbnailable(filename: str) -> bool:
    return filename.lower().endswith((".jpg", ".jpeg", ".png", ".webp", ".avif", ".heic", ".heif", ".tif", ".tiff"))


@app.get("/transfers/{token}/thumbnails/{file_id}", tags=["Transfers"], summary="Obtenir une vignette de galerie")
def transfer_thumbnail(token: str, file_id: str, signature: str = Query(...)):
    try:
        payload = _thumbnail_signer().loads(signature, max_age=THUMBNAIL_TOKEN_MAX_AGE)
    except (BadSignature, SignatureExpired) as exc:
        raise HTTPException(status_code=403, detail="Vignette expirée") from exc
    if payload != {"transfer": token, "file": file_id}:
        raise HTTPException(status_code=403, detail="Vignette invalide")

    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT f.filename, f.storage_key
            FROM files f JOIN transfers t ON t.id = f.transfer_id
            WHERE f.id = %s AND t.token = %s AND t.confirmed_at IS NOT NULL
              AND f.uploaded_at IS NOT NULL AND t.expires_at > NOW()
              AND t.archived_at IS NULL
            """,
            (file_id, token),
        )
        row = cur.fetchone()
    if not row or not _is_thumbnailable(row[0]):
        raise HTTPException(status_code=404, detail="Vignette introuvable")

    try:
        # La vignette ne conserve ni les métadonnées EXIF ni la résolution originale.
        with Image.open(BytesIO(download_object(row[1]))) as image:
            image = ImageOps.exif_transpose(image)
            image.thumbnail(THUMBNAIL_MAX_SIZE, Image.Resampling.LANCZOS)
            if image.mode not in ("RGB", "RGBA"):
                image = image.convert("RGBA" if "transparency" in image.info else "RGB")
            output = BytesIO()
            image.save(output, format="WEBP", quality=75, method=4)
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError) as exc:
        raise HTTPException(status_code=415, detail="Format image non pris en charge") from exc

    return Response(
        content=output.getvalue(),
        media_type="image/webp",
        headers={"Cache-Control": "private, max-age=3600"},
    )


@app.get("/transfers/{token}/download-zip", tags=["Transfers"], summary="Télécharger tous les fichiers en ZIP")
def download_transfer_zip(token: str, password: str | None = Query(default=None, description="Mot de passe si le transfert est protégé"), downloader: dict | None = Depends(get_optional_user)):
    rows, sender_email, transfer_name, should_notify = _download_file_rows(
        token,
        password,
        max_total_size=MAX_ZIP_SIZE_BYTES,
    )

    if len(rows) <= 1:
        raise HTTPException(status_code=400, detail="Zip download requires at least 2 files")

    total_bytes = sum(r[1] for r in rows)
    filenames = [r[0] for r in rows]
    downloader_email = downloader["email"] if downloader else None
    zip_path = _build_transfer_zip(rows)

    def _cleanup_and_notify(path: str):
        _cleanup_file(path)
        if should_notify:
            send_download_notification(sender_email, token, transfer_name, filenames, total_bytes, downloader_email)

    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=f"{transfer_name}.zip" if transfer_name else f"{token}.zip",
        background=BackgroundTask(_cleanup_and_notify, zip_path),
    )


# ── Uploads ───────────────────────────────────────────────────────────────────

def _authed_file_key(file_id: str, user: dict) -> str:
    """storage_key d'un fichier appartenant à l'utilisateur connecté (sinon 404)."""
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT f.storage_key FROM files f
            JOIN transfers t ON f.transfer_id = t.id
            WHERE f.id = %s AND t.user_id = %s AND f.uploaded_at IS NULL
            """,
            (file_id, user["id"]),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404)
    return row[0]


def _request_file_key(req_token: str, transfer_token: str, file_id: str) -> str:
    """storage_key d'un fichier d'un dépôt anonyme, autorisé par la possession
    des deux tokens (demande + transfert), sur un transfert non confirmé et non expiré."""
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT f.storage_key FROM files f
            JOIN transfers t ON f.transfer_id = t.id
            WHERE f.id = %s AND t.token = %s AND t.file_request_token = %s
              AND t.confirmed_at IS NULL AND t.expires_at > NOW()
            """,
            (file_id, transfer_token, req_token),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404)
    return row[0]


def _part_urls(storage_key: str, upload_id: str, part_numbers: list[int]) -> PartUrlsResponse:
    return PartUrlsResponse(
        urls=[
            PartUrlItem(part_number=n, url=presigned_upload_part(storage_key, upload_id, n))
            for n in part_numbers
        ]
    )


@app.post("/uploads/{file_id}/part-url", tags=["Uploads"], summary="Obtenir l'URL presignée d'une partie multipart", response_model=PartUrlResponse)
def get_part_url(file_id: str, body: PartUrlRequest, user: dict = Depends(get_current_user)):
    storage_key = _authed_file_key(file_id, user)
    return PartUrlResponse(url=presigned_upload_part(storage_key, body.upload_id, body.part_number))


@app.post("/uploads/{file_id}/part-urls", tags=["Uploads"], summary="Obtenir les URLs presignées de plusieurs parties (batch)", response_model=PartUrlsResponse)
def get_part_urls(file_id: str, body: PartUrlsRequest, user: dict = Depends(get_current_user)):
    storage_key = _authed_file_key(file_id, user)
    return _part_urls(storage_key, body.upload_id, body.part_numbers)


@app.get("/uploads/{file_id}/parts", tags=["Uploads"], summary="Lister les parties déjà uploadées (reprise)", response_model=PartsListResponse)
def get_uploaded_parts(file_id: str, upload_id: str = Query(...), user: dict = Depends(get_current_user)):
    storage_key = _authed_file_key(file_id, user)
    return PartsListResponse(parts=list_upload_parts(storage_key, upload_id))


@app.post("/uploads/{file_id}/complete", tags=["Uploads"], summary="Finaliser un upload multipart", status_code=204)
def complete_upload(file_id: str, body: CompleteUploadRequest, user: dict = Depends(get_current_user)):
    storage_key = _authed_file_key(file_id, user)
    complete_multipart_upload(storage_key, body.upload_id)


@app.post("/uploads/{file_id}/abort", tags=["Uploads"], summary="Annuler un upload multipart", status_code=204)
def abort_upload(file_id: str, body: AbortUploadRequest, user: dict = Depends(get_current_user)):
    storage_key = _authed_file_key(file_id, user)
    abort_multipart_upload(storage_key, body.upload_id)


# ── File Requests (reverse transfer) ─────────────────────────────────────────

@app.post("/requests", tags=["Requests"], summary="Créer une demande de fichiers", response_model=FileRequestInfo, status_code=201)
def create_file_request(body: CreateFileRequestRequest, user: dict = Depends(get_current_user)):
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(UTC) + timedelta(hours=body.expires_in_hours)
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO file_requests (user_id, token, title, message, expires_at) VALUES (%s, %s, %s, %s, %s)",
            (user["id"], token, body.title, body.message, expires_at),
        )
    return FileRequestInfo(
        token=token,
        title=body.title,
        message=body.message,
        expires_at=expires_at,
        request_url=f"{BASE_URL}/r/{token}",
    )


@app.get("/requests", tags=["Requests"], summary="Lister mes demandes de fichiers", response_model=list[FileRequestInfo])
def list_file_requests(user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT token, title, message, expires_at FROM file_requests WHERE user_id = %s ORDER BY created_at DESC",
            (user["id"],),
        )
        rows = cur.fetchall()
    return [FileRequestInfo(token=r[0], title=r[1], message=r[2], expires_at=r[3], request_url=f"{BASE_URL}/r/{r[0]}") for r in rows]


@app.get("/requests/{req_token}", tags=["Requests"], summary="Infos publiques d'une demande", response_model=FileRequestPublicInfo)
def get_file_request(req_token: str):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT fr.title, fr.message, fr.expires_at, u.email
            FROM file_requests fr JOIN users u ON u.id = fr.user_id
            WHERE fr.token = %s AND fr.expires_at > NOW()
            """,
            (req_token,),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Demande introuvable ou expirée.")
    title, message, expires_at, email = row
    return FileRequestPublicInfo(
        title=title,
        message=message,
        expires_at=expires_at,
        requester_username=email.split("@")[0],
        request_url=f"{BASE_URL}/r/{req_token}",
    )


@app.delete("/requests/{req_token}", tags=["Requests"], summary="Supprimer une demande", status_code=204)
def delete_file_request(req_token: str, user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM file_requests WHERE token = %s AND user_id = %s", (req_token, user["id"]))


@app.post("/requests/{req_token}/transfers", tags=["Requests"], summary="Créer un transfert via une demande", response_model=CreateTransferResponse, status_code=201)
def create_transfer_for_request(req_token: str, body: CreateTransferRequest):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, user_id FROM file_requests WHERE token = %s AND expires_at > NOW()",
            (req_token,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Demande introuvable ou expirée.")
        _request_id, owner_user_id = row

        cur.execute("SELECT storage_quota_bytes FROM users WHERE id = %s", (owner_user_id,))
        quota_row = cur.fetchone()
        owner_quota = quota_row[0] if quota_row else 10737418240

        cur.execute(
            """
            SELECT COALESCE(SUM(f.size_bytes), 0) FROM files f
            JOIN transfers t ON f.transfer_id = t.id
            WHERE t.user_id = %s AND t.files_purged_at IS NULL
            """,
            (owner_user_id,),
        )
        used_bytes = int(cur.fetchone()[0])
        requested_bytes = sum(f.size_bytes for f in body.files)
        if used_bytes + requested_bytes > owner_quota:
            raise HTTPException(status_code=507, detail="L'espace de stockage du destinataire est plein.")

        token = secrets.token_urlsafe(32)
        expires_at = datetime.now(UTC) + timedelta(hours=168)

        cur.execute(
            """
            INSERT INTO transfers (user_id, token, expires_at, file_request_token)
            VALUES (%s, %s, %s, %s) RETURNING id
            """,
            (owner_user_id, token, expires_at, req_token),
        )
        transfer_id = cur.fetchone()[0]

        uploads = []
        for f in body.files:
            storage_key = f"{transfer_id}/{secrets.token_hex(8)}_{f.filename}"
            mp_upload_id = create_multipart_upload(storage_key, f.mime_type) if f.size_bytes >= MULTIPART_THRESHOLD else None
            cur.execute(
                """
                INSERT INTO files (transfer_id, filename, size_bytes, mime_type, storage_key, multipart_upload_id)
                VALUES (%s, %s, %s, %s, %s, %s) RETURNING id
                """,
                (transfer_id, f.filename, f.size_bytes, f.mime_type, storage_key, mp_upload_id),
            )
            file_id = cur.fetchone()[0]
            if mp_upload_id:
                uploads.append(UploadUrl(file_id=str(file_id), filename=f.filename, multipart_upload_id=mp_upload_id))
            else:
                uploads.append(UploadUrl(file_id=str(file_id), filename=f.filename, upload_url=presigned_upload_url(storage_key, f.mime_type)))

    return CreateTransferResponse(token=token, share_url=f"{BASE_URL}/t/{token}", expires_at=expires_at, uploads=uploads)


@app.post("/requests/{req_token}/transfers/{transfer_token}/confirm", tags=["Requests"], summary="Confirmer un dépôt via demande")
def confirm_transfer_for_request(req_token: str, transfer_token: str):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id FROM transfers WHERE token = %s AND file_request_token = %s",
            (transfer_token, req_token),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transfert introuvable.")
        _verify_pending_files(cur, row[0])
        cur.execute(
            "UPDATE transfers SET confirmed_at = COALESCE(confirmed_at, NOW()) WHERE id = %s",
            (row[0],),
        )
    return {"ok": True}


# ── Uploads multipart pour dépôts anonymes (autorisés par req_token + transfer_token) ──

@app.post("/requests/{req_token}/transfers/{transfer_token}/uploads/{file_id}/part-urls", tags=["Requests"], summary="URLs presignées de parties (dépôt anonyme)", response_model=PartUrlsResponse)
def get_part_urls_for_request(req_token: str, transfer_token: str, file_id: str, body: PartUrlsRequest):
    storage_key = _request_file_key(req_token, transfer_token, file_id)
    return _part_urls(storage_key, body.upload_id, body.part_numbers)


@app.get("/requests/{req_token}/transfers/{transfer_token}/uploads/{file_id}/parts", tags=["Requests"], summary="Parties déjà uploadées (dépôt anonyme)", response_model=PartsListResponse)
def get_uploaded_parts_for_request(req_token: str, transfer_token: str, file_id: str, upload_id: str = Query(...)):
    storage_key = _request_file_key(req_token, transfer_token, file_id)
    return PartsListResponse(parts=list_upload_parts(storage_key, upload_id))


@app.post("/requests/{req_token}/transfers/{transfer_token}/uploads/{file_id}/complete", tags=["Requests"], summary="Finaliser un upload multipart (dépôt anonyme)", status_code=204)
def complete_upload_for_request(req_token: str, transfer_token: str, file_id: str, body: CompleteUploadRequest):
    storage_key = _request_file_key(req_token, transfer_token, file_id)
    complete_multipart_upload(storage_key, body.upload_id)


# ── SPA fallback (must be last) ───────────────────────────────────────────────

@app.get("/", include_in_schema=False)
@app.get("/{path:path}", include_in_schema=False)
def spa_fallback(path: str = ""):  # noqa: ARG001
    return _spa_response()
