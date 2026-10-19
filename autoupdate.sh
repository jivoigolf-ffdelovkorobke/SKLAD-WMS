#!/usr/bin/env bash
# Автообновление: cron раз в 2 минуты проверяет GitHub и, если там новая версия, ставит её и перезапускает склад.
# Подключение (один раз): (crontab -l; echo "*/2 * * * * bash /opt/sklad/autoupdate.sh") | crontab -
cd /opt/sklad || exit 0
git fetch -q origin main || exit 0
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0
git merge -q --ff-only origin/main || exit 0
echo "$(date '+%F %T') обновление до $(git rev-parse --short HEAD)" >> log.txt
bash update.sh >> log.txt 2>&1
