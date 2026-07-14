#!/usr/bin/env python3
"""Diagnostic : vérifie quelle classe de stockage OVH applique réellement.

Usage (en prod) :
    docker exec olftransfer-app python /app/scripts/check_storage_class.py

Teste 3 écritures dans le bucket (préfixe _diag/, nettoyées ensuite) :
  1. put_object SANS classe          -> classe par défaut de l'endpoint
  2. put_object AVEC EXPRESS_ONEZONE  -> High Performance attendu
  3. multipart AVEC EXPRESS_ONEZONE   -> chemin réel des fichiers >= 5 Mo
Puis relit la classe via head_object.
"""

import os
import sys

sys.path.insert(0, "/app")

from src.storage import _s3_client_kwargs, _infer_region_name  # noqa: E402

endpoint = os.environ["S3_ENDPOINT"]
bucket = os.environ["S3_BUCKET_NAME"]

print(f"S3_ENDPOINT = {endpoint}")
print(f"region      = {_infer_region_name(endpoint)}")
print(f"bucket      = {bucket}")
print("-" * 60)

import boto3  # noqa: E402

client = boto3.client("s3", **_s3_client_kwargs(endpoint))

BODY = b"x" * 16  # petit contenu, le but est la classe, pas la taille


def stored_class(key: str) -> str:
    head = client.head_object(Bucket=bucket, Key=key)
    return head.get("StorageClass", "STANDARD (implicite)")


def cleanup(key: str) -> None:
    try:
        client.delete_object(Bucket=bucket, Key=key)
    except Exception:
        pass


# 1. put_object sans classe
k1 = "_diag/default"
client.put_object(Bucket=bucket, Key=k1, Body=BODY)
print(f"1. put_object (défaut)              -> {stored_class(k1)}")
cleanup(k1)

# 2. put_object avec EXPRESS_ONEZONE
k2 = "_diag/express-put"
try:
    client.put_object(Bucket=bucket, Key=k2, Body=BODY, StorageClass="EXPRESS_ONEZONE")
    print(f"2. put_object EXPRESS_ONEZONE        -> {stored_class(k2)}")
except Exception as e:
    print(f"2. put_object EXPRESS_ONEZONE        -> ERREUR: {e}")
cleanup(k2)

# 3. multipart avec EXPRESS_ONEZONE (comme create_multipart_upload en prod)
k3 = "_diag/express-multipart"
try:
    up = client.create_multipart_upload(Bucket=bucket, Key=k3, StorageClass="EXPRESS_ONEZONE")
    upload_id = up["UploadId"]
    part = client.upload_part(Bucket=bucket, Key=k3, UploadId=upload_id, PartNumber=1, Body=BODY)
    client.complete_multipart_upload(
        Bucket=bucket, Key=k3, UploadId=upload_id,
        MultipartUpload={"Parts": [{"PartNumber": 1, "ETag": part["ETag"]}]},
    )
    print(f"3. multipart EXPRESS_ONEZONE         -> {stored_class(k3)}")
except Exception as e:
    print(f"3. multipart EXPRESS_ONEZONE         -> ERREUR: {e}")
cleanup(k3)

print("-" * 60)
print("Si 2/3 renvoient STANDARD -> l'endpoint/région n'honore pas EXPRESS_ONEZONE.")
print("Si 1 renvoie déjà High Perf -> tu es sur l'endpoint 'perf' (défaut High Perf).")
