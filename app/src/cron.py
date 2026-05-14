import logging
from apscheduler.schedulers.background import BackgroundScheduler
from .db import get_conn
from .storage import abort_multipart_upload, delete_objects, write_log_event

logger = logging.getLogger(__name__)
scheduler = BackgroundScheduler()


@scheduler.scheduled_job("interval", hours=1, id="cleanup_expired")
def cleanup_expired():
    try:
        _do_cleanup()
    except Exception as e:
        logger.warning(f"Cleanup skipped: {e}")


def _do_cleanup():
    with get_conn() as conn:
        cur = conn.cursor()

        cur.execute("""
            SELECT t.token, f.r2_key
            FROM files f
            JOIN transfers t ON f.transfer_id = t.id
            WHERE t.expires_at < NOW() AND t.files_purged_at IS NULL AND t.confirmed_at IS NOT NULL
        """)
        rows = cur.fetchall()
        r2_keys = [row[1] for row in rows]
        expired_tokens = list({row[0] for row in rows})

        logger.info(f"Cleanup: found {len(r2_keys)} S3 object(s) to delete")

        if r2_keys:
            delete_objects(r2_keys)

        cur.execute("""
            UPDATE transfers SET files_purged_at = NOW()
            WHERE expires_at < NOW() AND files_purged_at IS NULL AND confirmed_at IS NOT NULL
        """)
        purged = cur.rowcount

        for token in expired_tokens:
            write_log_event("transfer_deleted", token, {"reason": "expired"})

        logger.info(
            f"Cleanup: purged {purged} expired transfer(s), {len(r2_keys)} S3 object(s)"
        )

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
            DELETE FROM transfers
            WHERE confirmed_at IS NULL AND created_at < NOW() - INTERVAL '2 hours'
            AND NOT EXISTS (
                SELECT 1 FROM files f
                WHERE f.transfer_id = transfers.id AND f.multipart_upload_id IS NOT NULL
            )
        """)
        abandoned_small = cur.rowcount

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
