#!/usr/bin/env python3
"""Run once to configure CORS on the S3 bucket."""

import os

import boto3
from botocore.config import Config

client = boto3.client(
    "s3",
    endpoint_url=os.environ["S3_ENDPOINT"],
    aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"],
    config=Config(signature_version="s3v4"),
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
