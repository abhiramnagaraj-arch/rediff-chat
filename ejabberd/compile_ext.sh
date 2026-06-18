#!/bin/sh
set -e

echo "Compiling mod_tenant_isolate.erl without external includes..."
erlc -o /tmp /tmp/mod_tenant_isolate.erl

echo "Compilation successful. Moving to ext_mod_dir..."
# Place the module in the official ejabberd-modules path
EXT_DIR="/home/ejabberd/.ejabberd-modules/mod_tenant_isolate/ebin"
mkdir -p "$EXT_DIR"
cp /tmp/mod_tenant_isolate.beam "$EXT_DIR/"

# Also try to copy to internal ebin as a fallback, just in case ext_mod_dir isn't mapped
EBIN_DIR=$(find /usr /opt /lib -type d -name "ebin" -path "*ejabberd*/ebin" 2>/dev/null | head -n 1 || true)
if [ -n "$EBIN_DIR" ]; then
    cp /tmp/mod_tenant_isolate.beam "$EBIN_DIR/"
    echo "Also copied to internal $EBIN_DIR"
fi

echo "mod_tenant_isolate successfully installed."
