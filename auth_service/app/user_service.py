import uuid
import logging
from sqlalchemy.orm import Session
from passlib.context import CryptContext
from fastapi import HTTPException

from . import models, schemas
from datetime import datetime, timezone

logger = logging.getLogger(__name__)
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

def utcnow():
    return datetime.now(timezone.utc)

def create_user_in_db(db: Session, user_in: schemas.UserCreate) -> models.User:
    tenant = db.query(models.Tenant).filter(models.Tenant.tenant_slug == user_in.domain).first()
    if not tenant:
        raise HTTPException(status_code=400, detail="Tenant domain not found")
    
    existing = db.query(models.User).filter(
        models.User.tenant_id == tenant.id,
        (models.User.username == user_in.username) | (models.User.email == user_in.email)
    ).first()
    
    if existing:
        if existing.status == "DELETED":
            raise HTTPException(status_code=400, detail="Username or email is associated with a deleted user. Contact support to restore.")
        raise HTTPException(status_code=400, detail="Username or email already exists for this tenant")

    try:
        new_user = models.User(
            tenant_id=tenant.id,
            username=user_in.username,
            email=user_in.email,
            status="ACTIVE"
        )
        db.add(new_user)
        db.flush() # get ID

        hashed_password = pwd_context.hash(user_in.password)
        new_auth = models.UserAuth(
            user_id=new_user.id,
            password_hash=hashed_password
        )
        db.add(new_auth)

        new_profile = models.UserProfile(
            user_id=new_user.id,
            display_name=user_in.display_name,
            designation=user_in.designation
        )
        db.add(new_profile)

        db.commit()
        db.refresh(new_user)
        return new_user
    except Exception as e:
        db.rollback()
        logger.error(f"Error creating user: {e}")
        raise HTTPException(status_code=500, detail="Internal Server Error")

def update_user_in_db(db: Session, user_id: uuid.UUID, user_update: schemas.UserUpdate) -> models.User:
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user or user.status == "DELETED":
        raise HTTPException(status_code=404, detail="User not found")
    
    try:
        if user_update.email:
            user.email = user_update.email
        if user_update.status:
            user.status = user_update.status
            
        if user_update.display_name or user_update.designation:
            if not user.profile:
                profile = models.UserProfile(user_id=user.id)
                db.add(profile)
                db.flush()
            if user_update.display_name:
                user.profile.display_name = user_update.display_name
            if user_update.designation:
                user.profile.designation = user_update.designation

        db.commit()
        db.refresh(user)
        return user
    except Exception as e:
        db.rollback()
        logger.error(f"Error updating user: {e}")
        raise HTTPException(status_code=500, detail="Internal Server Error")

def update_password_in_db(db: Session, user_id: uuid.UUID, pass_update: schemas.PasswordUpdate):
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user or user.status == "DELETED":
        raise HTTPException(status_code=404, detail="User not found")
        
    try:
        if not user.auth:
            new_auth = models.UserAuth(user_id=user.id, password_hash=pwd_context.hash(pass_update.password))
            db.add(new_auth)
        else:
            user.auth.password_hash = pwd_context.hash(pass_update.password)
            user.auth.password_updated_at = utcnow()
            user.auth.account_locked = False
            user.auth.failed_attempts = 0

        db.commit()
        return {"success": True}
    except Exception as e:
        db.rollback()
        logger.error(f"Error updating password: {e}")
        raise HTTPException(status_code=500, detail="Internal Server Error")

def soft_delete_user_in_db(db: Session, user_id: uuid.UUID):
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user or user.status == "DELETED":
        raise HTTPException(status_code=404, detail="User not found")
        
    try:
        user.status = "DELETED"
        if user.auth:
            user.auth.account_locked = True
        db.commit()
        return {"success": True}
    except Exception as e:
        db.rollback()
        logger.error(f"Error deleting user: {e}")
        raise HTTPException(status_code=500, detail="Internal Server Error")
