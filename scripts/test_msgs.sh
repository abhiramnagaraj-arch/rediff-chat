#!/bin/bash
docker exec rediff_ejabberd ejabberdctl send_message chat alice@wipro.chat bob@wipro.chat "" "test message inside wipro"
docker exec rediff_ejabberd ejabberdctl send_message chat alice@wipro.chat charlie@infosys.chat "" "test cross tenant message"
sleep 6
docker exec rediff_postgres psql -U rediff -d rediff_chat -c "SELECT username, peer, bare_peer, txt, kind FROM archive;"
docker exec rediff_postgres psql -U rediff -d rediff_chat -c "SELECT sender_jid, recipient_jid, message_body FROM message_archive;"
