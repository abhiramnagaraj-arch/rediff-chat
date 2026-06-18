-- 02-multi-tenant.sql

-- 1. Create tenants table
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR NOT NULL,
    domain VARCHAR UNIQUE NOT NULL,
    status VARCHAR NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Modify users table
ALTER TABLE users ADD COLUMN tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;

-- Drop existing unique constraints
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
DROP INDEX IF EXISTS idx_users_username;
DROP INDEX IF EXISTS idx_users_email;

-- Add new composite unique constraints
ALTER TABLE users ADD CONSTRAINT users_tenant_id_username_key UNIQUE (tenant_id, username);
ALTER TABLE users ADD CONSTRAINT users_tenant_id_email_key UNIQUE (tenant_id, email);

CREATE INDEX idx_users_tenant_username ON users(tenant_id, username);
CREATE INDEX idx_users_tenant_email ON users(tenant_id, email);

-- 3. Seed Tenants and Users
DO $$
DECLARE
    wipro_id UUID := gen_random_uuid();
    infosys_id UUID := gen_random_uuid();
    tcs_id UUID := gen_random_uuid();
    ibm_id UUID := gen_random_uuid();
    rediff_id UUID := gen_random_uuid();
    
    default_pass VARCHAR := crypt('password123', gen_salt('bf'));
    
    wipro_user1 UUID := gen_random_uuid();
    wipro_user2 UUID := gen_random_uuid();
    
    infosys_user1 UUID := gen_random_uuid();
    infosys_user2 UUID := gen_random_uuid();

    tcs_user1 UUID := gen_random_uuid();
    tcs_user2 UUID := gen_random_uuid();

    ibm_user1 UUID := gen_random_uuid();
    ibm_user2 UUID := gen_random_uuid();

    rediff_user1 UUID := gen_random_uuid();
    rediff_user2 UUID := gen_random_uuid();
BEGIN
    -- Seed Tenants
    INSERT INTO tenants (id, name, domain) VALUES
    (wipro_id, 'Wipro', 'wipro.chat'),
    (infosys_id, 'Infosys', 'infosys.chat'),
    (tcs_id, 'TCS', 'tcs.chat'),
    (ibm_id, 'IBM', 'ibm.chat'),
    (rediff_id, 'Rediff', 'rediff.chat');

    -- Seed Users for Wipro
    INSERT INTO users (id, tenant_id, username, email) VALUES
    (wipro_user1, wipro_id, 'alice', 'alice@wipro.com'),
    (wipro_user2, wipro_id, 'bob', 'bob@wipro.com');
    
    INSERT INTO user_auth (user_id, password_hash) VALUES
    (wipro_user1, default_pass),
    (wipro_user2, default_pass);

    INSERT INTO user_profile (user_id, display_name) VALUES
    (wipro_user1, 'Alice Wipro'),
    (wipro_user2, 'Bob Wipro');

    -- Seed Users for Infosys
    INSERT INTO users (id, tenant_id, username, email) VALUES
    (infosys_user1, infosys_id, 'charlie', 'charlie@infosys.com'),
    (infosys_user2, infosys_id, 'david', 'david@infosys.com');

    INSERT INTO user_auth (user_id, password_hash) VALUES
    (infosys_user1, default_pass),
    (infosys_user2, default_pass);

    INSERT INTO user_profile (user_id, display_name) VALUES
    (infosys_user1, 'Charlie Infosys'),
    (infosys_user2, 'David Infosys');

    -- Seed Users for TCS
    INSERT INTO users (id, tenant_id, username, email) VALUES
    (tcs_user1, tcs_id, 'eve', 'eve@tcs.com'),
    (tcs_user2, tcs_id, 'frank', 'frank@tcs.com');

    INSERT INTO user_auth (user_id, password_hash) VALUES
    (tcs_user1, default_pass),
    (tcs_user2, default_pass);

    INSERT INTO user_profile (user_id, display_name) VALUES
    (tcs_user1, 'Eve TCS'),
    (tcs_user2, 'Frank TCS');

    -- Seed Users for IBM
    INSERT INTO users (id, tenant_id, username, email) VALUES
    (ibm_user1, ibm_id, 'grace', 'grace@ibm.com'),
    (ibm_user2, ibm_id, 'heidi', 'heidi@ibm.com');

    INSERT INTO user_auth (user_id, password_hash) VALUES
    (ibm_user1, default_pass),
    (ibm_user2, default_pass);

    INSERT INTO user_profile (user_id, display_name) VALUES
    (ibm_user1, 'Grace IBM'),
    (ibm_user2, 'Heidi IBM');

    -- Seed Users for Rediff
    INSERT INTO users (id, tenant_id, username, email) VALUES
    (rediff_user1, rediff_id, 'ivan', 'ivan@rediff.com'),
    (rediff_user2, rediff_id, 'judy', 'judy@rediff.com');

    INSERT INTO user_auth (user_id, password_hash) VALUES
    (rediff_user1, default_pass),
    (rediff_user2, default_pass);

    INSERT INTO user_profile (user_id, display_name) VALUES
    (rediff_user1, 'Ivan Rediff'),
    (rediff_user2, 'Judy Rediff');

    -- Update existing seed users to be in Rediff tenant (from 01-schema.sql)
    UPDATE users SET tenant_id = rediff_id WHERE tenant_id IS NULL;

END $$;
