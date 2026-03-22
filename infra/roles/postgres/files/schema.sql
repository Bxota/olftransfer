CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS transfers (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token         VARCHAR(64) UNIQUE NOT NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMP NOT NULL,
    password_hash VARCHAR,
    download_count INT NOT NULL DEFAULT 0,
    max_downloads  INT
);

CREATE INDEX IF NOT EXISTS idx_transfers_token      ON transfers (token);
CREATE INDEX IF NOT EXISTS idx_transfers_expires_at ON transfers (expires_at);

CREATE TABLE IF NOT EXISTS files (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transfer_id UUID NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
    filename    VARCHAR NOT NULL,
    size_bytes  BIGINT NOT NULL,
    mime_type   VARCHAR,
    r2_key      VARCHAR NOT NULL
);
