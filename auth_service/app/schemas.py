from pydantic import BaseModel, EmailStr
from typing import Optional
from uuid import UUID
from datetime import datetime

class AuthRequest(BaseModel):
    user: str
    server: str
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
    id: UUID
    tenant_id: UUID
    username: str
    email: str
    status: str
    created_at: datetime
    
    class Config:
        from_attributes = True
