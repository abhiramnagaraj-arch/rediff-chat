# Rediff Enterprise Chat (Edjabberd)

An enterprise-grade, multi-tenant XMPP messaging platform. This project now uses Keycloak as the source of truth for identity, while Ejabberd still handles XMPP session routing and tenant isolation.

## 🏗 Architecture Overview

This platform is built on a 3-tier architecture:
1. **Load Balancing**: HAProxy (`rediff_haproxy`) acts as the front-door, distributing XMPP C2S and HTTP/WebSocket traffic across the cluster.
2. **Messaging Layer**: A 3-node active-active Ejabberd cluster (`rediff_ejabberd_a/b/c`) handling XMPP routing. It includes a custom Erlang module (`mod_tenant_isolate`) that enforces strict tenant boundaries, including dynamic Multi-User Chat (MUC) isolation via distributed Mnesia.
3. **Identity Provider**: Keycloak (`rediff_keycloak`) provides OIDC login, token verification, and identity lifecycle support.
4. **Identity & Auth API**: A FastAPI microservice (`auth_service`) that provisions users into Keycloak, validates Keycloak tokens, and bridges ejabberd external auth to Keycloak.
5. **Database Layer**: PostgreSQL (`rediff_postgres`) stores tenant mapping, profile data, and app metadata. Passwords live in Keycloak.

For detailed architecture diagrams, flows, and schema, please see the `docs/comprehensive_architecture.md` file.

## 🚀 Getting Started

### Prerequisites
* Docker
* Docker Compose
* Python 3.10+ (Optional, for running tests/scripts locally)

### 1. Environment Setup

Copy the example environment file and configure your secure database passwords:
```bash
cp postgres/.env.example postgres/.env
```
*(Note: `.env` is ignored by Git to prevent secrets from being committed.)*

### 2. TLS Certificates

For Ejabberd to accept client connections, it requires a TLS certificate.
Place your certificate at `certs/server.pem`. If you don't have one for local development, the Ejabberd Dockerfile will automatically generate a self-signed certificate, but the volume mount in `docker-compose.yml` expects a file. 

To generate a quick self-signed certificate for local dev:
```bash
mkdir -p certs
openssl req -x509 -nodes -newkey rsa:2048 -keyout certs/server.key -out certs/server.crt -days 3650 -subj "/CN=chat.rediff.com"
cat certs/server.key certs/server.crt > certs/server.pem
```

### 3. Start the Cluster

Boot the entire platform using Docker Compose:
```bash
docker compose up -d
```

This will start:
* PostgreSQL on port `5433` (mapped from 5432)
* Auth API on port `8000`
* Keycloak on port `18080`
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
python3 scripts/test_keycloak_oidc.py
```

## 📁 Repository Structure

* `/docs` - Architecture documentation and diagrams.
* `/ejabberd` - Ejabberd server config (`ejabberd.yml`), Dockerfile, `extauth.py` Python bridge, and custom Erlang modules (`mod_tenant_isolate.erl`).
* `/haproxy` - Configuration for the HAProxy load balancer.
* `/keycloak` - Realm import files for the Keycloak identity provider.
* `/auth_service` - FastAPI application for user identity and authentication.
* `/postgres` - SQL schemas (`pg.sql`) and database initialization.
* `/scripts` - Utilities for debugging and seeding data.
* `/certs` - Local TLS certificates (ignored by Git).
