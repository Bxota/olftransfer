import logging
from apscheduler.schedulers.background import BackgroundScheduler
from .db import get_conn
from .storage import (
    abort_multipart_upload, archive_objects, check_restore_complete,
    copy_to_standard, delete_objects, write_log_event,
)

logger = logging.getLogger(__name__)
scheduler = BackgroundScheduler()


@scheduler.scheduled_job("interval", hours=1, id="cleanup_expired")
def cleanup_expired():
    try:
        _do_cleanup()
    except Exception as e:
        logger.warning(f"Cleanup skipped: {e}")


@scheduler.scheduled_job("interval", minutes=30, id="check_restoring")
def check_restoring():
    try:
        _do_check_restoring()
    except Exception as e:
        logger.warning(f"Restore check skipped: {e}")


def _do_cleanup():
    with get_conn() as conn:
        cur = conn.cursor()

        # Transfers expirés non encore archivés → déplacer en COLD_ARCHIVE
        cur.execute("""
            SELECT t.id, t.token, f.r2_key
            FROM files f
            JOIN transfers t ON f.transfer_id = t.id
            WHERE t.expires_at < NOW()
              AND t.archived_at IS NULL
              AND t.files_purged_at IS NULL
              AND t.confirmed_at IS NOT NULL
        """)
        rows = cur.fetchall()
        transfer_ids = list({row[0] for row in rows})
        r2_keys = [row[2] for row in rows]
        expired_tokens = list({row[1] for row in rows})

        logger.info(f"Cleanup: archiving {len(r2_keys)} S3 object(s) to cold storage")

        if r2_keys:
            try:
                archive_objects(r2_keys)
            except Exception as e:
                logger.warning(f"Cold archive failed: {e}")
                return

        if transfer_ids:
            cur.execute(
                f"UPDATE transfers SET archived_at = NOW() WHERE id = ANY(%s::uuid[])",
                (transfer_ids,),
            )
        archived = cur.rowcount

        for token in expired_tokens:
            write_log_event("transfer_archived", token, {"reason": "expired"})

        logger.info(f"Cleanup: archived {archived} transfer(s) to cold storage")

def _do_check_restoring():
    """Vérifie si les restaurations COLD_ARCHIVE sont terminées et remet les fichiers en STANDARD."""
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT t.id, t.token, f.r2_key
            FROM files f
            JOIN transfers t ON f.transfer_id = t.id
            WHERE t.restore_requested_at IS NOT NULL
              AND t.archived_at IS NOT NULL
              AND t.confirmed_at IS NOT NULL
        """)
        rows = cur.fetchall()
        if not rows:
            return

        by_transfer: dict = {}
        for t_id, token, key in rows:
            by_transfer.setdefault(t_id, {"token": token, "keys": []})["keys"].append(key)

        for t_id, info in by_transfer.items():
            try:
                all_ready = all(check_restore_complete(k) for k in info["keys"])
            except Exception as e:
                logger.warning(f"Restore check for {info['token']}: {e}")
                continue

            if all_ready:
                try:
                    copy_to_standard(info["keys"])
                except Exception as e:
                    logger.warning(f"copy_to_standard for {info['token']}: {e}")
                    continue
                cur.execute(
                    """
                    UPDATE transfers
                    SET archived_at = NULL,
                        restore_requested_at = NULL,
                        expires_at = NOW() + INTERVAL '7 days'
                    WHERE id = %s
                    """,
                    (t_id,),
                )
                write_log_event("transfer_restored", info["token"], {})
                logger.info(f"Restore complete for {info['token']}")


        # Aborter les uploads multipart orphelins (transfers abandonnés depuis 48h)
        cur.execute("""
            SELECT f.r2_key, f.multipart_upload_id
            FROM files f
            JOIN transfers t ON f.transfer_id = t.id
            WHERE t.confirmed_at IS NULL
              AND f.multipart_upload_id IS NOT NULL
              AND t.created_at < NOW() - INTERVAL '48 hours'
        """)
        for r2_key, mp_id in cur.fetchall():
            abort_multipart_upload(r2_key, mp_id)

        # Supprimer les transfers non confirmés :
        # - sans fichiers multipart : après 2h (upload petit fichier échoué)
        # - avec fichiers multipart : après 48h (fenêtre de reprise)
        cur.execute("""
            SELECT f.r2_key
            FROM files f
            JOIN transfers t ON f.transfer_id = t.id
            WHERE t.confirmed_at IS NULL AND t.created_at < NOW() - INTERVAL '2 hours'
            AND NOT EXISTS (
                SELECT 1 FROM files f2
                WHERE f2.transfer_id = t.id AND f2.multipart_upload_id IS NOT NULL
            )
        """)
        small_keys = [row[0] for row in cur.fetchall()]
        if small_keys:
            delete_objects(small_keys)

        cur.execute("""
            DELETE FROM transfers
            WHERE confirmed_at IS NULL AND created_at < NOW() - INTERVAL '2 hours'
            AND NOT EXISTS (
                SELECT 1 FROM files f
                WHERE f.transfer_id = transfers.id AND f.multipart_upload_id IS NOT NULL
            )
        """)
        abandoned_small = cur.rowcount

        cur.execute("""
            SELECT f.r2_key
            FROM files f
            JOIN transfers t ON f.transfer_id = t.id
            WHERE t.confirmed_at IS NULL AND t.created_at < NOW() - INTERVAL '48 hours'
        """)
        large_keys = [row[0] for row in cur.fetchall()]
        if large_keys:
            delete_objects(large_keys)

        cur.execute("""
            DELETE FROM transfers
            WHERE confirmed_at IS NULL AND created_at < NOW() - INTERVAL '48 hours'
        """)
        abandoned_large = cur.rowcount

        abandoned = abandoned_small + abandoned_large
        if abandoned:
            logger.info(
                f"Cleanup: deleted {abandoned} abandoned (unconfirmed) transfer(s)"
            )
