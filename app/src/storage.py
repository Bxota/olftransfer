import os
import boto3
from botocore.config import Config

_client = None
_presign_client = None


def get_client():
    """Client interne — utilisé pour les opérations non-presignées (ex. delete)."""
    global _client
    if _client is None:
        _client = boto3.client(
            "s3",
            endpoint_url=os.environ["S3_ENDPOINT"],
            aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"],
            config=Config(signature_version="s3v4"),
        )
    return _client


def get_presign_client():
    """Client pour les presigned URLs — utilise l'endpoint public accessible par le navigateur."""
    global _presign_client
    if _presign_client is None:
        public_endpoint = os.environ.get("S3_PUBLIC_ENDPOINT", os.environ["S3_ENDPOINT"])
        _presign_client = boto3.client(
            "s3",
            endpoint_url=public_endpoint,
            aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"],
            config=Config(signature_version="s3v4"),
        )
    return _presign_client


def _bucket() -> str:
    return os.environ["S3_BUCKET_NAME"]


def presigned_upload_url(object_key: str, mime_type: str | None, expires: int = 900) -> str:
    params = {"Bucket": _bucket(), "Key": object_key}
    if mime_type:
        params["ContentType"] = mime_type
    return get_presign_client().generate_presigned_url("put_object", Params=params, ExpiresIn=expires)


def presigned_download_url(object_key: str, filename: str, expires: int = 3600) -> str:
    return get_presign_client().generate_presigned_url(
        "get_object",
        Params={
            "Bucket": _bucket(),
            "Key": object_key,
            "ResponseContentDisposition": f'attachment; filename="{filename}"',
        },
        ExpiresIn=expires,
    )


def delete_objects(object_keys: list[str]) -> None:
    if not object_keys:
        return
    # S3 delete_objects accepts max 1000 keys per call
    for i in range(0, len(object_keys), 1000):
        batch = object_keys[i:i + 1000]
        response = get_client().delete_objects(
            Bucket=_bucket(),
            Delete={"Objects": [{"Key": k} for k in batch]},
        )
        errors = response.get("Errors", [])
        if errors:
            details = ", ".join(f"{e['Key']}: {e['Code']} {e['Message']}" for e in errors)
            raise RuntimeError(f"S3 delete_objects partial failure: {details}")


def _logs_bucket() -> str | None:
    return os.environ.get("S3_LOGS_BUCKET")


def list_log_objects(prefix: str = "", max_keys: int = 200) -> list[dict]:
    bucket = _logs_bucket()
    if not bucket:
        return []
    paginator = get_client().get_paginator("list_objects_v2")
    objects = []
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix, PaginationConfig={"MaxItems": max_keys}):
        objects.extend(page.get("Contents", []))
    return objects


def get_log_content(key: str) -> str:
    bucket = _logs_bucket()
    if not bucket:
        raise RuntimeError("S3_LOGS_BUCKET non configuré")
    response = get_client().get_object(Bucket=bucket, Key=key)
    return response["Body"].read().decode("utf-8", errors="replace")
