import logging
import secrets

from fastapi import FastAPI, HTTPException, status
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from datetime import datetime

from fastapi import Query

from . import database, group_service, keycloak, message_service, schemas, user_service

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Rediff Auth Service")
bearer_scheme = HTTPBearer(auto_error=False)
admin_bearer_scheme = HTTPBearer(auto_error=False)


@app.on_event("startup")
def startup_group_schema() -> None:
    try:
        database.init_group_schema()
        for vhost in keycloak.allowed_vhosts():
            database.init_archive_schema(database.archive_database_name_for_vhost(vhost))
    except Exception as exc:
        logger.warning("Group schema initialization failed: %s", exc)


def _admin_token() -> str:
    import os

    token = os.getenv("AUTH_SERVICE_ADMIN_TOKEN", "").strip()
    if not token:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Admin API token is not configured")
    return token


def require_admin(credentials: HTTPAuthorizationCredentials | None = Depends(admin_bearer_scheme)) -> None:
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bearer token required")
    if not secrets.compare_digest(credentials.credentials, _admin_token()):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid admin token")


def _validate_xmpp_identity(username: str, server: str) -> None:
    if not keycloak.is_allowed_vhost(server):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported XMPP vhost")
    if not keycloak.validate_xmpp_username(username):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username must be in '<tenant>.<user>' format using lowercase letters, numbers, '.', '_' or '-'",
        )


def _extract_identity_from_claims(claims: dict) -> schemas.OIDCIdentityResponse:
    return schemas.OIDCIdentityResponse(
        subject=str(claims.get("sub", "")),
        username=claims.get("preferred_username") or claims.get("username"),
        email=claims.get("email"),
        tenant_slug=claims.get("tenant_slug") or claims.get("tenant"),
        claims=claims,
    )


def _claim_str(claims: dict, *keys: str) -> str | None:
    for key in keys:
        value = claims.get(key)
        if isinstance(value, list):
            value = value[0] if value else None
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return None


@app.post("/auth")
def authenticate_user(req: schemas.AuthRequest):
    logger.info("Auth request for user: %s@%s", req.user, req.server)
    _validate_xmpp_identity(req.user, req.server)

    expected_username = keycloak.keycloak_username(req.user, req.server)
    tenant_slug = keycloak.tenant_slug_from_username(req.user)

    try:
        claims = keycloak.authenticate_password(username=expected_username, password=req.password)
        claim_user = _claim_str(claims, "preferred_username", "username")
        claim_tenant = _claim_str(claims, "tenant_slug", "tenant")
        claim_server = _claim_str(claims, "assigned_vhost")

        if claim_user and claim_user != expected_username:
            logger.warning("Keycloak username mismatch for %s: %s != %s", req.user, claim_user, expected_username)
            return schemas.AuthResponse(success=False)

        if claim_tenant and claim_tenant != tenant_slug:
            logger.warning("Keycloak tenant mismatch for %s: %s != %s", req.user, claim_tenant, tenant_slug)
            return schemas.AuthResponse(success=False)

        if claim_server and claim_server != req.server:
            logger.warning("Keycloak vhost mismatch for %s: %s != %s", req.user, claim_server, req.server)
            return schemas.AuthResponse(success=False)

        return schemas.AuthResponse(success=True)
    except HTTPException as exc:
        logger.warning("Keycloak auth rejected for %s: %s", req.user, exc.detail)
        return schemas.AuthResponse(success=False)
    except Exception as exc:
        logger.error("Authentication failed for %s@%s: %s", req.user, req.server, exc)
        return schemas.AuthResponse(success=False)


@app.get("/users/{username}")
def check_user_exists(username: str, domain: str):
    logger.info("Check user request for user: %s@%s", username, domain)
    _validate_xmpp_identity(username, domain)

    expected_username = keycloak.keycloak_username(username, domain)
    user = keycloak.get_user(expected_username)
    if not user:
        return schemas.AuthResponse(success=False)

    if user.get("enabled") is not True:
        return schemas.AuthResponse(success=False)

    return schemas.AuthResponse(success=True)


@app.get("/oidc/me", response_model=schemas.OIDCIdentityResponse)
def oidc_me(credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme)):
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bearer token required")

    try:
        claims = keycloak.verify_access_token(credentials.credentials)
        return _extract_identity_from_claims(claims)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("OIDC identity extraction failed: %s", exc)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="OIDC identity extraction failed") from exc


@app.post("/api/oidc/token", response_model=schemas.OIDCTokenResponse)
def oidc_token(req: schemas.OIDCTokenRequest):
    bare_jid = req.jid.split("/", 1)[0].strip().lower()
    if "@" not in bare_jid:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="JID must include a domain")

    username, server = bare_jid.rsplit("@", 1)
    _validate_xmpp_identity(username, server)

    expected_username = keycloak.keycloak_username(username, server)
    access_token = keycloak.password_access_token(username=expected_username, password=req.password)
    return schemas.OIDCTokenResponse(access_token=access_token)


@app.post("/users", response_model=schemas.UserResponse, status_code=status.HTTP_201_CREATED)
def create_user(user_in: schemas.UserCreate, _: None = Depends(require_admin)):
    return user_service.create_user_in_keycloak(user_in)


@app.patch("/users/{user_id}", response_model=schemas.UserResponse)
def update_user(user_id: str, user_update: schemas.UserUpdate, _: None = Depends(require_admin)):
    return user_service.update_user_in_keycloak(user_id, user_update)


