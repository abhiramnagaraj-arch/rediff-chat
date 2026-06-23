from datetime import datetime, timezone
import uuid
from fastapi import FastAPI, Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy import text
from sqlalchemy.orm import Session
import logging

from . import models, schemas, database, user_service
from . import keycloak

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Rediff Auth Service")
bearer_scheme = HTTPBearer(auto_error=False)


def utcnow():
    return datetime.now(timezone.utc)

def _extract_identity_from_claims(claims: dict) -> schemas.OIDCIdentityResponse:
    return schemas.OIDCIdentityResponse(
        subject=str(claims.get("sub", "")),
        username=claims.get("preferred_username") or claims.get("username"),
        email=claims.get("email"),
        tenant_slug=claims.get("tenant_slug") or claims.get("tenant"),
        claims=claims,
    )

@app.post("/auth")
def authenticate_user(req: schemas.AuthRequest, db: Session = Depends(database.get_db)):
    """
    Authenticate a user. Ejabberd http auth will call this endpoint.
    """
    logger.info(f"Auth request for user: {req.user}@{req.server}")

    parts = req.user.split(".")
    if len(parts) < 2:
        logger.warning(f"Invalid user format: {req.user}")
        return schemas.AuthResponse(success=False)

    tenant_slug = parts[0]
    username_part = ".".join(parts[1:])

    user = db.query(models.User).join(models.Tenant).filter(
        models.User.username == username_part,
        models.Tenant.tenant_slug == tenant_slug,
        models.Tenant.assigned_vhost == req.server
    ).first()

    if not user:
        logger.warning(f"User not found: {req.user}@{req.server}")
        return schemas.AuthResponse(success=False)

    if user.tenant.status != "ACTIVE":
        logger.warning(f"Tenant {req.server} is not ACTIVE (status: {user.tenant.status})")
        return schemas.AuthResponse(success=False)

    if user.status != "ACTIVE":
        logger.warning(f"User {req.user} is not ACTIVE (status: {user.status})")
        return schemas.AuthResponse(success=False)

    expected_username = keycloak.keycloak_username(tenant_slug, username_part)
    try:
        claims = keycloak.authenticate_password(username=expected_username, password=req.password)
        claim_tenant = claims.get("tenant_slug") or claims.get("tenant")
        claim_user = claims.get("preferred_username") or claims.get("username")

        if claim_tenant != tenant_slug:
            logger.warning("Keycloak tenant mismatch for %s: %s != %s", req.user, claim_tenant, tenant_slug)
            return schemas.AuthResponse(success=False)

        if claim_user != expected_username:
            logger.warning("Keycloak username mismatch for %s: %s != %s", req.user, claim_user, expected_username)
            return schemas.AuthResponse(success=False)

        logger.info(f"Authentication successful for user: {req.user}@{req.server}")
        return schemas.AuthResponse(success=True)
    except HTTPException as exc:
        logger.warning("Keycloak auth rejected for %s: %s", req.user, exc.detail)
        return schemas.AuthResponse(success=False)
    except Exception as exc:
        logger.error("Authentication failed for %s: %s", req.user, exc)
        return schemas.AuthResponse(success=False)

@app.get("/users/{username}")
def check_user_exists(username: str, domain: str, db: Session = Depends(database.get_db)):
    """
    Check if a user exists.
    """
    logger.info(f"Check user request for user: {username}@{domain}")

    parts = username.split(".")
    if len(parts) < 2:
        return schemas.AuthResponse(success=False)

    tenant_slug = parts[0]
    username_part = ".".join(parts[1:])

    user = db.query(models.User).join(models.Tenant).filter(
        models.User.username == username_part,
        models.Tenant.tenant_slug == tenant_slug,
        models.Tenant.assigned_vhost == domain
    ).first()

    if user and user.status == "ACTIVE":
        return schemas.AuthResponse(success=True)

    expected_username = keycloak.keycloak_username(tenant_slug, username_part)
    if keycloak.sync_user_active(expected_username):
        return schemas.AuthResponse(success=True)
    return schemas.AuthResponse(success=False)


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
def create_user(user_in: schemas.UserCreate, db: Session = Depends(database.get_db)):
    return user_service.create_user_in_db(db, user_in)

@app.patch("/users/{user_id}", response_model=schemas.UserResponse)
def update_user(user_id: uuid.UUID, user_update: schemas.UserUpdate, db: Session = Depends(database.get_db)):
    return user_service.update_user_in_db(db, user_id, user_update)

@app.patch("/users/{user_id}/password")
def update_password(user_id: uuid.UUID, pass_update: schemas.PasswordUpdate, db: Session = Depends(database.get_db)):
    return user_service.update_password_in_db(db, user_id, pass_update)

@app.delete("/users/{user_id}")
def delete_user(user_id: uuid.UUID, db: Session = Depends(database.get_db)):
    return user_service.soft_delete_user_in_db(db, user_id)

@app.get("/health")
def health_check(db: Session = Depends(database.get_db)):
    try:
        db.execute(text("SELECT 1"))
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="database unavailable",
        )

    return {"status": "ok", "database": "ok"}
