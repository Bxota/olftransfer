import logging
from apscheduler.schedulers.background import BackgroundScheduler
from .db import get_conn
from .r2 import delete_objects

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
            SELECT f.r2_key
            FROM files f
            JOIN transfers t ON f.transfer_id = t.id
            WHERE t.expires_at < NOW() AND t.files_purged_at IS NULL
        """)
        r2_keys = [row[0] for row in cur.fetchall()]

        logger.info(f"Cleanup: found {len(r2_keys)} R2 object(s) to delete")

        if r2_keys:
            delete_objects(r2_keys)

        cur.execute("""
            UPDATE transfers SET files_purged_at = NOW()
            WHERE expires_at < NOW() AND files_purged_at IS NULL
        """)
        purged = cur.rowcount

        logger.info(f"Cleanup: purged {purged} expired transfer(s), {len(r2_keys)} R2 object(s)")
