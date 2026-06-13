CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         VARCHAR UNIQUE NOT NULL,
    password_hash VARCHAR NOT NULL,
    is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invitations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token      VARCHAR(64) UNIQUE NOT NULL,
    email      VARCHAR NOT NULL,
    invited_by UUID REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL,
    used_at    TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transfers (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID REFERENCES users(id),
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
    storage_key      VARCHAR NOT NULL
);

-- Migration : ajouter user_id si la table transfers existe déjà sans cette colonne
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'transfers' AND column_name = 'user_id'
    ) THEN
        ALTER TABLE transfers ADD COLUMN user_id UUID REFERENCES users(id);
    END IF;
END $$;

-- Migration : ajouter files_purged_at pour conserver l'historique après expiration
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'transfers' AND column_name = 'files_purged_at'
    ) THEN
        ALTER TABLE transfers ADD COLUMN files_purged_at TIMESTAMP;
    END IF;
END $$;

-- Migration : is_trusted pour les utilisateurs pouvant bypass l'antivirus avec acknowledgment
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'is_trusted'
    ) THEN
        ALTER TABLE users ADD COLUMN is_trusted BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
END $$;

-- Migration : confirmed_at NULL = upload en cours ou échoué, non visible
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'transfers' AND column_name = 'confirmed_at'
    ) THEN
        ALTER TABLE transfers ADD COLUMN confirmed_at TIMESTAMP;
        -- Les transferts existants sont considérés comme confirmés
        UPDATE transfers SET confirmed_at = created_at WHERE confirmed_at IS NULL;
    END IF;
END $$;

-- Migration : quota de stockage par utilisateur (défaut 10 Go)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'storage_quota_bytes'
    ) THEN
        ALTER TABLE users ADD COLUMN storage_quota_bytes BIGINT NOT NULL DEFAULT 10737418240;
    END IF;
END $$;

-- Migration : storage_key pour les fichiers existants sans cette colonne
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'files' AND column_name = 'storage_key'
    ) THEN
        ALTER TABLE files ADD COLUMN storage_key VARCHAR NOT NULL DEFAULT '';
    END IF;
END $$;

-- Migration : r2_key renommé en storage_key — relâcher la contrainte NOT NULL sur l'ancien nom
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'files' AND column_name = 'r2_key'
    ) THEN
        ALTER TABLE files ALTER COLUMN r2_key DROP NOT NULL;
    END IF;
END $$;

-- Migration : multipart_upload_id pour la reprise des uploads interrompus
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'files' AND column_name = 'multipart_upload_id'
    ) THEN
        ALTER TABLE files ADD COLUMN multipart_upload_id VARCHAR;
    END IF;
END $$;

-- Migration : nom optionnel du transfert
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'transfers' AND column_name = 'name'
    ) THEN
        ALTER TABLE transfers ADD COLUMN name VARCHAR(100);
    END IF;
END $$;

-- Demandes de fichiers (reverse transfer)
CREATE TABLE IF NOT EXISTS file_requests (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       VARCHAR(64) UNIQUE NOT NULL,
    title       VARCHAR(200) NOT NULL,
    message     TEXT,
    expires_at  TIMESTAMP NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_file_requests_token ON file_requests (token);

-- Lien entre file_request et le transfert créé par le déposant
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'transfers' AND column_name = 'file_request_token'
    ) THEN
        ALTER TABLE transfers ADD COLUMN file_request_token VARCHAR(64) REFERENCES file_requests(token);
    END IF;
END $$;

-- Stockage froid : archived_at = fichiers déplacés en COLD_ARCHIVE, restore_requested_at = restauration demandée
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'transfers' AND column_name = 'archived_at'
    ) THEN
        ALTER TABLE transfers ADD COLUMN archived_at TIMESTAMP;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'transfers' AND column_name = 'restore_requested_at'
    ) THEN
        ALTER TABLE transfers ADD COLUMN restore_requested_at TIMESTAMP;
    END IF;
END $$;
