import logging
from functools import lru_cache
from typing import Any, Optional
from urllib.parse import urljoin

import jwt
import requests
from fastapi import HTTPException, status
from jwt import InvalidTokenError, PyJWKClient

logger = logging.getLogger(__name__)

KEYCLOAK_BASE_URL = "http://rediff_keycloak:8080"
KEYCLOAK_ISSUER_URL = "http://localhost:18080"
KEYCLOAK_REALM = "rediff"
KEYCLOAK_ADMIN_USERNAME = "admin"
KEYCLOAK_ADMIN_PASSWORD = "change_me"
KEYCLOAK_LOGIN_CLIENT_ID = "rediff-web"
KEYCLOAK_AUDIENCE = ""
KEYCLOAK_ENABLED = "true"
KEYCLOAK_SYNC_ENABLED = "true"


def _env(name: str, default: str) -> str:
    import os

    value = os.getenv(name, default)
    return value.strip() if value else default


KEYCLOAK_BASE_URL = _env("KEYCLOAK_BASE_URL", KEYCLOAK_BASE_URL).rstrip("/")
KEYCLOAK_ISSUER_URL = _env("KEYCLOAK_ISSUER_URL", KEYCLOAK_ISSUER_URL).rstrip("/")
KEYCLOAK_REALM = _env("KEYCLOAK_REALM", KEYCLOAK_REALM)
KEYCLOAK_ADMIN_USERNAME = _env("KEYCLOAK_ADMIN_USERNAME", KEYCLOAK_ADMIN_USERNAME)
KEYCLOAK_ADMIN_PASSWORD = _env("KEYCLOAK_ADMIN_PASSWORD", KEYCLOAK_ADMIN_PASSWORD)
KEYCLOAK_LOGIN_CLIENT_ID = _env("KEYCLOAK_LOGIN_CLIENT_ID", KEYCLOAK_LOGIN_CLIENT_ID)
KEYCLOAK_AUDIENCE = _env("KEYCLOAK_AUDIENCE", KEYCLOAK_AUDIENCE)
KEYCLOAK_ENABLED = _env("KEYCLOAK_ENABLED", KEYCLOAK_ENABLED).lower() in {"1", "true", "yes", "on"}
KEYCLOAK_SYNC_ENABLED = _env("KEYCLOAK_SYNC_ENABLED", KEYCLOAK_SYNC_ENABLED).lower() in {"1", "true", "yes", "on"}


def enabled() -> bool:
    return KEYCLOAK_ENABLED and bool(KEYCLOAK_BASE_URL and KEYCLOAK_ISSUER_URL and KEYCLOAK_REALM)


def sync_enabled() -> bool:
    return enabled() and KEYCLOAK_SYNC_ENABLED


def keycloak_username(tenant_slug: str, username: str) -> str:
    return f"{tenant_slug}.{username}"


def realm_url(path: str) -> str:
    base = f"{KEYCLOAK_BASE_URL}/realms/{KEYCLOAK_REALM}/"
    return urljoin(base, path.lstrip("/"))


def master_url(path: str) -> str:
    base = f"{KEYCLOAK_BASE_URL}/realms/master/"
    return urljoin(base, path.lstrip("/"))


@lru_cache(maxsize=1)
def jwk_client() -> PyJWKClient:
    return PyJWKClient(realm_url("protocol/openid-connect/certs"))


def verify_access_token(token: str) -> dict[str, Any]:
    if not enabled():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Keycloak is not enabled")

    try:
        signing_key = jwk_client().get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token,
            key=signing_key,
            algorithms=["RS256"],
            options={"verify_aud": False},
        )

        expected_issuer = f"{KEYCLOAK_ISSUER_URL}/realms/{KEYCLOAK_REALM}"
        if claims.get("iss") != expected_issuer:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Keycloak token")

        if KEYCLOAK_AUDIENCE:
            audience = claims.get("aud")
            authorized_party = claims.get("azp")
            aud_values = audience if isinstance(audience, list) else ([audience] if audience else [])
            if KEYCLOAK_AUDIENCE not in aud_values and authorized_party != KEYCLOAK_AUDIENCE:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Keycloak token")

        return claims
    except InvalidTokenError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Keycloak token") from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Failed to validate Keycloak token: %s", exc)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Keycloak token") from exc


def authenticate_password(*, username: str, password: str) -> dict[str, Any]:
    if not enabled():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Keycloak is not enabled")

    payload = {
        "grant_type": "password",
        "client_id": KEYCLOAK_LOGIN_CLIENT_ID,
        "username": username,
        "password": password,
    }

    try:
        response = requests.post(realm_url("protocol/openid-connect/token"), data=payload, timeout=10)
        if response.status_code != 200:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")

        access_token = response.json().get("access_token")
        if not access_token:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")

        claims = verify_access_token(access_token)
        preferred_username = claims.get("preferred_username") or claims.get("username")
        if preferred_username and preferred_username != username:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Keycloak token")

        return claims
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("Keycloak credential check failed for %s: %s", username, exc)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password") from exc


