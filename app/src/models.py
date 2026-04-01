from pydantic import BaseModel
from datetime import datetime


class FileIn(BaseModel):
    filename: str
    size_bytes: int
    mime_type: str | None = None


class CreateTransferRequest(BaseModel):
    files: list[FileIn]
    expires_in_hours: int = 168  # 7 jours par défaut
    password: str | None = None
    max_downloads: int | None = None


class UploadUrl(BaseModel):
    file_id: str
    filename: str
    upload_url: str


class CreateTransferResponse(BaseModel):
    token: str
    share_url: str
    expires_at: datetime
    uploads: list[UploadUrl]


class FileInfo(BaseModel):
    filename: str
    size_bytes: int
    mime_type: str | None


class TransferInfo(BaseModel):
    token: str
    expires_at: datetime
    download_count: int
    max_downloads: int | None
    files: list[FileInfo]


class DownloadUrl(BaseModel):
    filename: str
    size_bytes: int
    download_url: str


class DownloadResponse(BaseModel):
    files: list[DownloadUrl]


class UserTransfer(BaseModel):
    token: str
    share_url: str
    created_at: datetime
    expires_at: datetime
    is_expired: bool
    download_count: int
    max_downloads: int | None
    has_password: bool
    files: list[FileInfo]
