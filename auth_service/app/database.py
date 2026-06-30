import os
from contextlib import contextmanager
from typing import Iterator

import psycopg2
from psycopg2.extras import RealDictCursor


def _env(name: str, default: str) -> str:
    value = os.getenv(name, default)
    return value.strip() if value else default


def database_url() -> str:
    configured = _env("DATABASE_URL", "")
    if configured:
        return configured

    host = _env("POSTGRES_HOST", "rediff_postgres")
    port = _env("POSTGRES_PORT", "5432")
    db = _env("POSTGRES_DB", "rediff_v1_db")
    user = _env("POSTGRES_USER", "rediff")
    password = _env("POSTGRES_PASSWORD", "")
    return f"postgresql://{user}:{password}@{host}:{port}/{db}"


@contextmanager
def connection() -> Iterator[psycopg2.extensions.connection]:
    conn = psycopg2.connect(database_url(), cursor_factory=RealDictCursor)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_group_schema() -> None:
    ddl = """
    CREATE TABLE IF NOT EXISTS rediff_groups (
        id BIGSERIAL PRIMARY KEY,
        tenant_slug TEXT NOT NULL,
        vhost TEXT NOT NULL,
        muc_jid TEXT NOT NULL UNIQUE,
        room_node TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_by_jid TEXT NOT NULL,
        owner_jid TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'tenant_private',
        membership_mode TEXT NOT NULL DEFAULT 'members_only',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (tenant_slug, vhost, room_node)
    );

    CREATE TABLE IF NOT EXISTS rediff_group_members (
        id BIGSERIAL PRIMARY KEY,
        group_id BIGINT NOT NULL REFERENCES rediff_groups(id) ON DELETE CASCADE,
        member_jid TEXT NOT NULL,
        tenant_slug TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        affiliation TEXT NOT NULL DEFAULT 'member',
        added_by_jid TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (group_id, member_jid)
    );

    CREATE INDEX IF NOT EXISTS i_rediff_groups_scope
        ON rediff_groups (tenant_slug, vhost, status);
    CREATE INDEX IF NOT EXISTS i_rediff_group_members_user
        ON rediff_group_members (tenant_slug, member_jid);
    """
    with connection() as conn:
        with conn.cursor() as cur:
            cur.execute(ddl)
