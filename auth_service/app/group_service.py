import re
import secrets
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, status

from . import database, ejabberd, keycloak, schemas


@dataclass(frozen=True)
class CurrentUser:
    jid: str
    tenant_slug: str
    vhost: str


def bare_jid(jid: str) -> str:
    return str(jid or "").split("/", 1)[0].strip().lower()


def tenant_from_jid(jid: str) -> str | None:
    localpart = bare_jid(jid).split("@", 1)[0]
    return keycloak.tenant_slug_from_username(localpart) if localpart else None


def vhost_from_jid(jid: str) -> str | None:
    jid = bare_jid(jid)
    return jid.rsplit("@", 1)[1] if "@" in jid else None


def validate_same_tenant_jid(jid: str, current: CurrentUser) -> str:
    jid = bare_jid(jid)
    if "@" not in jid:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid member JID: {jid}")
    if tenant_from_jid(jid) != current.tenant_slug or vhost_from_jid(jid) != current.vhost:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Member is outside current tenant/vhost: {jid}")
    username, server = jid.rsplit("@", 1)
    if not keycloak.validate_xmpp_username(username) or not keycloak.is_allowed_vhost(server):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid member JID: {jid}")
    if not keycloak.sync_user_active(keycloak.keycloak_username(username, server)):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Member is not active: {jid}")
    return jid


