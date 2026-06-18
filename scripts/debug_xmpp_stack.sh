#!/usr/bin/env bash
set -u

COMPOSE_FILE="${COMPOSE_FILE:-ejabberd/docker-compose.yml}"
AUTH_SERVICE_URL="${AUTH_SERVICE_URL:-http://localhost:8000}"
EJABBERD_CONTAINER="${EJABBERD_CONTAINER:-rediff_ejabberd}"
AUTH_CONTAINER="${AUTH_CONTAINER:-rediff_auth_service}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-rediff_postgres}"
USER_NAME="${USER_NAME:-alice}"
PASSWORD="${PASSWORD:-password123}"
HOST_NAME="${HOST_NAME:-localhost}"

pass_count=0
fail_count=0

section() {
  printf '\n=== %s ===\n' "$1"
}

ok() {
  printf '[OK] %s\n' "$1"
  pass_count=$((pass_count + 1))
}

warn() {
  printf '[WARN] %s\n' "$1"
}

fail() {
  printf '[FAIL] %s\n' "$1"
  fail_count=$((fail_count + 1))
}

run_cmd() {
  printf '$ %s\n' "$*"
  if "$@"; then
    return 0
  fi
  return 1
}

check_docker_container() {
  local name="$1"
  local health
  if ! docker inspect "$name" >/dev/null 2>&1; then
    fail "Container not found: $name"
    return 1
  fi

  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$name" 2>/dev/null || true)"
  if [ "$health" = "healthy" ] || [ "$health" = "no-healthcheck" ]; then
    ok "$name is reachable ($health)"
  else
    warn "$name health is $health"
  fi
}

section "Docker Services"
check_docker_container "$POSTGRES_CONTAINER"
check_docker_container "$AUTH_CONTAINER"
check_docker_container "$EJABBERD_CONTAINER"

section "FastAPI Health"
printf '$ curl -sS %s/health\n' "$AUTH_SERVICE_URL"
auth_health="$(curl -sS "$AUTH_SERVICE_URL/health" 2>/dev/null || true)"
printf '%s\n' "$auth_health"
AUTH_HEALTH_JSON="$auth_health" python3 - <<'PY'
import json
import os
import sys
try:
    obj = json.loads(os.environ["AUTH_HEALTH_JSON"])
except Exception:
    sys.exit(1)
sys.exit(0 if obj.get("status") == "ok" and obj.get("database") == "ok" else 1)
PY
if [ $? -eq 0 ]; then
  ok "FastAPI /health returned ok"
else
  fail "FastAPI /health did not return expected payload"
fi

section "FastAPI User Lookup"
printf '$ curl -sS %s/users/%s\n' "$AUTH_SERVICE_URL" "$USER_NAME"
user_lookup="$(curl -sS "$AUTH_SERVICE_URL/users/$USER_NAME" 2>/dev/null || true)"
printf '%s\n' "$user_lookup"
USER_LOOKUP_JSON="$user_lookup" python3 - <<'PY'
import json
import os
import sys
try:
    obj = json.loads(os.environ["USER_LOOKUP_JSON"])
except Exception:
    sys.exit(1)
sys.exit(0 if obj.get("success") is True else 1)
PY
if [ $? -eq 0 ]; then
  ok "FastAPI user lookup succeeded for $USER_NAME"
else
  fail "FastAPI user lookup failed for $USER_NAME"
fi

section "FastAPI Authentication"
printf '$ curl -sS -X POST %s/auth -H "Content-Type: application/json" -d ...\n' "$AUTH_SERVICE_URL"
auth_resp="$(curl -sS -X POST "$AUTH_SERVICE_URL/auth" -H 'Content-Type: application/json' -d "{\"username\":\"$USER_NAME\",\"password\":\"$PASSWORD\"}" 2>/dev/null || true)"
printf '%s\n' "$auth_resp"
AUTH_RESP_JSON="$auth_resp" python3 - <<'PY'
import json
import os
import sys
try:
    obj = json.loads(os.environ["AUTH_RESP_JSON"])
except Exception:
    sys.exit(1)
sys.exit(0 if obj.get("success") is True else 1)
PY
if [ $? -eq 0 ]; then
  ok "FastAPI auth succeeded for $USER_NAME"
else
  fail "FastAPI auth failed for $USER_NAME"
fi

section "PostgreSQL Seed Check"
if run_cmd docker exec "$POSTGRES_CONTAINER" psql -U rediff -d rediff_chat -c \
  "select u.username, u.status, ua.account_locked, ua.failed_attempts, (ua.password_hash = crypt('$PASSWORD', ua.password_hash)) as password_matches from users u join user_auth ua on ua.user_id = u.id where u.username = '$USER_NAME';"
then
  ok "PostgreSQL query executed"
else
  fail "PostgreSQL query failed"
fi

section "Standalone extauth.py"
if [ ! -f ejabberd/extauth.py ]; then
  fail "Missing ejabberd/extauth.py"
else
  AUTH_SERVICE_URL="$AUTH_SERVICE_URL" python3 - <<'PY'
import os
import struct
import subprocess
import sys

script = "ejabberd/extauth.py"
tests = [
    ("auth", f"auth:alice:localhost:password123"),
    ("auth_wrong", f"auth:alice:localhost:wrongpass"),
    ("isuser", f"isuser:alice:localhost"),
]

for label, packet in tests:
    p = subprocess.Popen(
        [sys.executable, script],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={**os.environ, "AUTH_SERVICE_URL": os.environ["AUTH_SERVICE_URL"]},
    )
    data = packet.encode("utf-8")
    p.stdin.write(struct.pack(">H", len(data)) + data)
    p.stdin.close()
    raw = p.stdout.read(4)
    err = p.stderr.read().decode("utf-8", "replace")
    if len(raw) == 4:
        result = struct.unpack(">HH", raw)
    else:
        result = ("bad", "bad")
    print(f"TEST={label} RESULT={result}")
    print(err.rstrip())
    print("---")
PY
  if [ $? -eq 0 ]; then
    ok "Standalone extauth.py ran"
  else
    fail "Standalone extauth.py failed"
  fi
fi

section "ejabberd Process Check"
if run_cmd docker exec "$EJABBERD_CONTAINER" sh -lc 'ps -ef | grep "[p]ython3 /home/ejabberd/conf/extauth.py"'
then
  ok "extauth.py process is present inside ejabberd"
else
  warn "No extauth.py process found inside ejabberd"
fi

section "ejabberd Config Check"
if run_cmd docker exec "$EJABBERD_CONTAINER" sh -lc 'grep -n "auth_method\|extauth_program\|auth_use_cache" /home/ejabberd/conf/ejabberd.yml'
then
  ok "ejabberd config keys are present"
else
  fail "Could not inspect ejabberd config"
fi

section "Summary"
printf 'Passed: %d\n' "$pass_count"
printf 'Failed: %d\n' "$fail_count"

if [ "$fail_count" -gt 0 ]; then
  exit 1
fi
