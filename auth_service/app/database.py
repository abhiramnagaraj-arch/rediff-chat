import os
from contextlib import contextmanager
from typing import Iterator
from urllib.parse import urlsplit, urlunsplit

import psycopg2
from psycopg2.extras import RealDictCursor


def _env(name: str, default: str) -> str:
    value = os.getenv(name, default)
    return value.strip() if value else default


def database_url(database_name: str | None = None) -> str:
    configured = _env("DATABASE_URL", "")
    if configured:
        if not database_name:
            return configured
        parts = urlsplit(configured)
        path = f"/{database_name.lstrip('/')}"
        return urlunsplit((parts.scheme, parts.netloc, path, parts.query, parts.fragment))

    db = database_name or _env("POSTGRES_DB", "rediff_v1_db")
    host = _env("POSTGRES_HOST", "rediff_postgres")
    port = _env("POSTGRES_PORT", "5432")
    user = _env("POSTGRES_USER", "rediff")
    password = _env("POSTGRES_PASSWORD", "")
    return f"postgresql://{user}:{password}@{host}:{port}/{db}"


@contextmanager
def connection(database_name: str | None = None) -> Iterator[psycopg2.extensions.connection]:
    conn = psycopg2.connect(database_url(database_name), cursor_factory=RealDictCursor)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def archive_database_name_for_vhost(vhost: str) -> str:
    first_label = str(vhost or "").strip().split(".", 1)[0].lower()
    if not first_label:
        raise ValueError("vhost must not be empty")
    return f"rediff_{first_label}_db"


def _execute_ddl(ddl: str, database_name: str | None = None) -> None:
    with connection(database_name=database_name) as conn:
        with conn.cursor() as cur:
            cur.execute(ddl)


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
    _execute_ddl(ddl)


def init_archive_schema(database_name: str | None = None) -> None:
    ddl = """
    CREATE TABLE IF NOT EXISTS archive (
        username text NOT NULL,
        timestamp BIGINT NOT NULL,
        peer text NOT NULL,
        bare_peer text NOT NULL,
        xml text NOT NULL,
        txt text,
        id BIGSERIAL,
        kind text,
        nick text,
        origin_id text,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS i_username_timestamp ON archive USING btree (username, timestamp);
    CREATE INDEX IF NOT EXISTS i_username_peer ON archive USING btree (username, peer);
    CREATE INDEX IF NOT EXISTS i_username_bare_peer ON archive USING btree (username, bare_peer);
    CREATE INDEX IF NOT EXISTS i_timestamp ON archive USING btree (timestamp);
    CREATE INDEX IF NOT EXISTS i_archive_username_origin_id ON archive USING btree (username, origin_id);
    """
    _execute_ddl(ddl, database_name=database_name)
