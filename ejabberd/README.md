# Rediff Chat Local Stack

This directory contains the runnable entrypoint for the current stack.

## Start

```bash
docker compose up --build
```

## Services

- ejabberd: `5222`, `5280`, `5444`
- auth service: `8000`
- postgres: `5433 -> 5432`

## Notes

- The ejabberd container uses external auth through the FastAPI service.
- PostgreSQL is used by the auth service only in this runnable baseline.
- The runtime config is the shared `../ejabberd.yml` at the repo root.
