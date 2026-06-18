-- =======================================================
-- MIGRATION: ADD MULTI-TENANCY SUPPORT
-- =======================================================

-- 1. Create the tenants table
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    domain VARCHAR UNIQUE NOT NULL,
    name VARCHAR NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Populate basic tenants based on our known virtual hosts
INSERT INTO tenants (domain, name) VALUES 
('wipro.chat', 'Wipro'),
('infosys.chat', 'Infosys'),
('tcs.chat', 'TCS'),
('ibm.chat', 'IBM'),
('chat.rediff.com', 'Rediff Chat')
ON CONFLICT (domain) DO NOTHING;

-- 3. Add tenant_id to users and set it to a default or based on email domain
ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;

-- Attempt to link existing users to tenants based on their email domains
UPDATE users u
SET tenant_id = t.id
FROM tenants t
WHERE u.email LIKE '%' || t.domain;

-- For any users that didn't match, map them to chat.rediff.com as a fallback
UPDATE users 
SET tenant_id = (SELECT id FROM tenants WHERE domain = 'chat.rediff.com')
WHERE tenant_id IS NULL;

-- Now that all users have a tenant, we can make it NOT NULL
ALTER TABLE users ALTER COLUMN tenant_id SET NOT NULL;

-- 4. Add tenant_id to archive and audit tables
ALTER TABLE message_archive ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE message_receipts ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;

-- 5. Add necessary indexes for scaling cross-tenant queries
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_message_archive_tenant ON message_archive(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON audit_log(tenant_id);

-- Optional: Create a constraint function to ensure message routing matches the sender's tenant
-- But since Ejabberd is enforcing this at the routing layer, it's not strictly necessary here,
-- though it adds defense-in-depth at the database level.
