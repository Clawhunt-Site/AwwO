CREATE INDEX IF NOT EXISTS admin_tenants_page ON tenants(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS admin_users_page ON users(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS admin_runs_page ON runs(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS admin_audit_page ON audit_events(created_at DESC,id DESC);
