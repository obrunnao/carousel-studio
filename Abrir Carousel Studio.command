#!/bin/zsh
# Abre o Carousel Studio no navegador (com servidor local)
cd "$(dirname "$0")"
if ! lsof -i :4571 >/dev/null 2>&1; then
  nohup python3 server.py >/dev/null 2>&1 &
  sleep 1
fi
open "http://127.0.0.1:4571"
