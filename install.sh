#!/usr/bin/env bash
# Установка склада «Дело в коробке» на чистый сервер Ubuntu одной командой.
# Ставит Docker, запускает приложение и Caddy с бесплатным HTTPS-сертификатом.
# Адрес по умолчанию: https://<IP-сервера>.sslip.io. Свой домен: DOMAIN=sklad.example.ru bash install.sh
set -euo pipefail
REPO="${REPO:-https://github.com/jivoigolf-ffdelovkorobke/SKLAD-WMS.git}"
DIR=/opt/sklad
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
apt-get install -y git >/dev/null 2>&1 || true
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi
cd "$DIR"
IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
DOMAIN="${DOMAIN:-$IP.sslip.io}"
cat > Caddyfile <<CADDY
$DOMAIN {
  encode gzip
  reverse_proxy sklad:8080 {
    flush_interval -1
  }
}
CADDY
cat > docker-compose.prod.yml <<'YML'
services:
  sklad:
    build: .
    restart: unless-stopped
    environment:
      - TRUST_PROXY=1
    volumes:
      - ./data:/data
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    depends_on: [sklad]
volumes:
  caddy_data:
YML
docker compose -f docker-compose.prod.yml up -d --build
echo
echo "Готово. Откройте https://$DOMAIN и создайте администратора."
