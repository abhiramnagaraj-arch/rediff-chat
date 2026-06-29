import sys
import uuid
import os

import requests

BASE_URL = "http://localhost:8000"
PASSWORD = "password123"
ADMIN_TOKEN = os.getenv("AUTH_SERVICE_ADMIN_TOKEN", "")


def create_user(username: str, domain: str, email: str) -> dict:
    payload = {
        "username": username,
        "email": email,
        "password": PASSWORD,
        "domain": domain,
        "display_name": f"{username} on {domain}",
    }
    response = requests.post(
        f"{BASE_URL}/users",
        json=payload,
        headers={"Authorization": f"Bearer {ADMIN_TOKEN}"},
        timeout=10,
    )
    response.raise_for_status()
    return response.json()


def auth_user(username: str, domain: str, password: str = PASSWORD) -> bool:
    response = requests.post(
        f"{BASE_URL}/auth",
        json={"username": username, "domain": domain, "password": password},
        timeout=10,
    )
    response.raise_for_status()
    return bool(response.json().get("success"))


def main() -> int:
    print("=== Testing vhost-scoped Keycloak auth ===\n")
    if not ADMIN_TOKEN:
        print("[-] AUTH_SERVICE_ADMIN_TOKEN is required")
        return 1

    localpart = f"t1.testuser_{uuid.uuid4().hex[:6]}"
    vhost_a = "v1.chat.rediff.com"
    vhost_b = "v2.chat.rediff.com"

    user_a = create_user(localpart, vhost_a, f"{localpart}@{vhost_a}")
    print(f"[+] Created {user_a['username']} for {vhost_a}")

    user_b = create_user(localpart, vhost_b, f"{localpart}@{vhost_b}")
    print(f"[+] Created {user_b['username']} for {vhost_b}")

    if not auth_user(localpart, vhost_a):
        print(f"[-] Auth failed for {localpart}@{vhost_a}")
        return 1
    print(f"[+] Auth succeeded for {localpart}@{vhost_a}")

    if not auth_user(localpart, vhost_b):
        print(f"[-] Auth failed for {localpart}@{vhost_b}")
        return 1
    print(f"[+] Auth succeeded for {localpart}@{vhost_b}")

    wrong_password_ok = auth_user(localpart, vhost_a, password="wrong-password")
    if wrong_password_ok:
        print("[-] Wrong password unexpectedly succeeded")
        return 1
    print("[+] Wrong password failed as expected")

    print("\n=== Vhost auth flow is working ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
