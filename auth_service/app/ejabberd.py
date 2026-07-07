import logging
import os
from typing import Any

import requests

logger = logging.getLogger(__name__)

EJABBERD_API_BASE_URL = os.getenv("EJABBERD_API_BASE_URL", "http://rediff_ejabberd_a:5280/api").rstrip("/")
EJABBERD_MUC_SYNC_ENABLED = os.getenv("EJABBERD_MUC_SYNC_ENABLED", "true").lower() not in {"0", "false", "no"}
EJABBERD_API_TIMEOUT = float(os.getenv("EJABBERD_API_TIMEOUT", "5"))


def _split_bare_jid(jid: str) -> tuple[str, str]:
    bare = str(jid or "").split("/", 1)[0].strip().lower()
    if "@" not in bare:
        raise ValueError(f"Invalid JID: {jid}")
    return tuple(bare.rsplit("@", 1))  # type: ignore[return-value]


def _post_command(command: str, payload: dict[str, Any]) -> Any:
    response = requests.post(
        f"{EJABBERD_API_BASE_URL}/{command}",
        json=payload,
        timeout=EJABBERD_API_TIMEOUT,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"ejabberd {command} failed with HTTP {response.status_code}: {response.text}")
    try:
        data = response.json()
    except ValueError:
        data = response.text
    if isinstance(data, dict) and data.get("status") == "error":
        raise RuntimeError(f"ejabberd {command} failed: {data.get('message') or data}")
    return data


def is_missing_room_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return "room doesn't exist" in message or "room doesn't exists" in message or "room not found" in message


def set_room_affiliation(muc_jid: str, member_jid: str, affiliation: str) -> bool:
    if not EJABBERD_MUC_SYNC_ENABLED:
        return False

    room, service = _split_bare_jid(muc_jid)
    user, host = _split_bare_jid(member_jid)
    payload = {
        "room": room,
        "service": service,
        "user": user,
        "host": host,
        "affiliation": affiliation,
    }
    _post_command("set_room_affiliation", payload)
    return True


def remove_room_affiliation(muc_jid: str, member_jid: str) -> bool:
    try:
        return set_room_affiliation(muc_jid, member_jid, "none")
    except Exception as exc:
        if is_missing_room_error(exc):
            logger.info("MUC room %s does not exist while removing %s; backend membership will still be removed", muc_jid, member_jid)
            return False
        logger.warning("Unable to remove MUC affiliation for %s in %s: %s", member_jid, muc_jid, exc)
        raise


def get_room_affiliations(muc_jid: str) -> list[dict[str, Any]] | None:
    if not EJABBERD_MUC_SYNC_ENABLED:
        return None

    room, service = _split_bare_jid(muc_jid)
    try:
        data = _post_command("get_room_affiliations", {"room": room, "service": service})
    except Exception as exc:
        if is_missing_room_error(exc):
            logger.info("MUC room %s does not exist while reading affiliations", muc_jid)
            return None
        logger.warning("Unable to read MUC affiliations for %s: %s", muc_jid, exc)
        return None

    if not isinstance(data, list):
        return None
    return [item for item in data if isinstance(item, dict)]
