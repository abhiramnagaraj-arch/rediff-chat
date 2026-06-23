import argparse
import sys
from urllib.parse import urljoin

import requests


def get_token(base_url: str, realm: str, client_id: str, username: str, password: str) -> str:
    token_url = urljoin(base_url.rstrip("/") + "/", f"realms/{realm}/protocol/openid-connect/token")
    response = requests.post(
        token_url,
        data={
            "grant_type": "password",
            "client_id": client_id,
            "username": username,
            "password": password,
        },
        timeout=10,
    )
    response.raise_for_status()
    token = response.json().get("access_token")
    if not token:
        raise RuntimeError("access_token missing from Keycloak response")
    return token


def main() -> int:
    parser = argparse.ArgumentParser(description="Test Keycloak OIDC token issuance and auth_service verification")
    parser.add_argument("--keycloak", default="http://localhost:18080", help="Keycloak base URL")
    parser.add_argument("--realm", default="rediff", help="Keycloak realm")
    parser.add_argument("--client", default="rediff-web", help="Keycloak client_id")
    parser.add_argument("--user", default="demo.user", help="Keycloak username")
    parser.add_argument("--password", default="password123", help="Keycloak password")
    parser.add_argument("--auth-service", default="http://localhost:8000", help="Auth service base URL")
    args = parser.parse_args()

    try:
        token = get_token(args.keycloak, args.realm, args.client, args.user, args.password)
        print("[+] Keycloak issued an access token")
    except Exception as exc:
        print(f"[-] Failed to get token: {exc}")
        return 1

    try:
        response = requests.get(
            urljoin(args.auth_service.rstrip("/") + "/", "oidc/me"),
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
        )
        print(f"[+] /oidc/me status: {response.status_code}")
        print(response.text)
        return 0 if response.ok else 1
    except Exception as exc:
        print(f"[-] Failed to verify token with auth service: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
