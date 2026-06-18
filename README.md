# Rediff Enterprise Chat (Edjabberd)

An enterprise-grade, multi-tenant XMPP messaging platform. This project decouples Ejabberd's traditional identity management and delegates authentication to a custom PostgreSQL-backed FastAPI microservice.

## 🏗 Architecture Overview

This platform is built on a 3-tier architecture:
1. **Messaging Layer**: A 3-node active-active Ejabberd cluster (`rediff_ejabberd_a/b/c`) handling XMPP routing and WebSockets.
2. **Identity & Auth API**: A stateless FastAPI microservice (`auth_service`) that securely verifies user credentials using Bcrypt.
3. **Database Layer**: PostgreSQL (`rediff_postgres`) acts as the ultimate source of truth for users and multi-tenant mapping.

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
* 3 Ejabberd Nodes (Ports `5222`, `5223`, `5224` for XMPP TCP, and `5280`, `5281`, `5282` for WebSockets)

### 4. Verify Services

Check that all containers are healthy:
```bash
docker compose ps
```

You can view the logs for the external auth bridge to see logins:
```bash
docker compose logs -f rediff_ejabberd_a
```

## 📁 Repository Structure

* `/docs` - Architecture documentation and diagrams.
* `/ejabberd` - Ejabberd server config (`ejabberd.yml`), Dockerfile, and the custom `extauth.py` Python bridge.
* `/auth_service` - FastAPI application for user identity and authentication.
* `/postgres` - SQL schemas (`pg.sql`) and database initialization.
* `/scripts` - Utilities for debugging and seeding data.
* `/certs` - Local TLS certificates (ignored by Git).
