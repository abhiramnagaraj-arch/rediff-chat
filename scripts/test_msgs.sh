#!/bin/bash
docker exec rediff_ejabberd_a ejabberdctl send_message chat t1.u1@v1.chat.rediff.com t1.u2@v1.chat.rediff.com "" "test message inside v1"
docker exec rediff_ejabberd_a ejabberdctl send_message chat t1.u1@v1.chat.rediff.com t2.u1@v1.chat.rediff.com "" "test cross tenant message"
sleep 6
docker exec rediff_postgres psql -U rediff -d rediff_v1_db -c "SELECT username, peer, bare_peer, txt, kind FROM archive;"
docker exec rediff_postgres psql -U rediff -d rediff_v1_db -c "SELECT sender_jid, recipient_jid, message_body FROM message_archive;"
