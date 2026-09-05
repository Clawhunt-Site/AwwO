"""SuperClaw telemetry collection server (operator-side).

A standalone, separately-deployable ingest + query service for the remote
telemetry upload pipeline described in
``docs/remote-telemetry-upload-architecture.md``. It is NOT part of the
SuperClaw end-user product surfaces (CLI/Web/Desktop/API) — it is the
operator's own collector. Everything is driven by environment variables so the
same code runs against a local SQLite mock and a production PostgreSQL with no
code change (see ``config.py``).
"""
