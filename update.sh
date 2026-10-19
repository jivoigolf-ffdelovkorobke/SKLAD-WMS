#!/usr/bin/env bash
# Обновление склада на сервере: cd /opt/sklad && git pull && bash update.sh
# Перезапускает программу, чтобы подхватились изменения сервера. Данные в /opt/sklad/data не трогаются.
set -e
cd "$(dirname "$0")"
pkill -f "node server.js" || true
sleep 1
nohup node server.js >> log.txt 2>&1 &
sleep 2
curl -fsS localhost:8080/api/health && echo && echo "Обновлено и запущено."
