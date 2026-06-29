#!/bin/bash
echo "=== DOCKER PS ==="
docker ps
echo "=== DOCKER IMAGES ==="
docker images
echo "=== DOCKER NETWORK LS ==="
docker network ls
echo "=== DOCKER NETWORK INSPECT ==="
docker network inspect rediff_network
echo "=== DOCKER COMPOSE CONFIG ==="
cd /home/abhiram.nagaraj/Downloads/Edjabberd && docker compose config

echo "=== EJABBERDCTL STATUS ==="
docker exec rediff_ejabberd_a ejabberdctl status

echo "=== EJABBERDCTL DUMP-CONFIG ==="
docker exec rediff_ejabberd_a cat /home/ejabberd/conf/ejabberd.yml

echo "=== CONNECTED USERS ==="
docker exec rediff_ejabberd_a ejabberdctl connected_users

echo "=== REGISTERED USERS LOCALHOST ==="
docker exec rediff_ejabberd_a ejabberdctl registered_users localhost

echo "=== MNESIA TABLES ==="
TABLES=$(docker exec rediff_ejabberd_a ejabberdctl eval 'mnesia:system_info(tables).' | sed 's/\[//;s/\]//;s/,/ /g')
echo $TABLES
for t in $TABLES; do
    # Remove any quotes or whitespace
    t=$(echo $t | tr -d "'" | tr -d ' ')
    echo "--- Table: $t ---"
    docker exec rediff_ejabberd_a ejabberdctl eval "mnesia:table_info($t, attributes)."
    docker exec rediff_ejabberd_a ejabberdctl eval "mnesia:table_info($t, size)."
done

echo "=== POSTGRES TABLES ==="
for db in rediff_v1_db rediff_v2_db rediff_v3_db rediff_v4_db; do
    echo "--- Database: $db ---"
    docker exec rediff_postgres psql -U rediff -d "$db" -c "SELECT tablename FROM pg_tables WHERE schemaname='public';"
done
