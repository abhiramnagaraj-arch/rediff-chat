# pyrefly: ignore [missing-import]
from fastapi import HTTPException

from . import keycloak, schemas


def _to_user_response(user: dict) -> schemas.UserResponse:
    attrs = keycloak.normalize_attributes(user.get("attributes"))
    return schemas.UserResponse(
        id=str(user.get("id", "")),
        username=user.get("username", ""),
        email=user.get("email"),
        enabled=bool(user.get("enabled") is True),
        tenant_slug=(attrs.get("tenant_slug") or [None])[0],
        assigned_vhost=(attrs.get("assigned_vhost") or [None])[0],
        first_name=user.get("firstName"),
        attributes=attrs,
    )


def create_user_in_keycloak(user_in: schemas.UserCreate) -> schemas.UserResponse:
    if not keycloak.is_allowed_vhost(user_in.domain):
        raise HTTPException(status_code=400, detail="Unsupported XMPP vhost")
    if not keycloak.validate_xmpp_username(user_in.username):
        raise HTTPException(
            status_code=400,
            detail="Username must be in '<tenant>.<user>' format using lowercase letters, numbers, '.', '_' or '-'",
        )

    username = keycloak.keycloak_username(user_in.username, user_in.domain)
    if keycloak.sync_user_exists(username):
        raise HTTPException(status_code=400, detail="Username already exists in Keycloak")

    if not keycloak.sync_user_created(
        username=username,
        email=user_in.email,
        password=user_in.password,
        display_name=user_in.display_name,
        designation=user_in.designation,
    ):
        raise HTTPException(status_code=502, detail="Unable to provision user in Keycloak")

    user = keycloak.get_user(username)
    if not user:
        raise HTTPException(status_code=502, detail="Unable to read back provisioned user from Keycloak")

    return _to_user_response(user)


def update_user_in_keycloak(user_id: str, user_update: schemas.UserUpdate) -> schemas.UserResponse:
    current = keycloak.get_user_by_id(user_id)
    if not current:
        raise HTTPException(status_code=404, detail="User not found")

    if not keycloak.sync_user_update_by_id(
        user_id=user_id,
        email=user_update.email,
        display_name=user_update.display_name,
        designation=user_update.designation,
        active=(user_update.status == "ACTIVE") if user_update.status is not None else None,
    ):
        raise HTTPException(status_code=502, detail="Unable to update user in Keycloak")
    return _to_user_response(keycloak.get_user_by_id(user_id) or current)


def update_password_in_keycloak(user_id: str, pass_update: schemas.PasswordUpdate):
    if not keycloak.get_user_by_id(user_id):
        raise HTTPException(status_code=404, detail="User not found")

    if not keycloak.sync_user_password_reset_by_id(user_id=user_id, password=pass_update.password):
        raise HTTPException(status_code=502, detail="Unable to update password in Keycloak")

    return {"success": True}


def delete_user_in_keycloak(user_id: str):
    if not keycloak.get_user_by_id(user_id):
        raise HTTPException(status_code=404, detail="User not found")

    if not keycloak.sync_user_delete_by_id(user_id=user_id):
        raise HTTPException(status_code=502, detail="Unable to delete user in Keycloak")

    return {"success": True}
