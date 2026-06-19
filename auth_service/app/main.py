from datetime import datetime, timezone
import uuid
from fastapi import FastAPI, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.orm import Session
from passlib.context import CryptContext
import logging

from . import models, schemas, database, user_service

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
MAX_FAILED_ATTEMPTS = 5

app = FastAPI(title="Rediff Auth Service")


def utcnow():
    return datetime.now(timezone.utc)



def record_failed_attempt(db: Session, auth: models.UserAuth) -> None:
    auth.failed_attempts = (auth.failed_attempts or 0) + 1
    if auth.failed_attempts >= MAX_FAILED_ATTEMPTS:
        auth.account_locked = True
    db.commit()


def record_successful_login(db: Session, auth: models.UserAuth) -> None:
    auth.last_login_at = utcnow()
    auth.failed_attempts = 0
    auth.account_locked = False
    db.commit()

@app.post("/auth")
def authenticate_user(req: schemas.AuthRequest, db: Session = Depends(database.get_db)):
    """
    Authenticate a user. Ejabberd http auth will call this endpoint.
    """
    logger.info(f"Auth request for user: {req.user}@{req.server}")
    
    parts = req.user.split(".")
    if len(parts) < 2:
        logger.warning(f"Invalid user format: {req.user}")
        return False
        
    tenant_slug = parts[0]
    username_part = ".".join(parts[1:])
    
    user = db.query(models.User).join(models.Tenant).filter(
        models.User.username == username_part,
        models.Tenant.tenant_slug == tenant_slug,
        models.Tenant.assigned_vhost == req.server
    ).first()
    
    if not user:
        logger.warning(f"User not found: {req.user}@{req.server}")
        return False
        
    if user.tenant.status != "ACTIVE":
        logger.warning(f"Tenant {req.server} is not ACTIVE (status: {user.tenant.status})")
        return False
        
    if user.status != "ACTIVE":
        logger.warning(f"User {req.user} is not ACTIVE (status: {user.status})")
        return False
        
    if not user.auth:
        logger.warning(f"No auth record for user: {req.user}")
        return False
        
    if user.auth.account_locked:
        logger.warning(f"Account locked for user: {req.user}")
        return schemas.AuthResponse(success=False)

    # Verify password
    try:
        is_valid = pwd_context.verify(req.password, user.auth.password_hash)
    except Exception as e:
        logger.error(f"Error verifying password hash for user {req.user}: {e}")
        return schemas.AuthResponse(success=False)
    
    if is_valid:
        logger.info(f"Authentication successful for user: {req.user}@{req.server}")
        try:
            record_successful_login(db, user.auth)
        except Exception as e:
            db.rollback()
            logger.error(f"Failed to persist successful login for {req.user}: {e}")
            return schemas.AuthResponse(success=False)
        return schemas.AuthResponse(success=True)
    else:
        logger.warning(f"Invalid password for user: {req.user}@{req.server}")
        try:
            record_failed_attempt(db, user.auth)
        except Exception as e:
            db.rollback()
            logger.error(f"Failed to persist failed attempt for {req.user}: {e}")
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
    return schemas.AuthResponse(success=False)

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
