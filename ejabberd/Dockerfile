FROM ejabberd/ecs:26.04

USER root

# Install Python, PostgreSQL, and Erlang compiler
RUN apk add --no-cache \
    python3 \
    py3-pip \
    openssl \
    postgresql-libs \
    gcc \
    musl-dev \
    postgresql-dev \
    python3-dev \
    erlang

# Install Python dependencies used by the external auth bridge
RUN pip3 install --break-system-packages psycopg2-binary requests

# Bake the extauth bridge into the ejabberd config directory so the
# configured extauth_program path always exists in the container image.
COPY extauth.py /home/ejabberd/conf/extauth.py

# Provide a self-signed TLS certificate for local development so ejabberd can
# start with TLS enabled even when the host repo has not provisioned one.
RUN mkdir -p /home/ejabberd/conf && \
    printf "[req]\ndefault_bits=2048\nprompt=no\ndefault_md=sha256\ndistinguished_name=dn\nreq_extensions=req_ext\n\n[dn]\nCN=v1.chat.rediff.com\n\n[req_ext]\nsubjectAltName=DNS:localhost,DNS:chat.rediff.com,DNS:v1.chat.rediff.com,DNS:v2.chat.rediff.com,DNS:v3.chat.rediff.com,DNS:v4.chat.rediff.com,IP:127.0.0.1,IP:10.20.10.165\n" > /tmp/openssl.cnf && \
    openssl req -x509 -nodes -newkey rsa:2048 \
      -keyout /tmp/server.key \
      -out /tmp/server.crt \
      -days 3650 \
      -config /tmp/openssl.cnf \
      -extensions req_ext && \
    cat /tmp/server.key /tmp/server.crt > /home/ejabberd/conf/server.pem && \
    rm -f /tmp/server.key /tmp/server.crt /tmp/openssl.cnf

# Verify installation
RUN python3 --version

# Copy the custom module source
COPY src/mod_tenant_isolate.erl /tmp/mod_tenant_isolate.erl

# Compile natively and copy exactly into Ejabberd's internal module directory
RUN cd /tmp && \
    erlc mod_tenant_isolate.erl && \
    EBIN_DIR=$(dirname $(find / -name "mod_ping.beam" 2>/dev/null | head -n 1)) && \
    cp /tmp/mod_tenant_isolate.beam "$EBIN_DIR/" && \
    chown ejabberd:ejabberd "$EBIN_DIR/mod_tenant_isolate.beam" && \
    chmod 644 "$EBIN_DIR/mod_tenant_isolate.beam"

USER ejabberd
