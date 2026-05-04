#!/usr/bin/env python3
"""Run once to configure CORS on the S3 bucket."""

import os
import sys

# Add /app to path so we can import src module
sys.path.insert(0, "/app")

import boto3

from src.storage import _s3_client_kwargs

# Debug: affiche les variables disponibles
print(
    f"DEBUG: S3_ENDPOINT = {os.environ.get('S3_ENDPOINT', 'NOT SET')}", file=sys.stderr
)
print(
    f"DEBUG: S3_REGION_NAME = {os.environ.get('S3_REGION_NAME', 'NOT SET')}",
    file=sys.stderr,
)
print(
    f"DEBUG: S3_ACCESS_KEY_ID = {'***' if os.environ.get('S3_ACCESS_KEY_ID') else 'NOT SET'}",
    file=sys.stderr,
)
print(
    f"DEBUG: S3_SECRET_ACCESS_KEY = {'***' if os.environ.get('S3_SECRET_ACCESS_KEY') else 'NOT SET'}",
    file=sys.stderr,
)
print(
    f"DEBUG: S3_BUCKET_NAME = {os.environ.get('S3_BUCKET_NAME', 'NOT SET')}",
    file=sys.stderr,
)
print(f"DEBUG: BASE_URL = {os.environ.get('BASE_URL', 'NOT SET')}", file=sys.stderr)
print(
    f"DEBUG: CORS_ALLOWED_ORIGINS = {os.environ.get('CORS_ALLOWED_ORIGINS', 'NOT SET')}",
    file=sys.stderr,
)

client = boto3.client(
    "s3",
    **_s3_client_kwargs(os.environ["S3_ENDPOINT"]),
)

bucket = os.environ["S3_BUCKET_NAME"]

# Test: Try head_bucket to validate credentials before CORS
print(f"DEBUG: Testing bucket access with head_bucket...", file=sys.stderr)
try:
    client.head_bucket(Bucket=bucket)
    print(f"DEBUG: ✓ Bucket access successful", file=sys.stderr)
except Exception as e:
    print(f"DEBUG: ✗ Bucket access failed: {e}", file=sys.stderr)
    raise

raw_origins = os.environ.get("CORS_ALLOWED_ORIGINS", os.environ.get("BASE_URL", ""))
allowed_origins = [
    origin.strip().rstrip("/") for origin in raw_origins.split(",") if origin.strip()
]

if not allowed_origins:
    raise RuntimeError("BASE_URL ou CORS_ALLOWED_ORIGINS doit être configuré")

client.put_bucket_cors(
    Bucket=bucket,
    CORSConfiguration={
        "CORSRules": [
            {
                "AllowedHeaders": ["*"],
                "AllowedMethods": ["GET", "HEAD", "PUT"],
                "AllowedOrigins": allowed_origins,
                "MaxAgeSeconds": 3600,
            }
        ]
    },
)

print(f"CORS configured on bucket '{bucket}' for origins: {', '.join(allowed_origins)}")
