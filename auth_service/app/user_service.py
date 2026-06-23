import uuid
import logging
from sqlalchemy.orm import Session
from fastapi import HTTPException

from . import models, schemas
from . import keycloak
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

def utcnow():
    return datetime.now(timezone.utc)

def _resolve_tenant(db: Session, tenant_selector: str) -> models.Tenant:
    tenant = db.query(models.Tenant).filter(
        (models.Tenant.tenant_slug == tenant_selector) | (models.Tenant.assigned_vhost == tenant_selector)
    ).first()
    if not tenant:
        raise HTTPException(status_code=400, detail="Tenant domain not found")
    return tenant


def create_user_in_db(db: Session, user_in: schemas.UserCreate) -> models.User:
    tenant = _resolve_tenant(db, user_in.domain)
    keycloak_user = keycloak.keycloak_username(tenant.tenant_slug, user_in.username)

    existing = db.query(models.User).filter(
        models.User.tenant_id == tenant.id,
        (models.User.username == user_in.username) | (models.User.email == user_in.email)
    ).first()

    if existing:
        if existing.status == "DELETED":
            raise HTTPException(status_code=400, detail="Username or email is associated with a deleted user. Contact support to restore.")
        raise HTTPException(status_code=400, detail="Username or email already exists for this tenant")

    if keycloak.sync_user_exists(keycloak_user):
        raise HTTPException(status_code=400, detail="Username already exists in Keycloak")

    if not keycloak.sync_user_created(
        username=keycloak_user,
        email=user_in.email,
        password=user_in.password,
        tenant_slug=tenant.tenant_slug,
        display_name=user_in.display_name,
        designation=user_in.designation,
    ):
        raise HTTPException(status_code=502, detail="Unable to provision user in Keycloak")

    try:
        new_user = models.User(
            tenant_id=tenant.id,
            username=user_in.username,
            email=user_in.email,
            status="ACTIVE"
        )
        db.add(new_user)
        db.flush() # get ID

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
        keycloak.sync_user_delete_permanent(username=keycloak_user)
        logger.error(f"Error creating user: {e}")
        raise HTTPException(status_code=500, detail="Internal Server Error")

def update_user_in_db(db: Session, user_id: uuid.UUID, user_update: schemas.UserUpdate) -> models.User:
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user or user.status == "DELETED":
        raise HTTPException(status_code=404, detail="User not found")

    tenant = user.tenant
    keycloak_user = keycloak.keycloak_username(tenant.tenant_slug, user.username)
    original_email = user.email
    original_display_name = user.profile.display_name if user.profile else None
    original_designation = user.profile.designation if user.profile else None
    original_status = user.status

    if not keycloak.sync_user_updated(
        username=keycloak_user,
        email=user_update.email if user_update.email is not None else user.email,
        display_name=user_update.display_name if user_update.display_name is not None else original_display_name,
        designation=user_update.designation if user_update.designation is not None else original_designation,
        active=(user_update.status == "ACTIVE") if user_update.status is not None else (user.status == "ACTIVE"),
    ):
        raise HTTPException(status_code=502, detail="Unable to update user in Keycloak")

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
        keycloak.sync_user_updated(
            username=keycloak_user,
            email=original_email,
            display_name=original_display_name,
            designation=original_designation,
            active=(original_status == "ACTIVE"),
        )
        logger.error(f"Error updating user: {e}")
        raise HTTPException(status_code=500, detail="Internal Server Error")

def update_password_in_db(db: Session, user_id: uuid.UUID, pass_update: schemas.PasswordUpdate):
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user or user.status == "DELETED":
        raise HTTPException(status_code=404, detail="User not found")

    tenant = user.tenant
    keycloak_user = keycloak.keycloak_username(tenant.tenant_slug, user.username)

    if not keycloak.sync_user_password_reset(username=keycloak_user, password=pass_update.password):
        raise HTTPException(status_code=502, detail="Unable to update password in Keycloak")

    return {"success": True}

def soft_delete_user_in_db(db: Session, user_id: uuid.UUID):
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user or user.status == "DELETED":
        raise HTTPException(status_code=404, detail="User not found")

    tenant = user.tenant
    keycloak_user = keycloak.keycloak_username(tenant.tenant_slug, user.username)
    original_status = user.status

    if not keycloak.sync_user_disable(username=keycloak_user):
        raise HTTPException(status_code=502, detail="Unable to disable user in Keycloak")

    try:
        user.status = "DELETED"
        db.commit()
        return {"success": True}
    except Exception as e:
        db.rollback()
        keycloak.sync_user_enable(username=keycloak_user)
        user.status = original_status
        logger.error(f"Error deleting user: {e}")
        raise HTTPException(status_code=500, detail="Internal Server Error")
