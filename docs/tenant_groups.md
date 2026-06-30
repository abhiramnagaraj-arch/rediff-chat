# Tenant Group Chats

This implementation treats Postgres as the durable source of truth for Rediff-managed group chats. The Converse UI lists and opens groups only through `auth_service` APIs, while ejabberd MUC remains the message transport.

## Backend API

Authenticated with the same bearer token used by New Chat:

- `GET /api/groups` returns active groups where the current user is a member, scoped to token tenant and vhost.
- `POST /api/groups` creates a group, validates same-tenant members, writes `rediff_groups` and `rediff_group_members`, and returns the MUC JID plus safe room config.
- `GET /api/groups/{id}` returns full details and members for an allowed member.
- `PATCH /api/groups/{id}` allows owner/admin metadata edits.
- `POST /api/groups/{id}/join` verifies membership before the UI opens the MUC.
- `POST /api/groups/{id}/members` and `DELETE /api/groups/{id}/members/{jid}` manage same-tenant members for owner/admin users.

Tables are created on auth-service startup if missing:

- `rediff_groups`
- `rediff_group_members`

## UI Flow

`converse.js/rediff-groups.js` adds a Rediff-specific `+ New Group` button. The panel loads groups from `/api/groups`, creates groups through `POST /api/groups`, searches members through `/api/users/search`, and only opens a room after `POST /api/groups/{id}/join` succeeds.

The UI does not use public MUC discovery and does not accept arbitrary room JIDs for this managed group flow.

## ejabberd Enforcement

`mod_tenant_isolate` still blocks cross-tenant MUC traffic at packet time. It now exposes:

- `sync_room_tenant(RoomJid, Tenant)`
- `get_room_tenant(RoomJid)`

These helpers allow a provisioning job or RPC bridge to pre-bind managed rooms into Mnesia. Until that bridge is wired, the module keeps its existing first-join fallback.

## Provisioning Boundary

The repo does not currently include a backend XMPP admin client for configuring MUC rooms or affiliations. The current working subset returns a members-only persistent room config to the UI and uses Converse `api.rooms.open(..., { auto_configure: true })` immediately after creation.

For production-hard provisioning, add an auth-service to ejabberd admin/RPC bridge that:

1. creates/configures the MUC room,
2. applies owner/member affiliations,
3. calls `mod_tenant_isolate:sync_room_tenant/2`,
4. then returns success to the UI.
