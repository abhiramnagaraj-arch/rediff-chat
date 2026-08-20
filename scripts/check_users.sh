#!/usr/bin/env bash
curl -s "http://localhost:8000/users/t1.u1?domain=v1.chat.rediff.com"
echo ""
curl -s "http://localhost:8000/users/t1.u1?domain=v2.chat.rediff.com"
echo ""
curl -s "http://localhost:8000/users/t2.u1?domain=v1.chat.rediff.com"
echo ""
