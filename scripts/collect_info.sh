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
cd /home/abhiram.nagaraj/Downloads/Edjabberd/ejabberd && docker compose config
cd /home/abhiram.nagaraj/Downloads/Edjabberd

echo "=== EJABBERDCTL STATUS ==="
docker exec rediff_ejabberd ejabberdctl status

echo "=== EJABBERDCTL DUMP-CONFIG ==="
docker exec rediff_ejabberd cat /home/ejabberd/conf/ejabberd.yml

echo "=== CONNECTED USERS ==="
docker exec rediff_ejabberd ejabberdctl connected_users

echo "=== REGISTERED USERS LOCALHOST ==="
docker exec rediff_ejabberd ejabberdctl registered_users localhost

echo "=== MNESIA TABLES ==="
TABLES=$(docker exec rediff_ejabberd ejabberdctl eval 'mnesia:system_info(tables).' | sed 's/\[//;s/\]//;s/,/ /g')
echo $TABLES
for t in $TABLES; do
    # Remove any quotes or whitespace
    t=$(echo $t | tr -d "'" | tr -d ' ')
    echo "--- Table: $t ---"
    docker exec rediff_ejabberd ejabberdctl eval "mnesia:table_info($t, attributes)."
    docker exec rediff_ejabberd ejabberdctl eval "mnesia:table_info($t, size)."
done

echo "=== POSTGRES TABLES ==="
docker exec rediff_postgres psql -U rediff -d rediff_chat -c "SELECT tablename FROM pg_tables WHERE schemaname='public';"

TABLES_PG=$(docker exec rediff_postgres psql -U rediff -d rediff_chat -t -c "SELECT tablename FROM pg_tables WHERE schemaname='public';")
for t in $TABLES_PG; do
    echo "--- PG Table: $t ---"
    docker exec rediff_postgres psql -U rediff -d rediff_chat -c "\d+ $t"
done