@app.patch("/users/{user_id}/password")
def update_password(user_id: str, pass_update: schemas.PasswordUpdate, _: None = Depends(require_admin)):
    return user_service.update_password_in_keycloak(user_id, pass_update)


@app.delete("/users/{user_id}")
def delete_user(user_id: str, _: None = Depends(require_admin)):
    return user_service.delete_user_in_keycloak(user_id)


def _current_tenant_from_claims(claims: dict) -> str:
    tenant = _claim_str(claims, "tenant_slug", "tenant")
    if tenant:
        return tenant

    username = _claim_str(claims, "preferred_username", "username")
    if username:
        localpart = username.split("@", 1)[0]
        return keycloak.tenant_slug_from_username(localpart)

    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Tenant claim missing")


def _current_vhost_from_claims(claims: dict) -> str:
    vhost = _claim_str(claims, "assigned_vhost")
    if vhost:
        return vhost

    username = _claim_str(claims, "preferred_username", "username")
    if username and "@" in username:
        return username.rsplit("@", 1)[1]

    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="XMPP vhost claim missing")



def _current_jid_from_claims(claims: dict) -> str:
    username = _claim_str(claims, "preferred_username", "username")
    if username and "@" in username:
        return username.split("/", 1)[0].strip().lower()

    vhost = _current_vhost_from_claims(claims)
    if username:
        return f"{username}@{vhost}".lower()

    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Current JID claim missing")


def current_group_user(credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme)) -> group_service.CurrentUser:
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bearer token required")

    claims = keycloak.verify_access_token(credentials.credentials)
    return group_service.CurrentUser(
        jid=_current_jid_from_claims(claims),
        tenant_slug=_current_tenant_from_claims(claims),
        vhost=_current_vhost_from_claims(claims),
    )


@app.get("/api/groups", response_model=list[schemas.GroupResponse])
def list_groups(current: group_service.CurrentUser = Depends(current_group_user)):
    return group_service.list_groups(current)


@app.post("/api/groups", response_model=schemas.GroupResponse, status_code=status.HTTP_201_CREATED)
def create_group(req: schemas.GroupCreate, current: group_service.CurrentUser = Depends(current_group_user)):
    return group_service.create_group(req, current)


@app.get("/api/groups/{group_id}", response_model=schemas.GroupDetailResponse)
def get_group(group_id: int, current: group_service.CurrentUser = Depends(current_group_user)):
    return group_service.get_group(group_id, current)


@app.patch("/api/groups/{group_id}", response_model=schemas.GroupResponse)
def update_group(group_id: int, req: schemas.GroupUpdate, current: group_service.CurrentUser = Depends(current_group_user)):
    return group_service.update_group(group_id, req, current)


@app.post("/api/groups/{group_id}/join", response_model=schemas.GroupJoinResponse)
def join_group(group_id: int, current: group_service.CurrentUser = Depends(current_group_user)):
    return group_service.join_group(group_id, current)


@app.post("/api/groups/{group_id}/members", response_model=schemas.GroupMemberResponse, status_code=status.HTTP_201_CREATED)
def add_group_member(
    group_id: int,
    req: schemas.GroupMemberCreate,
    current: group_service.CurrentUser = Depends(current_group_user),
):
    return group_service.add_member(group_id, req, current)


@app.delete("/api/groups/{group_id}/members/{member_jid:path}")
def remove_group_member(group_id: int, member_jid: str, current: group_service.CurrentUser = Depends(current_group_user)):
    return group_service.remove_member(group_id, member_jid, current)


@app.post("/api/groups/{group_id}/sync", response_model=schemas.GroupSyncResponse)
def sync_group_room(group_id: int, current: group_service.CurrentUser = Depends(current_group_user)):
    return group_service.sync_room_members(group_id, current)


@app.get("/health")
def health_check():
    try:
        if not keycloak.enabled():
            raise RuntimeError("Keycloak is not enabled")
        import requests

        response = requests.get(keycloak.realm_url(".well-known/openid-configuration"), timeout=5)
        response.raise_for_status()
    except Exception as exc:
        logger.error("Health check failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="keycloak unavailable",
        ) from exc

    return {"status": "ok", "keycloak": "ok"}



@app.get("/api/users/search", response_model=list[schemas.UserSearchResult])
def search_users(q: str, credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme)):
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bearer token required")

    claims = keycloak.verify_access_token(credentials.credentials)
    current_tenant = _current_tenant_from_claims(claims)
    current_vhost = _current_vhost_from_claims(claims)
    return keycloak.search_active_users_for_tenant(q, current_tenant, assigned_vhost=current_vhost, limit=20)


@app.get("/api/messages/search", response_model=list[schemas.MessageSearchResult])
def search_messages(
    q: str,
    with_jid: str | None = None,
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=50),
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bearer token required")

    claims = keycloak.verify_access_token(credentials.credentials)
    current_jid = _current_jid_from_claims(claims)
    current_tenant = _current_tenant_from_claims(claims)
    current_vhost = _current_vhost_from_claims(claims)
    try:
        return message_service.search_messages(
            current_jid=current_jid,
            tenant_slug=current_tenant,
            vhost=current_vhost,
            q=q,
            with_jid=with_jid,
            start=start,
            end=end,
            limit=limit,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception(
            "Message search failed for user=%s tenant=%s vhost=%s q=%r with_jid=%r",
            current_jid,
            current_tenant,
            current_vhost,
            q,
            with_jid,
        )
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Message search failed") from exc
