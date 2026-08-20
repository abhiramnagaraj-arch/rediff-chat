import re
from datetime import datetime, timezone
from typing import Any

from . import database, schemas


def bare_jid(jid: str) -> str:
    return str(jid or "").split("/", 1)[0].strip().lower()


def _to_epoch_ms(value: datetime) -> int:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return int(value.timestamp() * 1000)


def _normalize_snippet(value: str, max_length: int = 180) -> str:
    compact = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", value or "")).strip()
    if len(compact) <= max_length:
        return compact
    return compact[: max_length - 1].rstrip() + "…"


def _timestamp_to_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    if value is None:
        return datetime.fromtimestamp(0, tz=timezone.utc)

    try:
        raw = int(value)
    except (TypeError, ValueError, OverflowError):
        return datetime.fromtimestamp(0, tz=timezone.utc)

    if raw > 10**14:
        seconds = raw / 1_000_000
    elif raw > 10**11:
        seconds = raw / 1_000
    else:
        seconds = raw

    try:
        return datetime.fromtimestamp(seconds, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return datetime.fromtimestamp(0, tz=timezone.utc)


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _conversation_name(row: dict[str, Any]) -> str:
    name = row.get("conversation_name") or row.get("group_name") or row.get("bare_peer") or row.get("peer") or "Conversation"
    return str(name)


def _conversation_type(row: dict[str, Any]) -> str:
    kind = str(row.get("conversation_type") or row.get("kind") or "").lower()
    return "groupchat" if kind == "groupchat" else "chat"


def _conversation_name_from_jid(conversation_jid: str) -> str:
    jid = bare_jid(conversation_jid)
    if not jid:
        return "Conversation"
    if "@conference." in jid:
        return jid.split("@", 1)[0]
    if "@" in jid:
        return jid.split("@", 1)[0]
    return jid


def _load_group_index(*, tenant_slug: str, vhost: str, current_jid: str) -> dict[str, str]:
    try:
        with database.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT g.muc_jid, g.name
                    FROM rediff_groups g
                    JOIN rediff_group_members m ON m.group_id = g.id
                    WHERE g.tenant_slug = %s
                      AND g.vhost = %s
                      AND g.status = 'active'
                      AND m.member_jid = %s
                    """,
                    (tenant_slug, vhost, current_jid),
                )
                rows = cur.fetchall()
    except Exception:
        return {}

    result: dict[str, str] = {}
    for row in rows:
        try:
            muc_jid = bare_jid(str(row["muc_jid"]))
        except Exception:
            continue
        if muc_jid:
            result[muc_jid] = str(row.get("name") or "").strip()
    return result


def _room_matches_query(room_name: str, room_jid: str, terms: list[str]) -> bool:
    haystack = f"{room_name} {room_jid}".lower()
    return bool(terms) and all(term in haystack for term in terms)


def _build_peer_clause(target_jids: list[str]) -> tuple[str, list[str]]:
    if not target_jids:
        return "", []

    placeholders = ", ".join(["%s"] * len(target_jids))
    clause = f"lower(a.bare_peer) IN ({placeholders}) OR lower(a.peer) IN ({placeholders})"
    return clause, [*target_jids, *target_jids]


def _build_owner_clause(owner_jids: list[str]) -> tuple[str, list[str]]:
    if not owner_jids:
        return "", []

    placeholders = ", ".join(["%s"] * len(owner_jids))
    clause = f"  AND lower(a.username) IN ({placeholders})"
    return clause, owner_jids


def _row_to_result(row: dict[str, Any]) -> schemas.MessageSearchResult:
    timestamp = _timestamp_to_datetime(row.get("timestamp"))
    return schemas.MessageSearchResult(
        jid=str(row.get("conversation_jid") or row.get("bare_peer") or row.get("peer") or ""),
        name=_conversation_name(row),
        type=_conversation_type(row),
        snippet=_normalize_snippet(str(row.get("txt") or row.get("xml") or "")),
        timestamp=timestamp,
        archive_id=_safe_int(row.get("archive_id") or row.get("id") or 0),
        origin_id=row.get("origin_id"),
        peer=str(row.get("peer") or ""),
        bare_peer=str(row.get("bare_peer") or ""),
        kind=row.get("kind"),
    )


def search_messages(
    *,
    current_jid: str,
    tenant_slug: str,
    vhost: str,
    q: str,
    with_jid: str | None = None,
    start: datetime | None = None,
    end: datetime | None = None,
    limit: int = 20,
) -> list[schemas.MessageSearchResult]:
    query = re.sub(r"\s+", " ", q or "").strip()
    if len(query) < 2:
        return []

    terms = [term for term in re.split(r"\s+", query.lower()) if term]
    terms = terms[:6]
    current_jid = bare_jid(current_jid)
    username_aliases = [current_jid]
    if "@" in current_jid:
        localpart = current_jid.split("@", 1)[0]
        if localpart and localpart not in username_aliases:
            username_aliases.append(localpart)
    target_jid = bare_jid(with_jid) if with_jid else ""
    group_index = _load_group_index(tenant_slug=tenant_slug, vhost=vhost, current_jid=current_jid)

    target_jids: list[str] = []
    matched_room_terms: set[str] = set()
    if target_jid:
        target_jids.append(target_jid)
    if terms:
        for term in terms:
            for room_jid, room_name in group_index.items():
                if _room_matches_query(room_name, room_jid, [term]):
                    matched_room_terms.add(term)
                    target_jids.append(room_jid)
    target_jids = list(dict.fromkeys(jid for jid in target_jids if jid))
    archive_owner_jids = list(dict.fromkeys([*username_aliases, *group_index.keys()]))

    sql = [
        """
        SELECT
            a.id AS archive_id,
            a.username,
            a.timestamp,
            a.peer,
            a.bare_peer,
            a.txt,
            a.xml,
            a.kind,
            a.origin_id
        FROM archive a
        WHERE 1 = 1
        """,
    ]
    params: list[Any] = []

    owner_clause, owner_params = _build_owner_clause(archive_owner_jids)
    if owner_clause:
        sql.append(owner_clause)
        params.extend(owner_params)

    if start is not None:
        sql.append("  AND a.timestamp >= %s")
        params.append(_to_epoch_ms(start))

    if end is not None:
        sql.append("  AND a.timestamp <= %s")
        params.append(_to_epoch_ms(end))

    sql.append(
        """
        ORDER BY a.timestamp DESC, a.id DESC
        LIMIT %s
        """
    )
    params.append(max(1, min(limit * 20, 500)))

    database_name = database.archive_database_name_for_vhost(vhost)
    rows: list[dict[str, Any]]
    with database.connection(database_name=database_name) as conn:
        with conn.cursor() as cur:
            cur.execute("\n".join(sql), params)
            rows = cur.fetchall()

    enriched_rows: list[dict[str, Any]] = []
    for row in rows:
        try:
            owner = bare_jid(str(row.get("username") or ""))
            peer = bare_jid(str(row.get("bare_peer") or row.get("peer") or ""))
            conversation_jid = peer or owner
            conversation_name = group_index.get(conversation_jid) or group_index.get(owner)
            if owner in group_index:
                conversation_jid = owner
                conversation_name = group_index[owner]
            conversation_type = "groupchat" if conversation_name else "chat"
            if not conversation_name:
                conversation_name = _conversation_name_from_jid(conversation_jid)
            haystack = " ".join(
                str(value or "") for value in [row.get("txt"), row.get("xml"), row.get("peer"), row.get("bare_peer"), row.get("username")]
            ).lower()
            if target_jids and owner not in target_jids and peer not in target_jids:
                continue
            if terms:
                term_hits = all(term in haystack for term in terms)
                room_term_hits = bool(target_jids) and (owner in target_jids or peer in target_jids)
                if not (term_hits or room_term_hits):
                    continue
            enriched_row = dict(row)
            enriched_row["conversation_jid"] = conversation_jid
            enriched_row["conversation_name"] = conversation_name
            enriched_row["conversation_type"] = conversation_type
        except Exception:
            continue
        enriched_rows.append(enriched_row)

    return [_row_to_result(row) for row in enriched_rows]
