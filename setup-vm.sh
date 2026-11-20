#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Cosmic Cafe PocketBase Provisioner (Two-Box Architecture)
#
# Usage:
#   PROD box (Static IP, Caddy TLS, NO cloudflared):
#     sudo bash setup-vm.sh --env prod --domain inventory.yourcafe.org
#
#   DEV box (No fixed IP, cloudflared tunnel, NO Caddy):
#     sudo bash setup-vm.sh --env dev --domain dev.yourcafe.org --tunnel-token <TOKEN>
# ==============================================================================

PB_VERSION="0.40.6"
TIMEZONE="America/New_York"
APP_ENV=""
DOMAIN=""
TUNNEL_TOKEN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) APP_ENV="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --tunnel-token) TUNNEL_TOKEN="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

if [[ "$APP_ENV" != "prod" && "$APP_ENV" != "dev" ]]; then
  echo "Error: --env must be 'prod' or 'dev'"
  exit 1
fi

if [[ -z "$DOMAIN" ]]; then
  echo "Error: --domain is required (e.g., inventory.yourcafe.org or dev.yourcafe.org)"
  exit 1
fi

if [[ "$APP_ENV" == "dev" && -z "$TUNNEL_TOKEN" ]]; then
  echo "Error: --tunnel-token is required for --env dev (dev uses cloudflared instead of a fixed IP)."
  exit 1
fi

echo "==> Configuring system timezone to ${TIMEZONE} (ensures 1:30 PM cron accuracy)..."
timedatectl set-timezone "${TIMEZONE}"

echo "==> Installing base utilities..."
apt-get update -y
apt-get install -y curl unzip ca-certificates gnupg

echo "==> Creating dedicated 'pocketbase' system user and directories..."
id -u pocketbase &>/dev/null || useradd --system --home /opt/pocketbase --shell /usr/sbin/nologin pocketbase
mkdir -p /opt/pocketbase/{pb_data,pb_hooks,pb_migrations,pb_public}

echo "==> Downloading PocketBase v${PB_VERSION}..."
ARCH=$(dpkg --print-architecture)
curl -fsSL "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${ARCH}.zip" -o /tmp/pb.zip
unzip -o /tmp/pb.zip pocketbase -d /opt/pocketbase/
rm -f /tmp/pb.zip
chmod +x /opt/pocketbase/pocketbase
chown -R pocketbase:pocketbase /opt/pocketbase

echo "==> Writing /etc/default/pocketbase (APP_ENV=${APP_ENV})..."
cat >/etc/default/pocketbase <<EOF
APP_ENV=${APP_ENV}
PUBLIC_DOMAIN=${DOMAIN}
EOF

echo "==> Creating hardened pocketbase.service (bound strictly to 127.0.0.1:8090)..."
cat >/etc/systemd/system/pocketbase.service <<'EOF'
[Unit]
Description=Cosmic Cafe PocketBase Backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pocketbase
Group=pocketbase
EnvironmentFile=/etc/default/pocketbase
WorkingDirectory=/opt/pocketbase
ExecStart=/opt/pocketbase/pocketbase serve --http=127.0.0.1:8090
Restart=always
RestartSec=3
LimitNOFILE=4096

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/pocketbase

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now pocketbase.service

# ==============================================================================
# Environment-Specific Ingress Setup
#   - PROD: Caddy reverse proxy + Static IP (NO cloudflared)
#   - DEV:  cloudflared outbound tunnel (NO Caddy, NO static IP)
# ==============================================================================
if [[ "$APP_ENV" == "prod" ]]; then
  echo "==> [PROD] Setting up Caddy reverse proxy (cloudflared is NOT used on prod)..."
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg --yes
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy

  cat >/etc/caddy/Caddyfile <<EOF
${DOMAIN} {
    encode gzip
    reverse_proxy 127.0.0.1:8090
}
EOF

  systemctl enable --now caddy.service
  systemctl reload caddy.service

  echo ""
  echo "PROD setup complete!"
  echo "  1. Point DNS A-record for ${DOMAIN} to this VM's Static IPv4."
  echo "  2. Ensure GCP firewall tags 'http-server' (80) and 'https-server' (443) are enabled."
  echo "  3. Health check URL: https://${DOMAIN}/api/health"

elif [[ "$APP_ENV" == "dev" ]]; then
  echo "==> [DEV] Installing cloudflared tunnel daemon (no fixed IP or Caddy needed)..."
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | tee /etc/apt/sources.list.d/cloudflared.list
  apt-get update -y && apt-get install -y cloudflared

  cloudflared service install "${TUNNEL_TOKEN}"
  systemctl enable --now cloudflared.service

  echo ""
  echo "DEV setup complete!"
  echo "  1. In Cloudflare Zero Trust -> Tunnels, route ${DOMAIN} -> http://127.0.0.1:8090"
  echo "  2. Keep GCP HTTP/HTTPS firewall ports CLOSED on this VM."
  echo "  3. Health check URL: https://${DOMAIN}/api/health"
fi
