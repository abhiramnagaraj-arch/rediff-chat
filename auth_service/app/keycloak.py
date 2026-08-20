import logging
from functools import lru_cache
from typing import Any, Optional
from urllib.parse import urljoin
import re

import jwt
import requests
from fastapi import HTTPException, status
from jwt import InvalidTokenError, PyJWKClient

logger = logging.getLogger(__name__)

KEYCLOAK_BASE_URL = "http://rediff_keycloak:8080"
KEYCLOAK_ISSUER_URL = "http://localhost:18080"
KEYCLOAK_REALM = "rediff"
KEYCLOAK_ADMIN_USERNAME = "admin"
KEYCLOAK_ADMIN_PASSWORD = ""
KEYCLOAK_LOGIN_CLIENT_ID = "rediff-web"
KEYCLOAK_AUDIENCE = ""
KEYCLOAK_ENABLED = "true"
KEYCLOAK_SYNC_ENABLED = "true"
ALLOWED_XMPP_VHOSTS = "v1.chat.rediff.com,v2.chat.rediff.com,v3.chat.rediff.com,v4.chat.rediff.com"


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
ALLOWED_XMPP_VHOSTS = _env("ALLOWED_XMPP_VHOSTS", ALLOWED_XMPP_VHOSTS)


def enabled() -> bool:
    return KEYCLOAK_ENABLED and bool(KEYCLOAK_BASE_URL and KEYCLOAK_ISSUER_URL and KEYCLOAK_REALM)


def sync_enabled() -> bool:
    return enabled() and KEYCLOAK_SYNC_ENABLED


def allowed_vhosts() -> tuple[str, ...]:
    return tuple(vhost.strip() for vhost in ALLOWED_XMPP_VHOSTS.split(",") if vhost.strip())


def is_allowed_vhost(server: str) -> bool:
    return server in allowed_vhosts()


def validate_xmpp_username(username: str) -> bool:
    return bool(re.fullmatch(r"[a-z0-9]+(?:[._-][a-z0-9]+)*\.[a-z0-9]+(?:[._-][a-z0-9]+)*", username))


def keycloak_username(username: str, server: str) -> str:
    return f"{username}@{server}"


def tenant_slug_from_username(username: str) -> str:
    if "." in username:
        return username.split(".", 1)[0]
    return username


def assigned_vhost_from_username(username: str) -> Optional[str]:
    if "@" not in username:
        return None
    return username.rsplit("@", 1)[1]


def display_last_name(username: str) -> str:
    localpart = username.split("@", 1)[0]
    if "." in localpart:
        return localpart.split(".", 1)[1]
    return localpart


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

        token_issuer = claims.get("iss")
        expected_issuers = {
            f"{KEYCLOAK_ISSUER_URL}/realms/{KEYCLOAK_REALM}",
            f"{KEYCLOAK_BASE_URL}/realms/{KEYCLOAK_REALM}",
        }
        if token_issuer not in expected_issuers:
            logger.warning("Invalid Keycloak token issuer: %s expected one of %s", token_issuer, sorted(expected_issuers))
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

        # For the password-grant flow, Keycloak returning 200 already proves the
        # submitted credentials are valid. Decode the returned JWT locally so we
        # can still inspect identity claims without introducing another failure
        # point in the XMPP auth path.
        claims = jwt.decode(
            access_token,
            options={
                "verify_signature": False,
                "verify_aud": False,
                "verify_exp": False,
            },
            algorithms=["RS256"],
        )

        token_username = claims.get("preferred_username") or claims.get("username")
        if token_username and token_username != username:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Keycloak token")

        return claims
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("Keycloak credential check failed for %s: %s", username, exc)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password") from exc


def password_access_token(*, username: str, password: str) -> str:
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

        claims = jwt.decode(
            access_token,
            options={
                "verify_signature": False,
                "verify_aud": False,
                "verify_exp": False,
            },
            algorithms=["RS256"],
        )
        token_username = claims.get("preferred_username") or claims.get("username")
        if token_username and token_username != username:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Keycloak token")

        return access_token
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("Keycloak token request failed for %s: %s", username, exc)
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


def _normalize_attribute_value(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value if item is not None and str(item) != ""]
    if isinstance(value, tuple):
        return [str(item) for item in value if item is not None and str(item) != ""]
    text = str(value)
    return [text] if text else []


def normalize_attributes(attributes: Any) -> dict[str, list[str]]:
    if not isinstance(attributes, dict):
        return {}
    normalized: dict[str, list[str]] = {}
    for key, value in attributes.items():
        values = _normalize_attribute_value(value)
        if values:
            normalized[str(key)] = values
    return normalized


def required_user_attributes(username: str, designation: Optional[str] = None) -> dict[str, list[str]]:
    attributes = {
        "tenant_slug": [tenant_slug_from_username(username)],
    }
    assigned_vhost = assigned_vhost_from_username(username)
    if assigned_vhost:
        attributes["assigned_vhost"] = [assigned_vhost]
    if designation:
        attributes["designation"] = [designation]
    return attributes


def merge_user_attributes(username: str, existing: Any, designation: Optional[str] = None) -> dict[str, list[str]]:
    attributes = normalize_attributes(existing)
    attributes.update(required_user_attributes(username, designation=designation))
    if designation is not None:
        if designation:
            attributes["designation"] = [designation]
        else:
            attributes.pop("designation", None)
    return attributes


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


def get_user_by_id(user_id: str) -> Optional[dict[str, Any]]:
    if not enabled():
        return None
    try:
        response = _admin_request("GET", f"/admin/realms/{KEYCLOAK_REALM}/users/{user_id}")
        return response.json()
    except Exception as exc:
        logger.warning("Keycloak user fetch by id failed for %s: %s", user_id, exc)
        return None


