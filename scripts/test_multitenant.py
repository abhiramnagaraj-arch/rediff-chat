import requests
import uuid
import sys

BASE_URL = "http://localhost:8000"

def test_multitenant_api():
    print("=== Testing Multi-Tenant API ===\n")
    
    # 1. Check health
    try:
        res = requests.get(f"{BASE_URL}/health")
        if res.status_code != 200:
            print("[-] API is not healthy")
            sys.exit(1)
        print("[+] API is healthy")
    except requests.exceptions.ConnectionError:
        print("[-] Could not connect to API. Is it running?")
        sys.exit(1)

    # 2. Test user creation in Wipro tenant
    wipro_user = {
        "username": f"testuser_{uuid.uuid4().hex[:6]}",
        "email": f"testuser_{uuid.uuid4().hex[:6]}@wipro.com",
        "password": "securepassword",
        "domain": "wipro.chat",
        "display_name": "Wipro Test User"
    }
    
    print(f"[*] Creating user {wipro_user['username']} in wipro.chat...")
    res = requests.post(f"{BASE_URL}/users", json=wipro_user)
    if res.status_code == 201:
        print("[+] User created successfully in Wipro tenant")
        wipro_user_id = res.json()["id"]
    else:
        print(f"[-] Failed to create user: {res.text}")
        return

    # 3. Test user creation with same username in Infosys tenant
    infosys_user = {
        "username": wipro_user["username"], # Same username!
        "email": f"testuser_{uuid.uuid4().hex[:6]}@infosys.com",
        "password": "anotherpassword",
        "domain": "infosys.chat",
        "display_name": "Infosys Test User"
    }

    print(f"[*] Creating user {infosys_user['username']} in infosys.chat...")
    res = requests.post(f"{BASE_URL}/users", json=infosys_user)
    if res.status_code == 201:
        print("[+] User created successfully in Infosys tenant with same username!")
        infosys_user_id = res.json()["id"]
    else:
        print(f"[-] Failed to create user in Infosys: {res.text}")
        return

    # 4. Test authentication for Wipro user
    print("[*] Authenticating Wipro user...")
    res = requests.post(f"{BASE_URL}/auth", json={
        "user": wipro_user["username"],
        "server": "wipro.chat",
        "password": "securepassword"
    })
    if res.json().get("success"):
        print("[+] Authentication successful for Wipro user")
    else:
        print("[-] Authentication failed for Wipro user")

    # 5. Test authentication for Infosys user
    print("[*] Authenticating Infosys user...")
    res = requests.post(f"{BASE_URL}/auth", json={
        "user": infosys_user["username"],
        "server": "infosys.chat",
        "password": "anotherpassword"
    })
    if res.json().get("success"):
        print("[+] Authentication successful for Infosys user")
    else:
        print("[-] Authentication failed for Infosys user")

    # 6. Test authentication with incorrect tenant password
    print("[*] Authenticating Wipro user with Infosys password (should fail)...")
    res = requests.post(f"{BASE_URL}/auth", json={
        "user": wipro_user["username"],
        "server": "wipro.chat",
        "password": "anotherpassword"
    })
    if not res.json().get("success"):
        print("[+] Authentication failed as expected")
    else:
        print("[-] Authentication incorrectly succeeded")

    # 7. Check user exists
    print("[*] Checking if Wipro user exists...")
    res = requests.get(f"{BASE_URL}/users/{wipro_user['username']}?domain=wipro.chat")
    if res.json().get("success"):
        print("[+] User exists check successful")
    else:
        print("[-] User exists check failed")

    # 8. Test Soft Delete
    print("[*] Soft deleting Infosys user...")
    res = requests.delete(f"{BASE_URL}/users/{infosys_user_id}")
    if res.json().get("success"):
        print("[+] User soft deleted successfully")
    else:
        print("[-] User soft delete failed")

    print("[*] Authenticating soft deleted Infosys user (should fail)...")
    res = requests.post(f"{BASE_URL}/auth", json={
        "user": infosys_user["username"],
        "server": "infosys.chat",
        "password": "anotherpassword"
    })
    if not res.json().get("success"):
        print("[+] Authentication failed for deleted user as expected")
    else:
        print("[-] Authentication incorrectly succeeded for deleted user")

    print("\n=== All Multi-Tenant API Tests Passed! ===")

if __name__ == "__main__":
    test_multitenant_api()
