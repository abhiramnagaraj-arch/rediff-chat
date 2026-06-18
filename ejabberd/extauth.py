#!/usr/bin/env python3

import sys
import struct
import os
import requests
import logging

AUTH_SERVICE_URL = os.getenv("AUTH_SERVICE_URL", "http://rediff_auth_service:8000")

logger = logging.getLogger("extauth")
logger.setLevel(logging.DEBUG)
_handler = logging.StreamHandler(sys.stderr)
_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s: %(message)s"))
logger.addHandler(_handler)
logger.propagate = False

def read_from_ejabberd():
    try:
        # Read the first 2 bytes (length of the command)
        length_bytes = sys.stdin.buffer.read(2)
        if not length_bytes:
            return None
        length = struct.unpack('>H', length_bytes)[0]
        # Read the actual command
        command_bytes = sys.stdin.buffer.read(length)
        if len(command_bytes) != length:
            return None
        command = command_bytes.decode('utf-8')
        return command
    except Exception as e:
        logger.error(f"Error reading from ejabberd: {e}")
        return None

def write_to_ejabberd(result):
    try:
        # Result is 1 for success/true, 0 for failure/false
        # We write 2 bytes length (always 2 for the result), then the result as a 2-byte short
        sys.stdout.buffer.write(struct.pack('>HH', 2, result))
        sys.stdout.buffer.flush()
    except Exception as e:
        logger.error(f"Error writing to ejabberd: {e}")

def handle_command(command):
    if command.startswith('auth:'):
        # auth:User:Server:Password
        parts = command.split(':', 3)
        if len(parts) == 4:
            _, user, server, password = parts
            logger.info(f"Authenticating user {user}@{server}")
            try:
                response = requests.post(
                    f"{AUTH_SERVICE_URL}/auth",
                    json={"user": user, "server": server, "password": password},
                    timeout=5
                )
                if response.status_code == 200 and response.json().get('success'):
                    logger.info("Auth successful")
                    return 1
                else:
                    logger.warning("Auth failed")
                    return 0
            except Exception as e:
                logger.error(f"Auth request exception: {e}")
                return 0
        return 0
    elif command.startswith('isuser:'):
        # isuser:User:Server
        parts = command.split(':', 2)
        if len(parts) == 3:
            _, user, server = parts
            logger.info(f"Checking if user exists: {user}@{server}")
            try:
                response = requests.get(
                    f"{AUTH_SERVICE_URL}/users/{user}?domain={server}",
                    timeout=5
                )
                if response.status_code == 200 and response.json().get('success'):
                    return 1
                else:
                    return 0
            except Exception as e:
                logger.error(f"IsUser request exception: {e}")
                return 0
        return 0
    elif command.startswith('setpass:'):
        # We don't support setting passwords from ejabberd natively here
        # Passwords should be set via the Rediff User Service
        return 0
    elif command.startswith('tryregister:'):
        # We don't support registering users from ejabberd natively here
        return 0
    elif command.startswith('removeuser:'):
        # Temporarily return 1 to unblock Gajim UI. No DB changes made.
        return 1
    elif command.startswith('removeuser3:'):
        return 1

    logger.debug(f"Received unsupported command: {command}")
    return 0

def main():
    logger.info("extauth script started")
    while True:
        command = read_from_ejabberd()
        if command is None:
            break
        result = handle_command(command)
        write_to_ejabberd(result)

if __name__ == "__main__":
    main()
