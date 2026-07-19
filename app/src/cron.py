import logging

from apscheduler.schedulers.background import BackgroundScheduler

from .db import get_conn
from .storage import (
    abort_multipart_upload,
    archive_objects,
    check_restore_complete,
    copy_to_standard,
    delete_objects,
)

logger = logging.getLogger(__name__)
scheduler = BackgroundScheduler()


@scheduler.scheduled_job("interval", hours=1, id="cleanup_expired")
def cleanup_expired():
    try:
        _do_cleanup()
        _do_cleanup_abandoned()
    except Exception as exc:
        logger.warning("Cleanup skipped: %s", exc)


@scheduler.scheduled_job("interval", minutes=30, id="check_restoring")
def check_restoring():
    try:
        _do_check_restoring()
    except Exception as exc:
        logger.warning("Restore check skipped: %s", exc)


def _do_cleanup():
    with get_conn() as conn:
        cur = conn.cursor()

        # Transferts expirés non encore archivés → stockage froid.
        cur.execute(
            """
            SELECT t.id, f.storage_key
            FROM files f
            JOIN transfers t ON f.transfer_id = t.id
            WHERE t.expires_at < NOW()
              AND t.archived_at IS NULL
              AND t.files_purged_at IS NULL
              AND t.confirmed_at IS NOT NULL
              AND f.uploaded_at IS NOT NULL
            """
        )
        rows = cur.fetchall()
        transfer_ids = list({row[0] for row in rows})
        storage_keys = [row[1] for row in rows]

        logger.info("Cleanup: archiving %s S3 object(s) to cold storage", len(storage_keys))
        if storage_keys:
            archive_objects(storage_keys)

        if transfer_ids:
            cur.execute(
                "UPDATE transfers SET archived_at = NOW() WHERE id = ANY(%s::uuid[])",
                (transfer_ids,),
            )

        logger.info("Cleanup: archived %s transfer(s) to cold storage", len(transfer_ids))


def _do_cleanup_abandoned():
    """Supprime les objets et métadonnées des uploads jamais validés."""
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, storage_key, multipart_upload_id
            FROM files
            WHERE uploaded_at IS NULL
              AND (
                (multipart_upload_id IS NULL AND created_at < NOW() - INTERVAL '2 hours')
                OR
                (multipart_upload_id IS NOT NULL AND created_at < NOW() - INTERVAL '48 hours')
              )
            """
        )
        abandoned_files = cur.fetchall()

        for _file_id, storage_key, multipart_upload_id in abandoned_files:
            if multipart_upload_id:
                abort_multipart_upload(storage_key, multipart_upload_id)

        storage_keys = [row[1] for row in abandoned_files]
        if storage_keys:
            delete_objects(storage_keys)

        file_ids = [row[0] for row in abandoned_files]
        if file_ids:
            cur.execute("DELETE FROM files WHERE id = ANY(%s::uuid[])", (file_ids,))

        # Un transfert initial dont tous les fichiers ont été abandonnés n'a
        # plus de raison d'être. Les transferts déjà confirmés sont conservés.
        cur.execute(
            """
            DELETE FROM transfers t
            WHERE t.confirmed_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM files f WHERE f.transfer_id = t.id)
              AND t.created_at < NOW() - INTERVAL '2 hours'
            """
        )
        deleted_transfers = cur.rowcount

        if abandoned_files or deleted_transfers:
            logger.info(
                "Cleanup: deleted %s abandoned file(s) and %s empty transfer(s)",
                len(abandoned_files),
                deleted_transfers,
            )


def _do_check_restoring():
    """Replace en stockage standard les restaurations froides terminées."""
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT t.id, t.token, f.storage_key
            FROM files f
            JOIN transfers t ON f.transfer_id = t.id
            WHERE t.restore_requested_at IS NOT NULL
              AND t.archived_at IS NOT NULL
              AND t.confirmed_at IS NOT NULL
              AND f.uploaded_at IS NOT NULL
            """
        )
        rows = cur.fetchall()

        by_transfer: dict = {}
        for transfer_id, token, storage_key in rows:
            by_transfer.setdefault(transfer_id, {"token": token, "keys": []})["keys"].append(storage_key)

        for transfer_id, info in by_transfer.items():
            try:
                all_ready = all(check_restore_complete(key) for key in info["keys"])
            except Exception as exc:
                logger.warning("Restore check for %s: %s", info["token"], exc)
                continue

            if not all_ready:
                continue

            try:
                copy_to_standard(info["keys"])
            except Exception as exc:
                logger.warning("copy_to_standard for %s: %s", info["token"], exc)
                continue

            cur.execute(
                """
                UPDATE transfers
                SET archived_at = NULL,
                    restore_requested_at = NULL,
                    expires_at = NOW() + INTERVAL '7 days'
                WHERE id = %s
                """,
                (transfer_id,),
            )
            logger.info("Restore complete for %s", info["token"])
