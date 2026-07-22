from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

# ── Shared ────────────────────────────────────────────────────────────────────

class OkResponse(BaseModel):
    ok: bool = True


# ── Auth ──────────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: str
    password: str


class MeResponse(BaseModel):
    email: str
    is_admin: bool
    storage_quota_bytes: int
    storage_used_bytes: int


class RegisterRequest(BaseModel):
    token: str = Field(description="Token d'invitation reçu par email")
    password: str = Field(min_length=8)


# ── Admin ─────────────────────────────────────────────────────────────────────

class InviteRequest(BaseModel):
    email: str


class InviteResponse(BaseModel):
    ok: bool
    invite_url: str
    smtp_error: str | None = None


class InviteValidateResponse(BaseModel):
    email: str


class UserListItem(BaseModel):
    id: str
    email: str
    is_admin: bool
    created_at: datetime
    storage_quota_bytes: int


class SetQuotaRequest(BaseModel):
    storage_quota_bytes: int = Field(ge=0, description="Quota de stockage en octets")


# ── Uploads ───────────────────────────────────────────────────────────────────

class PartUrlRequest(BaseModel):
    upload_id: str = Field(description="ID de l'upload multipart S3")
    part_number: int = Field(ge=1, description="Numéro de la partie (commence à 1)")


class PartUrlResponse(BaseModel):
    url: str


class PartUrlsRequest(BaseModel):
    upload_id: str = Field(description="ID de l'upload multipart S3")
    part_numbers: list[int] = Field(
        min_length=1, max_length=10000, description="Numéros des parties à signer"
    )


class PartUrlItem(BaseModel):
    part_number: int
    url: str


class PartUrlsResponse(BaseModel):
    urls: list[PartUrlItem]


class PartsListResponse(BaseModel):
    parts: list[int] = Field(description="Numéros des parties déjà uploadées")


class CompleteUploadRequest(BaseModel):
    upload_id: str = Field(description="ID de l'upload multipart S3")


class AbortUploadRequest(BaseModel):
    upload_id: str = Field(description="ID de l'upload multipart S3")


# ── Transfers ─────────────────────────────────────────────────────────────────

class FileIn(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    size_bytes: int = Field(ge=0)
    mime_type: str | None = None


class CreateTransferRequest(BaseModel):
    files: list[FileIn] = Field(min_length=1, max_length=1000)
    name: str | None = Field(default=None, max_length=100, description="Nom optionnel du transfert")
    expires_in_hours: int = Field(default=168, ge=1, description="Durée de validité en heures (défaut : 7 jours)")
    password: str | None = Field(default=None, description="Mot de passe optionnel pour protéger le transfert")
    max_downloads: int | None = Field(default=None, ge=1, description="Limite de téléchargements (None = illimité)")
    view_mode: Literal["auto", "gallery", "list"] = Field(
        default="auto",
        description="Présentation publique : automatique, galerie ou liste",
    )


class UploadUrl(BaseModel):
    file_id: str
    filename: str
    upload_url: str | None = Field(default=None, description="URL signée pour upload direct (fichiers sous le seuil multipart)")
    multipart_upload_id: str | None = Field(default=None, description="ID multipart S3 pour les fichiers volumineux")


class CreateTransferResponse(BaseModel):
    token: str
    share_url: str
    expires_at: datetime
    uploads: list[UploadUrl]


class AddFilesRequest(BaseModel):
    files: list[FileIn] = Field(min_length=1, max_length=1000)


class AddFilesResponse(BaseModel):
    uploads: list[UploadUrl]


class FileInfo(BaseModel):
    filename: str
    size_bytes: int
    mime_type: str | None


class TransferInfo(BaseModel):
    token: str
    name: str | None = None
    expires_at: datetime
    download_count: int
    max_downloads: int | None
    has_password: bool
    files: list[FileInfo]
    sender_username: str | None = None
    zip_download_available: bool = True
    view_mode: Literal["auto", "gallery", "list"] = "auto"


class DownloadUrl(BaseModel):
    filename: str
    size_bytes: int
    download_url: str
    thumbnail_url: str | None = None


class DownloadResponse(BaseModel):
    files: list[DownloadUrl]


class UserTransfer(BaseModel):
    token: str
    name: str | None = None
    share_url: str
    created_at: datetime
    expires_at: datetime
    is_expired: bool
    is_archived: bool = False
    is_restoring: bool = False
    download_count: int
    max_downloads: int | None
    has_password: bool
    files: list[FileInfo]
    view_mode: Literal["auto", "gallery", "list"] = "auto"


class RestoreTransferResponse(BaseModel):
    ok: bool = True
    status: str


class PatchTransferRequest(BaseModel):
    expires_in_hours: int | None = Field(default=None, ge=1)
    password: str | None = Field(default=None, description="None = inchangé, '' = supprimer, string = nouveau mot de passe")
    remove_password: bool = Field(default=False)
    max_downloads: int | None = Field(default=None, ge=1)
    remove_max_downloads: bool = Field(default=False)
    name: str | None = Field(default=None, max_length=100)
    view_mode: Literal["auto", "gallery", "list"] | None = None


class CreateFileRequestRequest(BaseModel):
    title: str = Field(max_length=200)
    message: str | None = Field(default=None)
    expires_in_hours: int = Field(default=168, ge=1)


class FileRequestInfo(BaseModel):
    token: str
    title: str
    message: str | None
    expires_at: datetime
    request_url: str


class FileRequestPublicInfo(BaseModel):
    title: str
    message: str | None
    expires_at: datetime
    requester_username: str
    request_url: str


class BatchDeleteRequest(BaseModel):
    tokens: list[str]


class BatchDeleteResponse(BaseModel):
    deleted: list[str]


class PendingFileInfo(BaseModel):
    file_id: str
    filename: str
    size_bytes: int


class PendingTransferInfo(BaseModel):
    token: str
    created_at: datetime
    files: list[PendingFileInfo]


class ResumeUploadInfo(BaseModel):
    file_id: str
    filename: str
    size_bytes: int
    multipart_upload_id: str | None = None
    upload_url: str | None = None
    completed_parts: list[int] = []


class ResumeTransferResponse(BaseModel):
    token: str
    share_url: str
    uploads: list[ResumeUploadInfo]
