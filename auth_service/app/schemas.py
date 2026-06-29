from pydantic import BaseModel, EmailStr, Field, ConfigDict
from typing import Optional, Any

class AuthRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    user: str = Field(alias="username")
    server: str = Field(alias="domain")
    password: str

class AuthResponse(BaseModel):
    success: bool

class UserCreate(BaseModel):
    username: str
    email: EmailStr
    password: str
    domain: str
    display_name: Optional[str] = None
    designation: Optional[str] = None

class UserUpdate(BaseModel):
    email: Optional[EmailStr] = None
    display_name: Optional[str] = None
    designation: Optional[str] = None
    status: Optional[str] = None

class PasswordUpdate(BaseModel):
    password: str

class UserResponse(BaseModel):
    id: str
    username: str
    email: Optional[EmailStr] = None
    enabled: bool
    tenant_slug: Optional[str] = None
    assigned_vhost: Optional[str] = None
    first_name: Optional[str] = None
    attributes: dict[str, Any] = Field(default_factory=dict)


class OIDCIdentityResponse(BaseModel):
    subject: str
    username: Optional[str] = None
    email: Optional[str] = None
    tenant_slug: Optional[str] = None
    claims: dict[str, Any]
