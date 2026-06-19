from sqlalchemy import Column, String, Boolean, Integer, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
import uuid
from .database import Base
from datetime import datetime, timezone

class Tenant(Base):
    __tablename__ = "tenants"
    __table_args__ = (
        UniqueConstraint("tenant_slug", "assigned_vhost", name="tenants_tenant_slug_assigned_vhost_key"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String, nullable=False)
    tenant_slug = Column(String, nullable=False)
    assigned_vhost = Column(String, nullable=False)
    status = Column(String, default="ACTIVE", nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    users = relationship("User", back_populates="tenant", cascade="all, delete-orphan")

class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("tenant_id", "username", name="users_tenant_id_username_key"),
        UniqueConstraint("tenant_id", "email", name="users_tenant_id_email_key"),
    )
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="RESTRICT"), nullable=False)
    username = Column(String, index=True, nullable=False)
    email = Column(String, index=True, nullable=False)
    status = Column(String, default="ACTIVE", nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))
    
    tenant = relationship("Tenant", back_populates="users")
    auth = relationship("UserAuth", back_populates="user", uselist=False, cascade="all, delete-orphan")
    profile = relationship("UserProfile", back_populates="user", uselist=False, cascade="all, delete-orphan")

class UserAuth(Base):
    __tablename__ = "user_auth"
    
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    password_hash = Column(String, nullable=False)
    last_login_at = Column(DateTime(timezone=True))
    password_updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    account_locked = Column(Boolean, default=False)
    failed_attempts = Column(Integer, default=0)
    
    user = relationship("User", back_populates="auth")

class UserProfile(Base):
    __tablename__ = "user_profile"

    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    display_name = Column(String)
    avatar_url = Column(String)
    phone = Column(String)
    designation = Column(String)
    bio = Column(String)
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    user = relationship("User", back_populates="profile")