def _full_user_from_summary(user: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    if not user:
        return None
    user_id = user.get("id")
    if not user_id:
        return user
    return get_user_by_id(str(user_id)) or user


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


def sync_user_created(*, username: str, email: str, password: str, display_name: Optional[str], designation: Optional[str]) -> bool:
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
            "lastName": display_last_name(username),
            "attributes": required_user_attributes(username, designation=designation),
        }

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
        current = _full_user_from_summary(_find_user(username))
        if not current:
            raise RuntimeError("Keycloak user not found")
        user_id = current.get("id")
        if not user_id:
            raise RuntimeError("Keycloak user id missing")

        payload: dict[str, Any] = {
            "username": username,
            "email": email if email is not None else current.get("email"),
            "enabled": active if active is not None else current.get("enabled", True),
            "emailVerified": current.get("emailVerified", True),
            "firstName": display_name if display_name is not None else current.get("firstName"),
            "lastName": display_last_name(username),
            "attributes": merge_user_attributes(username, current.get("attributes"), designation=designation),
        }

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


def sync_user_update_by_id(*, user_id: str, email: Optional[str], display_name: Optional[str], designation: Optional[str], active: Optional[bool] = None) -> bool:
    if not sync_enabled():
        return True

    try:
        user = get_user_by_id(user_id)
        if not user:
            raise RuntimeError("Keycloak user not found")

        username = user.get("username")
        if not username:
            raise RuntimeError("Keycloak username missing")
        payload: dict[str, Any] = {
            "username": username,
            "email": email if email is not None else user.get("email"),
            "enabled": active if active is not None else user.get("enabled", True),
            "emailVerified": user.get("emailVerified", True),
            "firstName": display_name if display_name is not None else user.get("firstName"),
            "lastName": display_last_name(username),
            "attributes": merge_user_attributes(username, user.get("attributes"), designation=designation),
        }

        _admin_request("PUT", f"/admin/realms/{KEYCLOAK_REALM}/users/{user_id}", json=payload)
        return True
    except Exception as exc:
        logger.warning("Keycloak user update failed for %s: %s", user_id, exc)
        return False


def sync_user_password_reset_by_id(*, user_id: str, password: str) -> bool:
    if not sync_enabled():
        return True

    try:
        if not get_user_by_id(user_id):
            raise RuntimeError("Keycloak user not found")

        _admin_request(
            "PUT",
            f"/admin/realms/{KEYCLOAK_REALM}/users/{user_id}/reset-password",
            json={"type": "password", "value": password, "temporary": False},
        )
        return True
    except Exception as exc:
        logger.warning("Keycloak password reset failed for %s: %s", user_id, exc)
        return False


def sync_user_delete_by_id(*, user_id: str) -> bool:
    if not sync_enabled():
        return True

    try:
        if not get_user_by_id(user_id):
            return True
        _admin_request("DELETE", f"/admin/realms/{KEYCLOAK_REALM}/users/{user_id}")
        return True
    except Exception as exc:
        logger.warning("Keycloak delete by id failed for %s: %s", user_id, exc)
        return False


def get_user(username: str) -> Optional[dict[str, Any]]:
    if not enabled():
        return None
    try:
        return _full_user_from_summary(_find_user(username))
    except Exception as exc:
        logger.warning("Keycloak user fetch failed for %s: %s", username, exc)
        return None


def _first_attribute(attributes: dict[str, list[str]], key: str) -> Optional[str]:
    value = attributes.get(key) or []
    return value[0] if value else None


def _user_display_name(user: dict[str, Any], username: str) -> str:
    first_name = str(user.get("firstName") or "").strip()
    last_name = str(user.get("lastName") or "").strip()
    full_name = " ".join(part for part in [first_name, last_name] if part).strip()
    if full_name:
        return full_name
    return username.split("@", 1)[0]


def search_active_users_for_tenant(query: str, tenant_slug: str, assigned_vhost: Optional[str] = None, limit: int = 20) -> list[dict[str, Any]]:
    if not enabled():
        return []

    search = query.strip()
    if not search:
        return []

    try:
        response = _admin_request(
            "GET",
            f"/admin/realms/{KEYCLOAK_REALM}/users",
            params={"search": search, "max": max(limit * 3, limit)},
        )
        users = response.json()
    except Exception as exc:
        logger.warning("Keycloak tenant user search failed for %s: %s", tenant_slug, exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Unable to search users") from exc

    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    search_lower = search.lower()

    for summary in users:
        if len(results) >= limit:
            break

        user = _full_user_from_summary(summary)
        if not user or user.get("enabled") is not True:
            continue

        username = str(user.get("username") or "").strip().lower()
        if not username or username in seen:
            continue

        attrs = normalize_attributes(user.get("attributes"))
        user_tenant = _first_attribute(attrs, "tenant_slug") or tenant_slug_from_username(username.split("@", 1)[0])
        if user_tenant != tenant_slug:
            continue

        user_vhost = _first_attribute(attrs, "assigned_vhost") or assigned_vhost_from_username(username)
        if assigned_vhost and user_vhost != assigned_vhost:
            continue

        if "@" in username:
            jid = username
        elif user_vhost:
            jid = keycloak_username(username, user_vhost)
        else:
            continue

        display_name = _user_display_name(user, username)
        email = user.get("email")
        haystack = " ".join(str(value or "") for value in [jid, display_name, email]).lower()
        if search_lower not in haystack:
            continue

        seen.add(username)
        results.append(
            {
                "jid": jid,
                "display_name": display_name,
                "email": email,
                "tenant": user_tenant,
            }
        )

    return results
