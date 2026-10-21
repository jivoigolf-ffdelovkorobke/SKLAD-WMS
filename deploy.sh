#!/usr/bin/env bash
# Выкладка из GitHub: GitHub после каждого обновления заходит на сервер по ключу, и ключ умеет запускать только этот файл.
# Ставит ровно то, что лежит в GitHub (main), и перезапускает склад. Данные в /opt/sklad/data не трогаются.
set -e
cd /opt/sklad
git fetch -q origin main
git reset -q --hard origin/main
echo "$(date '+%F %T') выкладка из GitHub $(git rev-parse --short HEAD)" >> log.txt
bash update.sh
