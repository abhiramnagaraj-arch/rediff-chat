from datetime import datetime
from typing import Optional, Any

from pydantic import BaseModel, EmailStr, Field, ConfigDict

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

class OIDCTokenRequest(BaseModel):
    jid: str
    password: str


class OIDCTokenResponse(BaseModel):
    access_token: str
    token_type: str = "Bearer"


class UserSearchResult(BaseModel):
    jid: str
    display_name: Optional[str] = None
    email: Optional[EmailStr] = None
    tenant: str

class GroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: Optional[str] = Field(default="", max_length=1000)
    initial_members: list[str] = Field(default_factory=list)


class GroupUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=1000)
    status: Optional[str] = Field(default=None, pattern="^(active|archived)$")


class GroupMemberCreate(BaseModel):
    member_jid: str
    role: Optional[str] = Field(default="member", pattern="^(member|admin)$")


class GroupMemberResponse(BaseModel):
    member_jid: str
    role: str
    affiliation: str
    created_at: datetime


class GroupResponse(BaseModel):
    id: int
    tenant_slug: str
    vhost: str
    muc_jid: str
    room_node: str
    name: str
    description: str = ""
    created_by_jid: str
    owner_jid: str
    visibility: str
    membership_mode: str
    status: str
    role: Optional[str] = None
    affiliation: Optional[str] = None
    can_edit: bool = False
    can_join: bool = False
    can_open: bool = False
    room_config: Optional[dict[str, Any]] = None


class GroupDetailResponse(GroupResponse):
    members: list[GroupMemberResponse] = Field(default_factory=list)


class GroupJoinResponse(BaseModel):
    success: bool
    muc_jid: str
    room_config: dict[str, Any] = Field(default_factory=dict)

