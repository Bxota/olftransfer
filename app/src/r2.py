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
            endpoint_url=os.environ["R2_ENDPOINT"],
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            config=Config(signature_version="s3v4"),
        )
    return _client


def get_presign_client():
    """Client pour les presigned URLs — utilise l'endpoint public accessible par le navigateur."""
    global _presign_client
    if _presign_client is None:
        public_endpoint = os.environ.get("R2_PUBLIC_ENDPOINT", os.environ["R2_ENDPOINT"])
        _presign_client = boto3.client(
            "s3",
            endpoint_url=public_endpoint,
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            config=Config(signature_version="s3v4"),
        )
    return _presign_client


def _bucket() -> str:
    return os.environ["R2_BUCKET_NAME"]


def presigned_upload_url(r2_key: str, mime_type: str | None, expires: int = 900) -> str:
    params = {"Bucket": _bucket(), "Key": r2_key}
    if mime_type:
        params["ContentType"] = mime_type
    return get_presign_client().generate_presigned_url("put_object", Params=params, ExpiresIn=expires)


def presigned_download_url(r2_key: str, filename: str, expires: int = 3600) -> str:
    return get_presign_client().generate_presigned_url(
        "get_object",
        Params={
            "Bucket": _bucket(),
            "Key": r2_key,
            "ResponseContentDisposition": f'attachment; filename="{filename}"',
        },
        ExpiresIn=expires,
    )


def delete_objects(r2_keys: list[str]) -> None:
    if not r2_keys:
        return
    # R2/S3 delete_objects accepts max 1000 keys per call
    for i in range(0, len(r2_keys), 1000):
        batch = r2_keys[i:i + 1000]
        response = get_client().delete_objects(
            Bucket=_bucket(),
            Delete={"Objects": [{"Key": k} for k in batch]},
        )
        errors = response.get("Errors", [])
        if errors:
            details = ", ".join(f"{e['Key']}: {e['Code']} {e['Message']}" for e in errors)
            raise RuntimeError(f"R2 delete_objects partial failure: {details}")
