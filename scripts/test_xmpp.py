import socket
import ssl
import base64
import sys
import subprocess
import argparse

def test_xmpp(username, domain, password):
    host = '127.0.0.1'
    port = 5222
    
    print(f"[*] Step 1: Connecting to {host}:{port}...")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(5)
    try:
        sock.connect((host, port))
        print("[+] Connected successfully!")
    except Exception as e:
        print(f"[-] Failed to connect: {e}")
        return
        
    print(f"[*] Step 2: Sending XMPP Stream Header for {domain}...")
    stream_header = f"<?xml version=\"1.0\"?><stream:stream to=\"{domain}\" version=\"1.0\" xmlns=\"jabber:client\" xmlns:stream=\"http://etherx.jabber.org/streams\">".encode('utf-8')
    sock.sendall(stream_header)
    
    try:
        features = sock.recv(4096)
        print(f"[+] Received Features: {features.decode('utf-8')}")
    except Exception as e:
        print(f"\n[-] ERROR: {e}")
        print("\n[*] Dumping the last 50 lines of Ejabberd logs to find the internal Erlang crash...")
        try:
            result = subprocess.run(["docker", "logs", "--tail", "50", "rediff_ejabberd"], capture_output=True, text=True)
            print("\n=== DOCKER LOGS ===")
            print(result.stderr)
            print(result.stdout)
            print("===================\n")
        except Exception as log_e:
            print(f"Failed to fetch logs: {log_e}")
        return
    
    if b"<starttls" in features:
        print("[*] Step 3: Server supports STARTTLS. Upgrading connection...")
        sock.sendall(b"<starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>")
        proceed = sock.recv(4096)
        print(f"[+] Received: {proceed.decode('utf-8')}")
        
        print(f"[*] Step 4: Performing TLS Handshake for {domain}...")
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        secure_sock = context.wrap_socket(sock, server_hostname=domain)
        print("[+] TLS Handshake Successful!")
        
        print("[*] Step 5: Sending secure XMPP Stream Header...")
        secure_sock.sendall(stream_header)
        tls_features = secure_sock.recv(4096)
        print(f"[+] Secure Features: {tls_features.decode('utf-8')}")
        
        print(f"[*] Step 6: Attempting to Authenticate as '{username}'...")
        auth_str = f"\x00{username}\x00{password}".encode('utf-8')
        b64_auth = base64.b64encode(auth_str).decode('utf-8')
        auth_payload = f"<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='PLAIN'>{b64_auth}</auth>".encode('utf-8')
        
        secure_sock.sendall(auth_payload)
        auth_response = secure_sock.recv(4096)
        print(f"[+] Auth Response: {auth_response.decode('utf-8')}")
        
        if b"<success" in auth_response:
            print("\n=========================================")
            print("SUCCESS! ALICE IS FULLY AUTHENTICATED!")
            print("=========================================\n")
        else:
            print("\n[-] AUTHENTICATION FAILED.")
    else:
        print("[-] STARTTLS not supported by server.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Test XMPP Connection and Authentication")
    parser.add_argument("--user", type=str, default="alice", help="Username")
    parser.add_argument("--domain", type=str, default="wipro.chat", help="XMPP Domain")
    parser.add_argument("--password", type=str, default="password123", help="Password")
    args = parser.parse_args()
    
    test_xmpp(args.user, args.domain, args.password)
