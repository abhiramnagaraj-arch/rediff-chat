# Rediff Enterprise Chat (Edjabberd)

An enterprise-grade, multi-tenant XMPP messaging platform. This project now uses Keycloak as the source of truth for identity, while Ejabberd still handles XMPP session routing and tenant isolation.

## 🏗 Architecture Overview

This platform is built on a 3-tier architecture:
1. **Load Balancing**: HAProxy (`rediff_haproxy`) acts as the front-door, distributing XMPP C2S and HTTP/WebSocket traffic across the cluster.
2. **Messaging Layer**: A 3-node active-active Ejabberd cluster (`rediff_ejabberd_a/b/c`) handling XMPP routing. It includes a custom Erlang module (`mod_tenant_isolate`) that enforces strict tenant boundaries, including dynamic Multi-User Chat (MUC) isolation via distributed Mnesia.
3. **Identity Provider**: Keycloak (`rediff_keycloak`) provides OIDC login, token verification, and identity lifecycle support.
4. **Identity & Auth API**: A FastAPI microservice (`auth_service`) that provisions users into Keycloak, validates Keycloak tokens, and bridges ejabberd external auth to Keycloak.
5. **Database Layer**: PostgreSQL (`rediff_postgres`) stores the per-vhost Ejabberd SQL state. Passwords live in Keycloak.

For detailed architecture diagrams, flows, and schema, please see the `docs/comprehensive_architecture.md` file.

## 🚀 Getting Started

### Prerequisites
* Docker
* Docker Compose
* Python 3.10+ (Optional, for running tests/scripts locally)

### 1. Environment Setup

Copy the example environment files and configure your secrets:
```bash
cp .env.example .env
cp postgres/.env.example postgres/.env
```
Set a strong `KEYCLOAK_ADMIN_PASSWORD` and `AUTH_SERVICE_ADMIN_TOKEN` in the root `.env`.
*(Note: `.env` files are ignored by Git to prevent secrets from being committed.)*

### 2. TLS Certificates

For Ejabberd to accept client connections, it requires a TLS certificate.
Place your certificate at `certs/server.pem`. If you don't have one for local development, the Ejabberd Dockerfile will automatically generate a self-signed certificate, but the volume mount in `docker-compose.yml` expects a file. 

To generate a quick self-signed certificate for local dev:
```bash
mkdir -p certs
openssl req -x509 -nodes -newkey rsa:2048 -keyout certs/server.key -out certs/server.crt -days 3650 -subj "/CN=v1.chat.rediff.com"
cat certs/server.key certs/server.crt > certs/server.pem
```

### 3. Start the Cluster

Boot the entire platform using Docker Compose:
```bash
docker compose up -d
```

This will start:
* PostgreSQL on port `5433` (mapped from 5432)
* Auth API on `127.0.0.1:8000`
* Keycloak on `127.0.0.1:18080`
* Converse.js web chat on `http://127.0.0.1:8081`
* HAProxy Load Balancer exposing unified ports:
  * `5222` (XMPP C2S)
  * `5280` (XMPP WebSockets/HTTP)
  * `8404` (HAProxy Stats Dashboard)
* 3 Ejabberd Nodes running internally (load balanced by HAProxy)

### 4. Verify Services

Check that all containers are healthy:
```bash
docker compose ps
```

You can view the logs for the external auth bridge to see logins:
```bash
docker compose logs -f rediff_ejabberd_a
```

To test Keycloak token issuance and auth-service token validation:
```bash
python3 scripts/test_multitenant.py
python3 scripts/test_keycloak_oidc.py --user t1.testuser_xxxxxx@v1.chat.rediff.com --password password123
```

### 5. Use the Web Chat

Open Converse.js at:
```text
http://127.0.0.1:8081
```

Log in with a full tenant JID, for example `t1.u1@v1.chat.rediff.com`, and the user's Keycloak password. The page connects to HAProxy on `ws://<browser-host>:5280/ws` and falls back to `http://<browser-host>:5280/bosh`.

Useful local variants:
```text
http://127.0.0.1:8081/?domain=v1.chat.rediff.com
http://127.0.0.1:8081/?xmppHost=localhost:5280
```

## 📁 Repository Structure

* `/docs` - Architecture documentation and diagrams.
* `/ejabberd` - Ejabberd server config (`ejabberd.yml`), Dockerfile, `extauth.py` Python bridge, and custom Erlang modules (`mod_tenant_isolate.erl`).
* `/haproxy` - Configuration for the HAProxy load balancer.
* `/converse.js` - Converse.js web chat client and Rediff-specific entrypoint (`rediff-chat.html`).
* `/keycloak` - Realm import files for the Keycloak identity provider.
* `/auth_service` - FastAPI application for user identity and authentication.
* `/postgres` - SQL schemas (`pg.sql`) and database initialization.
* `/scripts` - Utilities for debugging and integration tests.
* `/certs` - Local TLS certificates (ignored by Git).
