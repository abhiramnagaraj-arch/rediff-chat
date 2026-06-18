# 02. Advanced Working Flows

This document maps out the precise, step-by-step lifecycles of crucial system operations. It illustrates how the isolated components of the architecture interact in real-time.

---

## 1. The Authentication Lifecycle (External Auth)

This sequence details exactly what happens in the milliseconds between a user clicking "Login" and establishing a chat session.

```mermaid
sequenceDiagram
    autonumber
    participant App as Mobile/Web Client
    participant Ejabberd as Ejabberd Core
    participant ExtAuth as extauth.py (Worker)
    participant AuthAPI as FastAPI Service
    participant PG as PostgreSQL

    Note over App, Ejabberd: 1. TCP Connection & TLS Handshake
    App->>Ejabberd: <auth mechanism='PLAIN'>Base64(w.10001 \0 password)</auth>
    
    Note over Ejabberd, ExtAuth: 2. Erlang to Python Hand-off
    Ejabberd->>ExtAuth: Sends via STDIN: [auth:w.10001:chat.rediff.com:password]
    
    Note over ExtAuth, AuthAPI: 3. HTTP Verification Request
    ExtAuth->>AuthAPI: POST /auth HTTP/1.1<br/>{username: "w.10001", domain: "chat.rediff.com"}
    
    AuthAPI->>PG: SELECT password_hash FROM user_auth WHERE user_id = (SELECT id FROM users WHERE jid_localpart='w.10001')
    PG-->>AuthAPI: Returns Bcrypt Hash: $2b$12$xyz...
    
    Note over AuthAPI: 4. Cryptographic Validation
    AuthAPI->>AuthAPI: Compute Bcrypt(password). Does it match hash?
    
    alt Password is Correct
        AuthAPI-->>ExtAuth: HTTP 200 OK {"success": true}
        ExtAuth-->>Ejabberd: STDOUT: [True] (Binary 2-byte packet)
        Ejabberd-->>App: <success xmlns='urn:ietf:params:xml:ns:xmpp-sasl'/>
        Note over Ejabberd: Binds session and registers presence
    else Password is Wrong
        AuthAPI-->>ExtAuth: HTTP 401 Unauthorized
        ExtAuth-->>Ejabberd: STDOUT: [False] (Binary 2-byte packet)
        Ejabberd-->>App: <failure><not-authorized/></failure>
        AuthAPI->>PG: Increment failed_attempts for security audit
    end
```

---

## 2. Distributed Message Routing (Node-to-Node)

When users are connected to different physical servers, Ejabberd must locate them and route the message seamlessly.

```mermaid
sequenceDiagram
    autonumber
    participant Alice as Alice (w.10001)<br/>Connected to Node A
    participant NodeA as Ejabberd Node A
    participant Mnesia as Shared Mnesia Cluster
    participant NodeB as Ejabberd Node B
    participant Bob as Bob (w.10002)<br/>Connected to Node B

    Alice->>NodeA: <message to='w.10002@chat.rediff.com'>Hello!</message>
    
    Note over NodeA: 1. Security Enforcement
    NodeA->>NodeA: Check Tenant Prefix: 'w' == 'w'? YES. Proceed.
    
    Note over NodeA, Mnesia: 2. Distributed Lookup
    NodeA->>Mnesia: Query `session` table: Where is w.10002?
    Mnesia-->>NodeA: User w.10002 is registered on PID <Node B, Process 1234>
    
    Note over NodeA, NodeB: 3. Erlang Distribution Routing
    NodeA->>NodeB: Forward stanza to Node B via Erlang TCP (Port 4369)
    
    NodeB->>Bob: Deliver <message> to Bob's active WebSocket
    
    Note over NodeA, NodeB: 4. Asynchronous Archiving
    par Archiving
        NodeA->>PostgreSQL: INSERT into `archive` (Sender history)
        NodeB->>PostgreSQL: INSERT into `archive` (Recipient history)
    end
```

---

## 3. Offline Message Handling & Push Notifications

If the recipient is not actively connected to any Ejabberd node, the system must queue the message and trigger a mobile push notification.

```mermaid
sequenceDiagram
    autonumber
    participant Alice as Alice (w.10001)
    participant Ejabberd as Ejabberd Cluster
    participant Mnesia as Mnesia Spool
    participant PushSvc as External Push Service
    participant FCM as Apple APNs / Google FCM

    Alice->>Ejabberd: <message to='w.10003'>Are you there?</message>
    
    Ejabberd->>Mnesia: Query `session` table for w.10003
    Mnesia-->>Ejabberd: NO ACTIVE SESSION FOUND
    
    Note over Ejabberd: 1. Offline Storage
    Ejabberd->>Mnesia: INSERT into `spool` (Offline message queue)
    
    Note over Ejabberd, PushSvc: 2. Trigger Webhook / Event
    Ejabberd->>PushSvc: HTTP POST /webhook/offline_message<br/>{to: "w.10003", from: "w.10001"}
    
    PushSvc->>PostgreSQL: Lookup Device Token for w.10003
    PostgreSQL-->>PushSvc: Return Token "abc_123_xyz"
    
    Note over PushSvc, FCM: 3. Dispatch Mobile Push
    PushSvc->>FCM: Send Push: "New message from Alice"
    FCM-->>PushSvc: Push Delivered
```

---

## 4. User Provisioning & JID Allocation

This details how the FastAPI backend creates a new user, automatically handles the math to generate their immutable JID, and syncs them to the database.

```mermaid
flowchart TD
    Start([HR Admin Creates User]) --> API[FastAPI: POST /users]
    
    API --> Parse{Extract Email Domain}
    Parse -->|alice@infosys.com| DB1[Query `tenant_domains` for 'infosys.com']
    
    DB1 --> Check{Domain Exists?}
    Check -->|No| Reject[Return 400 Error: Tenant not configured]
    Check -->|Yes| DB2[Retrieve Tenant Prefix: 'inf']
    
    DB2 --> DB3[Lock `tenants` table]
    DB3 --> DB4[Increment `user_sequence`]
    DB4 --> JID[Generate JID: 'inf' + '.' + '12055']
    
    JID --> Hash[Bcrypt Hash the Password]
    
    Hash --> Insert1[(Postgres: INSERT INTO users)]
    Insert1 --> Insert2[(Postgres: INSERT INTO user_auth)]
    
    Insert2 --> Success([Return 201 Created: inf.12055@chat.rediff.com])
```
