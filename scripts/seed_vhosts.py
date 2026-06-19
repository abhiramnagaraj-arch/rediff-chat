import psycopg2
import uuid
from datetime import datetime
from passlib.context import CryptContext

# Configuration
VHOSTS = ["v1", "v2", "v3", "v4"]
TENANTS = ["t1", "t2", "t3", "t4"]
USERS = ["u1", "u2", "u3"]
PASSWORD = "password123"

# Common DB Config
DB_BASE_CONFIG = {
    "user": "rediff",
    "password": "secure_password_here_change_me",
    "host": "localhost",
    "port": "5433"
}

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
PASSWORD_HASH = pwd_context.hash(PASSWORD)

def get_conn(db_name):
    return psycopg2.connect(dbname=db_name, **DB_BASE_CONFIG)

def seed_central_db():
    print("--- Seeding Central Auth DB (rediff_chat) ---")
    conn = get_conn("rediff_chat")
    cur = conn.cursor()
    
    cur.execute("TRUNCATE tenants, users, user_auth, user_profile CASCADE;")
    
    for vhost in VHOSTS:
        vhost_domain = f"{vhost}.chat.rediff.com"
        for t_id in TENANTS:
            tenant_id = str(uuid.uuid4())
            tenant_name = f"Tenant {t_id.upper()} on {vhost.upper()}"
            tenant_slug = f"{vhost}_{t_id}" # Make it unique across vhosts
            
            cur.execute(
                "INSERT INTO tenants (id, name, domain, tenant_slug, assigned_vhost, status) VALUES (%s, %s, %s, %s, %s, %s)",
                (tenant_id, tenant_name, vhost_domain, t_id, vhost_domain, 'ACTIVE')
            )
            
            for u_id in USERS:
                user_id = str(uuid.uuid4())
                cur.execute(
                    "INSERT INTO users (id, tenant_id, username, email, status) VALUES (%s, %s, %s, %s, %s)",
                    (user_id, tenant_id, u_id, f"{t_id}.{u_id}@{vhost_domain}", 'ACTIVE')
                )
                
                cur.execute(
                    "INSERT INTO user_auth (user_id, password_hash) VALUES (%s, %s)",
                    (user_id, PASSWORD_HASH)
                )
                
                cur.execute(
                    "INSERT INTO user_profile (user_id, display_name) VALUES (%s, %s)",
                    (user_id, f"{t_id.upper()} User {u_id.upper()}")
                )

    conn.commit()
    cur.close()
    conn.close()
    print("Successfully seeded Central Auth DB")

def seed_vhost_db(vhost):
    db_name = f"rediff_{vhost}_db"
    vhost_domain = f"{vhost}.chat.rediff.com"
    print(f"--- Seeding VHost DB ({db_name}) ---")
    conn = get_conn(db_name)
    cur = conn.cursor()
    
    cur.execute("TRUNCATE users, user_auth, user_profile, rosterusers CASCADE;")
    
    for t_id in TENANTS:
        user_ids = []
        for u_id in USERS:
            u_uuid = str(uuid.uuid4())
            full_username = f"{t_id}.{u_id}"
            
            cur.execute(
                "INSERT INTO users (id, username, email, status) VALUES (%s, %s, %s, %s)",
                (u_uuid, full_username, f"{full_username}@{vhost_domain}", 'ACTIVE')
            )
            
            cur.execute(
                "INSERT INTO user_auth (user_id, password_hash) VALUES (%s, %s)",
                (u_uuid, PASSWORD_HASH)
            )
            
            user_ids.append(full_username)
            
        # Mutual Roster (everyone in tenant knows everyone else)
        for i, u_from in enumerate(user_ids):
            for j, u_to in enumerate(user_ids):
                if i != j:
                    cur.execute(
                        "INSERT INTO rosterusers (username, jid, nick, subscription, ask, askmessage, server, subscribe, type, approved) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                        (u_from, f"{u_to}@{vhost_domain}", u_to, 'B', 'N', '', 'N', '', 'item', True)
                    )

    conn.commit()
    cur.close()
    conn.close()
    print(f"Successfully seeded {db_name}")

if __name__ == "__main__":
    seed_central_db()
    for vh in VHOSTS:
        seed_vhost_db(vh)
    print("\n--- All Seeding Complete ---")