def _slugify_room_name(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug[:40].strip("-") or "group"


def _new_room_node(name: str) -> str:
    return f"{_slugify_room_name(name)}-{secrets.token_hex(4)}"


def _muc_domain(vhost: str) -> str:
    return f"conference.{vhost}"


def _room_config(group: dict[str, Any]) -> dict[str, Any]:
    return {
        "persistentroom": True,
        "membersonly": True,
        "publicroom": False,
        "roomname": group["name"],
        "roomdesc": group.get("description") or "",
        "whois": "moderators",
    }


def _row_to_group(row: dict[str, Any], member: dict[str, Any] | None = None, include_config: bool = False) -> schemas.GroupResponse:
    role = member["role"] if member else None
    can_edit = role in {"owner", "admin"}
    can_join = row["status"] == "active" and bool(member)
    payload = schemas.GroupResponse(
        id=row["id"],
        tenant_slug=row["tenant_slug"],
        vhost=row["vhost"],
        muc_jid=row["muc_jid"],
        room_node=row["room_node"],
        name=row["name"],
        description=row.get("description") or "",
        created_by_jid=row["created_by_jid"],
        owner_jid=row["owner_jid"],
        visibility=row["visibility"],
        membership_mode=row["membership_mode"],
        status=row["status"],
        role=role,
        affiliation=member["affiliation"] if member else None,
        can_edit=can_edit,
        can_join=can_join,
        can_open=can_join,
    )
    if include_config:
        payload.room_config = _room_config(row)
    return payload


def _member_row(cur, group_id: int, jid: str) -> dict[str, Any] | None:
    cur.execute(
        """
        SELECT * FROM rediff_group_members
        WHERE group_id = %s AND member_jid = %s
        """,
        (group_id, jid),
    )
    return cur.fetchone()


def _group_row(cur, group_id: int, current: CurrentUser) -> dict[str, Any]:
    cur.execute(
        """
        SELECT * FROM rediff_groups
        WHERE id = %s AND tenant_slug = %s AND vhost = %s AND status <> 'deleted'
        """,
        (group_id, current.tenant_slug, current.vhost),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Group not found")
    return row


def _ensure_editor(cur, group_id: int, current: CurrentUser) -> dict[str, Any]:
    member = _member_row(cur, group_id, current.jid)
    if not member or member["role"] not in {"owner", "admin"}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only group owners/admins can edit this group")
    return member


def _reconcile_members_with_muc(group: dict[str, Any], members: list[dict[str, Any]]) -> list[dict[str, Any]]:
    affiliations = ejabberd.get_room_affiliations(group["muc_jid"])
    if affiliations is None:
        return members

    live_jids = {
        bare_jid(item.get("jid"))
        for item in affiliations
        if bare_jid(item.get("jid")) and str(item.get("affiliation") or "").lower() in {"owner", "admin", "member"}
    }
    stale_jids = [
        bare_jid(member["member_jid"])
        for member in members
        if bare_jid(member["member_jid"]) != bare_jid(group["owner_jid"]) and bare_jid(member["member_jid"]) not in live_jids
    ]
    if stale_jids:
        with database.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    DELETE FROM rediff_group_members
                    WHERE group_id = %s AND member_jid = ANY(%s)
                    """,
                    (group["id"], stale_jids),
                )
    return [
        member
        for member in members
        if bare_jid(member["member_jid"]) == bare_jid(group["owner_jid"]) or bare_jid(member["member_jid"]) in live_jids
    ]


def list_groups(current: CurrentUser) -> list[schemas.GroupResponse]:
    with database.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT g.*, m.role, m.affiliation
                FROM rediff_groups g
                JOIN rediff_group_members m ON m.group_id = g.id AND m.member_jid = %s
                WHERE g.tenant_slug = %s AND g.vhost = %s AND g.status = 'active'
                ORDER BY g.updated_at DESC, g.name ASC
                """,
                (current.jid, current.tenant_slug, current.vhost),
            )
            rows = cur.fetchall()
    return [
        _row_to_group(row, {"role": row["role"], "affiliation": row["affiliation"]})
        for row in rows
    ]


def create_group(req: schemas.GroupCreate, current: CurrentUser) -> schemas.GroupResponse:
    owner_jid = current.jid
    initial_members = {owner_jid}
    for jid in req.initial_members:
        initial_members.add(validate_same_tenant_jid(jid, current))

    with database.connection() as conn:
        with conn.cursor() as cur:
            room_node = _new_room_node(req.name)
            muc_jid = f"{room_node}@{_muc_domain(current.vhost)}"
            cur.execute(
                """
                INSERT INTO rediff_groups (
                    tenant_slug, vhost, muc_jid, room_node, name, description,
                    created_by_jid, owner_jid, visibility, membership_mode, status
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'tenant_private', 'members_only', 'active')
                RETURNING *
                """,
                (
                    current.tenant_slug,
                    current.vhost,
                    muc_jid,
                    room_node,
                    req.name.strip(),
                    req.description or "",
                    current.jid,
                    owner_jid,
                ),
            )
            group = cur.fetchone()

            for member_jid in sorted(initial_members):
                role = "owner" if member_jid == owner_jid else "member"
                affiliation = "owner" if member_jid == owner_jid else "member"
                cur.execute(
                    """
                    INSERT INTO rediff_group_members (
                        group_id, member_jid, tenant_slug, role, affiliation, added_by_jid
                    )
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (group_id, member_jid)
                    DO UPDATE SET role = EXCLUDED.role, affiliation = EXCLUDED.affiliation, updated_at = now()
                    """,
                    (group["id"], member_jid, current.tenant_slug, role, affiliation, current.jid),
                )

            cur.execute(
                """
                SELECT * FROM rediff_group_members
                WHERE group_id = %s AND member_jid = %s
                """,
                (group["id"], current.jid),
            )
            member = cur.fetchone()

    return _row_to_group(group, member, include_config=True)


def get_group(group_id: int, current: CurrentUser) -> schemas.GroupDetailResponse:
    with database.connection() as conn:
        with conn.cursor() as cur:
            group = _group_row(cur, group_id, current)
            member = _member_row(cur, group_id, current.jid)
            if not member:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You are not a member of this group")
            cur.execute(
                """
                SELECT member_jid, role, affiliation, created_at
                FROM rediff_group_members
                WHERE group_id = %s AND tenant_slug = %s
                ORDER BY role DESC, member_jid ASC
                """,
                (group_id, current.tenant_slug),
            )
            members = cur.fetchall()
    members = _reconcile_members_with_muc(group, members)
    response = schemas.GroupDetailResponse(**_row_to_group(group, member, include_config=True).model_dump())
    response.members = [schemas.GroupMemberResponse(**m) for m in members]
    return response


def update_group(group_id: int, req: schemas.GroupUpdate, current: CurrentUser) -> schemas.GroupResponse:
    with database.connection() as conn:
        with conn.cursor() as cur:
            group = _group_row(cur, group_id, current)
            _ensure_editor(cur, group_id, current)
            name = req.name.strip() if req.name is not None else group["name"]
            description = req.description if req.description is not None else group["description"]
            status_value = req.status if req.status is not None else group["status"]
            cur.execute(
                """
                UPDATE rediff_groups
                SET name = %s, description = %s, status = %s, updated_at = now()
                WHERE id = %s
                RETURNING *
                """,
                (name, description or "", status_value, group_id),
            )
            updated = cur.fetchone()
            member = _member_row(cur, group_id, current.jid)
    return _row_to_group(updated, member, include_config=True)


def join_group(group_id: int, current: CurrentUser) -> schemas.GroupJoinResponse:
    with database.connection() as conn:
        with conn.cursor() as cur:
            group = _group_row(cur, group_id, current)
            if group["status"] != "active":
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Group is not active")
            member = _member_row(cur, group_id, current.jid)
            if not member:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You are not allowed to join this group")
    return schemas.GroupJoinResponse(
        success=True,
        muc_jid=group["muc_jid"],
        room_config=_room_config(group),
    )


def add_member(group_id: int, req: schemas.GroupMemberCreate, current: CurrentUser) -> schemas.GroupMemberResponse:
    member_jid = validate_same_tenant_jid(req.member_jid, current)
    role = req.role or "member"
    affiliation = "admin" if role == "admin" else "member"
    if role not in {"member", "admin"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Role must be member or admin")

    with database.connection() as conn:
        with conn.cursor() as cur:
            _group_row(cur, group_id, current)
            _ensure_editor(cur, group_id, current)
            cur.execute(
                """
                INSERT INTO rediff_group_members (
                    group_id, member_jid, tenant_slug, role, affiliation, added_by_jid
                )
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (group_id, member_jid)
                DO UPDATE SET role = EXCLUDED.role, affiliation = EXCLUDED.affiliation, updated_at = now()
                RETURNING member_jid, role, affiliation, created_at
                """,
                (group_id, member_jid, current.tenant_slug, role, affiliation, current.jid),
            )
            row = cur.fetchone()
    return schemas.GroupMemberResponse(**row)


def remove_member(group_id: int, member_jid: str, current: CurrentUser) -> dict[str, bool]:
    member_jid = validate_same_tenant_jid(member_jid, current)
    with database.connection() as conn:
        with conn.cursor() as cur:
            group = _group_row(cur, group_id, current)
            current_member = _member_row(cur, group_id, current.jid)
            if not current_member:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You are not a member of this group")

            if member_jid == current.jid:
                if member_jid == group["owner_jid"]:
                    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Group owner cannot exit the group")
            else:
                if current_member["role"] not in {"owner", "admin"}:
                    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only group owners/admins can remove participants")
                if member_jid == group["owner_jid"]:
                    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Group owner cannot be removed")

            muc_jid = group["muc_jid"]

    try:
        ejabberd.remove_room_affiliation(muc_jid, member_jid)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Unable to remove participant from live group room",
        ) from exc

    with database.connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM rediff_group_members WHERE group_id = %s AND member_jid = %s",
                (group_id, member_jid),
            )
    return {"success": True}
