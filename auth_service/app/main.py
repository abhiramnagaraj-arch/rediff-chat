import logging
import secrets

from fastapi import FastAPI, HTTPException, status
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import keycloak, schemas, user_service

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Rediff Auth Service")
bearer_scheme = HTTPBearer(auto_error=False)
admin_bearer_scheme = HTTPBearer(auto_error=False)


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

        if not claim_user or not claim_tenant or not claim_server:
            logger.warning(
                "Keycloak required claims missing for %s: username=%s tenant=%s vhost=%s",
                req.user,
                bool(claim_user),
                bool(claim_tenant),
                bool(claim_server),
            )
            return schemas.AuthResponse(success=False)

        if claim_user != expected_username:
            logger.warning("Keycloak username mismatch for %s: %s != %s", req.user, claim_user, expected_username)
            return schemas.AuthResponse(success=False)

        if claim_tenant != tenant_slug:
            logger.warning("Keycloak tenant mismatch for %s: %s != %s", req.user, claim_tenant, tenant_slug)
            return schemas.AuthResponse(success=False)

        if claim_server != req.server:
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