def admin_access_token() -> Optional[str]:
    if not enabled():
        return None

    payload = {
        "grant_type": "password",
        "client_id": "admin-cli",
        "username": KEYCLOAK_ADMIN_USERNAME,
        "password": KEYCLOAK_ADMIN_PASSWORD,
    }

    try:
        response = requests.post(master_url("protocol/openid-connect/token"), data=payload, timeout=10)
        response.raise_for_status()
        token = response.json().get("access_token")
        if not token:
            raise ValueError("missing access_token")
        return token
    except Exception as exc:
        logger.warning("Unable to obtain Keycloak admin token: %s", exc)
        return None


def _admin_headers() -> dict[str, str]:
    token = admin_access_token()
    if not token:
        return {}
    return {"Authorization": f"Bearer {token}"}


def _admin_request(method: str, path: str, **kwargs) -> requests.Response:
    headers = kwargs.pop("headers", {})
    headers.update(_admin_headers())
    response = requests.request(
        method,
        f"{KEYCLOAK_BASE_URL}{path}",
        headers=headers,
        timeout=10,
        **kwargs,
    )
    response.raise_for_status()
    return response


def _find_user(username: str) -> Optional[dict[str, Any]]:
    response = _admin_request(
        "GET",
        f"/admin/realms/{KEYCLOAK_REALM}/users",
        params={"username": username, "exact": "true"},
    )
    users = response.json()
    if not users:
        return None
    return users[0]


def _find_user_id(username: str) -> Optional[str]:
    user = _find_user(username)
    if not user:
        return None
    return user.get("id")


def sync_user_exists(username: str) -> bool:
    if not enabled():
        return False
    try:
        return _find_user_id(username) is not None
    except Exception as exc:
        logger.warning("Keycloak user lookup failed for %s: %s", username, exc)
        return False


def sync_user_active(username: str) -> bool:
    if not enabled():
        return False
    try:
        user = _find_user(username)
        return bool(user and user.get("enabled") is True)
    except Exception as exc:
        logger.warning("Keycloak user status lookup failed for %s: %s", username, exc)
        return False


def sync_user_created(*, username: str, email: str, password: str, tenant_slug: str, display_name: Optional[str], designation: Optional[str]) -> bool:
    if not sync_enabled():
        return True

    try:
        if _find_user_id(username):
            raise ValueError("Keycloak user already exists")

        payload: dict[str, Any] = {
            "username": username,
            "email": email,
            "enabled": True,
            "emailVerified": True,
            "firstName": display_name or username,
            "attributes": {
                "tenant_slug": [tenant_slug],
            },
        }
        if designation:
            payload["attributes"]["designation"] = [designation]

        response = _admin_request("POST", f"/admin/realms/{KEYCLOAK_REALM}/users", json=payload)
        location = response.headers.get("Location", "")
        user_id = location.rstrip("/").split("/")[-1] if location else _find_user_id(username)
        if not user_id:
            raise RuntimeError("Keycloak user id could not be resolved")

        _admin_request(
            "PUT",
            f"/admin/realms/{KEYCLOAK_REALM}/users/{user_id}/reset-password",
            json={"type": "password", "value": password, "temporary": False},
        )
        return True
    except Exception as exc:
        logger.warning("Keycloak provisioning failed for %s: %s", username, exc)
        return False


def sync_user_updated(*, username: str, email: Optional[str], display_name: Optional[str], designation: Optional[str], active: Optional[bool] = None) -> bool:
    if not sync_enabled():
        return True

    try:
        user_id = _find_user_id(username)
        if not user_id:
            raise RuntimeError("Keycloak user not found")

        payload: dict[str, Any] = {"username": username}
        if email is not None:
            payload["email"] = email
        if display_name is not None:
            payload["firstName"] = display_name
        if designation is not None:
            payload.setdefault("attributes", {})["designation"] = [designation]
        if active is not None:
            payload["enabled"] = active

        _admin_request("PUT", f"/admin/realms/{KEYCLOAK_REALM}/users/{user_id}", json=payload)
        return True
    except Exception as exc:
        logger.warning("Keycloak user update failed for %s: %s", username, exc)
        return False


def sync_user_password_reset(*, username: str, password: str) -> bool:
    if not sync_enabled():
        return True

    try:
        user_id = _find_user_id(username)
        if not user_id:
            raise RuntimeError("Keycloak user not found")

        _admin_request(
            "PUT",
            f"/admin/realms/{KEYCLOAK_REALM}/users/{user_id}/reset-password",
            json={"type": "password", "value": password, "temporary": False},
        )
        return True
    except Exception as exc:
        logger.warning("Keycloak password reset failed for %s: %s", username, exc)
        return False


def sync_user_disable(*, username: str) -> bool:
    return sync_user_updated(username=username, email=None, display_name=None, designation=None, active=False)


def sync_user_enable(*, username: str) -> bool:
    return sync_user_updated(username=username, email=None, display_name=None, designation=None, active=True)


def sync_user_deleted(*, username: str) -> bool:
    return sync_user_disable(username=username)


def sync_user_delete_permanent(*, username: str) -> bool:
    if not sync_enabled():
        return True

    try:
        user_id = _find_user_id(username)
        if not user_id:
            return True

        _admin_request("DELETE", f"/admin/realms/{KEYCLOAK_REALM}/users/{user_id}")
        return True
    except Exception as exc:
        logger.warning("Keycloak permanent delete failed for %s: %s", username, exc)
        return False
