import os
import re
import time
from urllib.parse import urlparse

import boto3
from botocore.config import Config

_client = None
_presign_client = None


def _endpoint_hostname(endpoint_url: str) -> str:
    # Normalize: strip trailing slashes before parsing
    endpoint_url = endpoint_url.rstrip("/")
    parsed = urlparse(endpoint_url)
    if parsed.hostname:
        return parsed.hostname

    parsed = urlparse(f"//{endpoint_url}")
    return parsed.hostname or ""


def _infer_region_name(endpoint_url: str) -> str:
    explicit_region = os.environ.get("S3_REGION_NAME")
    if explicit_region:
        return explicit_region

    host = _endpoint_hostname(endpoint_url)

    if host.endswith("r2.cloudflarestorage.com"):
        return "auto"

    match = re.match(r"^s3\.([a-z0-9-]+)\.io\.cloud\.ovh\.net$", host)
    if match:
        region = match.group(1)
        import sys

        print(
            f"DEBUG storage.py: OVH region inferred from {host} -> {region}",
            file=sys.stderr,
        )
        return region

    import sys

    print(
        f"DEBUG storage.py: falling back to us-east-1 for host {host}", file=sys.stderr
    )
    return "us-east-1"


def _s3_client_kwargs(endpoint_url: str) -> dict:
    # Normalize: strip trailing slashes
    endpoint_url = endpoint_url.rstrip("/")
    region = _infer_region_name(endpoint_url)
    addressing_style = os.environ.get("S3_ADDRESSING_STYLE", "path")

    import sys

    print(
        f"DEBUG: S3 client config: endpoint={endpoint_url}, region={region}, style={addressing_style}",
        file=sys.stderr,
    )

    return {
        "endpoint_url": endpoint_url,
        "region_name": region,
        "aws_access_key_id": os.environ["S3_ACCESS_KEY_ID"],
        "aws_secret_access_key": os.environ["S3_SECRET_ACCESS_KEY"],
        "config": Config(
            signature_version="s3v4",
            s3={"addressing_style": addressing_style},
        ),
    }


def get_client():
    """Client interne — utilisé pour les opérations non-presignées (ex. delete)."""
    global _client
    if _client is None:
        _client = boto3.client("s3", **_s3_client_kwargs(os.environ["S3_ENDPOINT"]))
    return _client


def get_presign_client():
    """Client pour les presigned URLs — utilise l'endpoint public accessible par le navigateur."""
    global _presign_client
    if _presign_client is None:
        public_endpoint = os.environ.get(
            "S3_PUBLIC_ENDPOINT", os.environ["S3_ENDPOINT"]
        )
        _presign_client = boto3.client("s3", **_s3_client_kwargs(public_endpoint))
    return _presign_client


def _bucket() -> str:
    return os.environ["S3_BUCKET_NAME"]


def presigned_upload_url(
    object_key: str, mime_type: str | None, expires: int = 900
) -> str:
    params = {"Bucket": _bucket(), "Key": object_key}
    if mime_type:
        params["ContentType"] = mime_type
    return get_presign_client().generate_presigned_url(
        "put_object", Params=params, ExpiresIn=expires
    )


def presigned_download_url(object_key: str, filename: str, expires: int = 3600, inline: bool = False) -> str:
    disposition = f'inline; filename="{filename}"' if inline else f'attachment; filename="{filename}"'
    return get_presign_client().generate_presigned_url(
        "get_object",
        Params={
            "Bucket": _bucket(),
            "Key": object_key,
            "ResponseContentDisposition": disposition,
        },
        ExpiresIn=expires,
    )


MULTIPART_THRESHOLD = 5 * 1024 * 1024  # 5 MB
CHUNK_SIZE = 100 * 1024 * 1024  # 100 MB par partie


def create_multipart_upload(object_key: str, mime_type: str | None) -> str:
    params = {"Bucket": _bucket(), "Key": object_key}
    if mime_type:
        params["ContentType"] = mime_type
    return get_client().create_multipart_upload(**params)["UploadId"]


def presigned_upload_part(
    object_key: str, upload_id: str, part_number: int, expires: int = 3600
) -> str:
    return get_presign_client().generate_presigned_url(
        "upload_part",
        Params={
            "Bucket": _bucket(),
            "Key": object_key,
            "UploadId": upload_id,
            "PartNumber": part_number,
        },
        ExpiresIn=expires,
    )


