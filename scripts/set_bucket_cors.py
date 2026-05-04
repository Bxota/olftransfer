#!/usr/bin/env python3
"""Run once to configure CORS on the S3 bucket."""

import os
import re
from urllib.parse import urlparse

import boto3
from botocore.config import Config


def _infer_region_name(endpoint_url: str) -> str:
    explicit_region = os.environ.get("S3_REGION_NAME")
    if explicit_region:
        return explicit_region

    host = urlparse(endpoint_url).hostname or ""
    match = re.match(r"^s3\.([a-z0-9-]+)\.io\.cloud\.ovh\.net$", host)
    if match:
        return match.group(1)

    return "us-east-1"


def _s3_client_kwargs(endpoint_url: str) -> dict:
    return {
        "endpoint_url": endpoint_url,
        "region_name": _infer_region_name(endpoint_url),
        "aws_access_key_id": os.environ["S3_ACCESS_KEY_ID"],
        "aws_secret_access_key": os.environ["S3_SECRET_ACCESS_KEY"],
        "config": Config(
            signature_version="s3v4",
            s3={"addressing_style": os.environ.get("S3_ADDRESSING_STYLE", "path")},
        ),
    }


client = boto3.client(
    "s3",
    **_s3_client_kwargs(os.environ["S3_ENDPOINT"]),
)

bucket = os.environ["S3_BUCKET_NAME"]
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
