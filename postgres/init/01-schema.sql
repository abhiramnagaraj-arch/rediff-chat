-- Enable pgcrypto extension for bcrypt password hashing
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =======================================================
-- SCHEMA DEFINITION
-- =======================================================

-- 1. users
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR UNIQUE NOT NULL,
    email VARCHAR UNIQUE NOT NULL,
    status VARCHAR NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. user_auth
CREATE TABLE user_auth (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    password_hash VARCHAR NOT NULL,
    last_login_at TIMESTAMPTZ,
    password_updated_at TIMESTAMPTZ DEFAULT NOW(),
    account_locked BOOLEAN DEFAULT FALSE,
    failed_attempts INTEGER DEFAULT 0
);

-- 3. user_profile
CREATE TABLE user_profile (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name VARCHAR,
    avatar_url TEXT,
    phone VARCHAR,
    designation VARCHAR,
    bio TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. notification_devices
CREATE TABLE notification_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    platform VARCHAR,
    device_token TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, device_token)
);

-- 5. audit_log
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR NOT NULL,
    actor UUID REFERENCES users(id) ON DELETE SET NULL,
    target VARCHAR,
    payload_json JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. message_archive
CREATE TABLE message_archive (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id VARCHAR UNIQUE NOT NULL,
    sender_jid VARCHAR NOT NULL,
    recipient_jid VARCHAR NOT NULL,
    message_body TEXT,
    sent_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. message_receipts
CREATE TABLE message_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id VARCHAR REFERENCES message_archive(message_id) ON DELETE CASCADE,
    recipient_jid VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =======================================================
-- INDEXES
-- =======================================================

CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_message_archive_sender ON message_archive(sender_jid);
CREATE INDEX idx_message_archive_recipient ON message_archive(recipient_jid);
CREATE INDEX idx_message_archive_sent_at ON message_archive(sent_at);
CREATE INDEX idx_audit_log_event_type ON audit_log(event_type);
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at);
CREATE INDEX idx_message_receipts_msg_id ON message_receipts(message_id);

-- =======================================================
-- SEED DATA
-- =======================================================

-- Using DO block to seed data safely and generate UUIDs for referencing
DO $$
DECLARE
    admin_id UUID := gen_random_uuid();
    alice_id UUID := gen_random_uuid();
    bob_id UUID := gen_random_uuid();
    charlie_id UUID := gen_random_uuid();
    david_id UUID := gen_random_uuid();
    eve_id UUID := gen_random_uuid();
    
    -- The common password we'll hash is 'password123'
    -- Note: crypt('password', gen_salt('bf')) uses bcrypt
    default_pass VARCHAR := crypt('password123', gen_salt('bf'));
BEGIN

    -- Insert into users
    INSERT INTO users (id, username, email) VALUES
    (admin_id, 'admin', 'admin@chat.rediff.com'),
    (alice_id, 'alice', 'alice@chat.rediff.com'),
    (bob_id, 'bob', 'bob@chat.rediff.com'),
    (charlie_id, 'charlie', 'charlie@chat.rediff.com'),
    (david_id, 'david', 'david@chat.rediff.com'),
    (eve_id, 'eve', 'eve@chat.rediff.com');

    -- Insert into user_auth
    INSERT INTO user_auth (user_id, password_hash) VALUES
    (admin_id, default_pass),
    (alice_id, default_pass),
    (bob_id, default_pass),
    (charlie_id, default_pass),
    (david_id, default_pass),
    (eve_id, default_pass);

    -- Insert into user_profile
    INSERT INTO user_profile (user_id, display_name, designation) VALUES
    (admin_id, 'System Administrator', 'Admin'),
    (alice_id, 'Alice Adams', 'Engineer'),
    (bob_id, 'Bob Builder', 'Engineer'),
    (charlie_id, 'Charlie Chaplin', 'Product Manager'),
    (david_id, 'David Duke', 'Designer'),
    (eve_id, 'Eve Eavesdropper', 'Security Analyst');

END $$;
