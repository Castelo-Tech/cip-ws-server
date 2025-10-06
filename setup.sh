#!/usr/bin/env bash
# setup.sh — installs dependencies and configures the WhatsApp API server as a
# systemd service.  Run from the repository root (where package.json resides).

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Determine repository directory based off this script's location.  This
# allows the script to be run from anywhere and still resolve paths
# correctly.
SCRIPT_PATH="$(readlink -f "$0")"
REPO_DIR="$(dirname "$SCRIPT_PATH")"
echo "Repo dir: $REPO_DIR"

# Sanity check that we're in the correct directory
if [ ! -f "$REPO_DIR/package.json" ]; then
  echo "ERROR: package.json not found in $REPO_DIR"
  exit 1
fi

echo "==> Installing OS prerequisites…"
apt-get update -y
apt-get install -y curl ca-certificates build-essential \
  fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libc6 \
  libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libfontconfig1 \
  libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
  libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 \
  libxfixes3 libxrandr2 libxrender1 libxss1 libxtst6 wget xdg-utils

# Install Node.js LTS if not already present
if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node.js LTS…"
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
  apt-get install -y nodejs
fi

echo "==> Node version: $(node -v || echo 'not found'), npm version: $(npm -v || echo 'not found')"

echo "==> Installing npm dependencies in $REPO_DIR…"
if [ -f "$REPO_DIR/package-lock.json" ]; then
  npm --prefix "$REPO_DIR" ci --no-audit --no-fund
else
  npm --prefix "$REPO_DIR" install --no-audit --no-fund
fi

# Ensure runtime data directories exist and are owned by the service user (root here).
mkdir -p "$REPO_DIR/.wwebjs_auth" "$REPO_DIR/media"
chown -R root:root "$REPO_DIR/.wwebjs_auth" "$REPO_DIR/media"

echo "==> Creating/Updating systemd service to run: npm start"
SERVICE_NAME="whatsapp-server"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

# Backup existing unit if present
if [ -f "$SERVICE_PATH" ]; then
  cp -f "$SERVICE_PATH" "${SERVICE_PATH}.bak.$(date +%Y%m%d%H%M%S)"
fi

cat >"$SERVICE_PATH" <<EOF
[Unit]
Description=WhatsApp API Server (whatsapp-web.js)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${REPO_DIR}
ExecStart=/usr/bin/npm run start --silent
ExecStartPre=/usr/bin/mkdir -p ${REPO_DIR}/.wwebjs_auth ${REPO_DIR}/media
ExecStartPre=/usr/bin/chown -R root:root ${REPO_DIR}/.wwebjs_auth ${REPO_DIR}/media
# Graceful shutdown and resiliency
KillSignal=SIGINT
TimeoutStopSec=20
Restart=always
RestartSec=3
# Environment variables
Environment=NODE_ENV=production
Environment=PUPPETEER_SKIP_DOWNLOAD=false
# Increase file descriptors for Puppeteer/WS
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

echo "==> Done."
systemctl status "$SERVICE_NAME" --no-pager || true
echo "Logs: journalctl -u ${SERVICE_NAME} -f"