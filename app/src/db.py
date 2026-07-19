import os
from contextlib import contextmanager
from pathlib import Path

from psycopg2.pool import ThreadedConnectionPool

_pool: ThreadedConnectionPool | None = None
DEFAULT_SCHEMA_PATH = Path("/app/schema.sql")


def get_pool() -> ThreadedConnectionPool:
    global _pool
    if _pool is None:
        _pool = ThreadedConnectionPool(1, 10, os.environ["DATABASE_URL"])
    return _pool


@contextmanager
def get_conn():
    pool = get_pool()
    conn = pool.getconn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        pool.putconn(conn)


def apply_schema() -> None:
    """Applique le schéma idempotent avant d'accepter du trafic."""
    schema_path = Path(os.environ.get("SCHEMA_PATH", DEFAULT_SCHEMA_PATH))
    if not schema_path.is_file():
        # Le fichier est toujours embarqué dans l'image. Ce fallback garde les
        # imports directs et anciens conteneurs de développement utilisables.
        return

    schema_sql = schema_path.read_text(encoding="utf-8")
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT pg_advisory_xact_lock(hashtext('olftransfer-schema'))")
        cur.execute(schema_sql)
