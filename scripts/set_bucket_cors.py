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
base_url = os.environ["BASE_URL"]  # ex: https://olf-transfer.bxota.com

client.put_bucket_cors(
    Bucket=bucket,
    CORSConfiguration={
        "CORSRules": [
            {
                "AllowedHeaders": ["*"],
                "AllowedMethods": ["GET", "PUT"],
                "AllowedOrigins": [base_url],
                "MaxAgeSeconds": 3600,
            }
        ]
    },
)

print(f"CORS configured on bucket '{bucket}' for origin '{base_url}'")
