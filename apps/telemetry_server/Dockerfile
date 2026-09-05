# Build context is the repo root (see docker-compose.yml `context: ../..`).
FROM python:3.12-slim

WORKDIR /srv

# Server deps + the PostgreSQL driver (prod uses postgres).
COPY apps/telemetry_server/requirements.txt /srv/requirements.txt
RUN pip install --no-cache-dir -r /srv/requirements.txt "psycopg[binary]>=3.1"

# The collection server is self-contained (no superclaw kernel import).
COPY apps/__init__.py /srv/apps/__init__.py
COPY apps/telemetry_server /srv/apps/telemetry_server

EXPOSE 8900
CMD ["uvicorn", "--factory", "apps.telemetry_server.main:create_app", \
     "--host", "0.0.0.0", "--port", "8900"]