def complete_multipart_upload(object_key: str, upload_id: str) -> None:
    client = get_client()
    parts = []
    paginator = client.get_paginator("list_parts")
    for page in paginator.paginate(
        Bucket=_bucket(), Key=object_key, UploadId=upload_id
    ):
        for part in page.get("Parts", []):
            parts.append({"PartNumber": part["PartNumber"], "ETag": part["ETag"]})
    parts.sort(key=lambda p: p["PartNumber"])
    client.complete_multipart_upload(
        Bucket=_bucket(),
        Key=object_key,
        UploadId=upload_id,
        MultipartUpload={"Parts": parts},
    )


def abort_multipart_upload(object_key: str, upload_id: str) -> None:
    try:
        get_client().abort_multipart_upload(
            Bucket=_bucket(), Key=object_key, UploadId=upload_id
        )
    except Exception:
        pass


def list_upload_parts(object_key: str, upload_id: str) -> list[int]:
    parts = []
    paginator = get_client().get_paginator("list_parts")
    for page in paginator.paginate(Bucket=_bucket(), Key=object_key, UploadId=upload_id):
        parts.extend(p["PartNumber"] for p in page.get("Parts", []))
    return parts


def download_object(object_key: str) -> bytes:
    response = get_client().get_object(Bucket=_bucket(), Key=object_key)
    return response["Body"].read()


def archive_objects(object_keys: list[str]) -> None:
    """Déplace les objets vers la classe COLD_ARCHIVE (OVH / S3 Glacier)."""
    client = get_client()
    bucket = _bucket()
    for key in object_keys:
        client.copy_object(
            Bucket=bucket,
            Key=key,
            CopySource={"Bucket": bucket, "Key": key},
            StorageClass="COLD_ARCHIVE",
            MetadataDirective="COPY",
        )


def restore_objects(object_keys: list[str], days: int = 7) -> None:
    """Lance la restauration depuis COLD_ARCHIVE vers le stockage chaud."""
    client = get_client()
    bucket = _bucket()
    for key in object_keys:
        try:
            client.restore_object(
                Bucket=bucket,
                Key=key,
                RestoreRequest={"Days": days},
            )
        except client.exceptions.RestoreAlreadyInProgress:
            pass


def check_restore_complete(object_key: str) -> bool:
    """Retourne True si la restauration de l'objet est terminée."""
    client = get_client()
    head = client.head_object(Bucket=_bucket(), Key=object_key)
    restore = head.get("Restore", "")
    # ongoing-request="false" signifie que la restauration est disponible
    return 'ongoing-request="false"' in restore


def copy_to_standard(object_keys: list[str]) -> None:
    """Recopie les objets restaurés en classe STANDARD (retour du froid)."""
    client = get_client()
    bucket = _bucket()
    for key in object_keys:
        client.copy_object(
            Bucket=bucket,
            Key=key,
            CopySource={"Bucket": bucket, "Key": key},
            StorageClass="STANDARD",
            MetadataDirective="COPY",
        )


def delete_objects(object_keys: list[str]) -> None:
    if not object_keys:
        return
    # S3 delete_objects accepts max 1000 keys per call
    for i in range(0, len(object_keys), 1000):
        batch = object_keys[i : i + 1000]
        response = get_client().delete_objects(
            Bucket=_bucket(),
            Delete={"Objects": [{"Key": k} for k in batch]},
        )
        errors = response.get("Errors", [])
        if errors:
            details = ", ".join(
                f"{e['Key']}: {e['Code']} {e['Message']}" for e in errors
            )
            raise RuntimeError(f"S3 delete_objects partial failure: {details}")



_bucket_stats_cache: dict | None = None
_bucket_stats_ts: float = 0.0
_CACHE_TTL = 300  # 5 minutes


def get_bucket_stats(force_refresh: bool = False) -> dict:
    global _bucket_stats_cache, _bucket_stats_ts
    now = time.monotonic()
    if (
        not force_refresh
        and _bucket_stats_cache is not None
        and now - _bucket_stats_ts < _CACHE_TTL
    ):
        return {**_bucket_stats_cache, "from_cache": True}

    total_bytes = 0
    object_count = 0
    last_modified = None

    paginator = get_client().get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=_bucket()):
        for obj in page.get("Contents", []):
            total_bytes += obj["Size"]
            object_count += 1
            lm = obj["LastModified"]
            if last_modified is None or lm > last_modified:
                last_modified = lm

    _bucket_stats_cache = {
        "total_bytes": total_bytes,
        "object_count": object_count,
        "last_upload": last_modified.isoformat() if last_modified else None,
    }
    _bucket_stats_ts = now
    return {**_bucket_stats_cache, "from_cache": False}


