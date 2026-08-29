#!/usr/bin/env bash
# Bootstrap de uma VM Ubuntu 22.04/24.04 para o A3K CMS.
# Rode UMA vez, como root:  sudo bash deploy/setup.sh
# Idempotente — pode rodar de novo sem estragar nada.
set -euo pipefail

APP_USER=a3k
APP_DIR=/opt/a3k-cms
NODE_MAJOR=22
HERE="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "rode como root (sudo)"; exit 1; }

echo "==> pacotes base"
apt-get update -y
apt-get install -y ca-certificates curl gnupg git nginx sqlite3

echo "==> Node ${NODE_MAJOR}"
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR" ] && NEED_NODE=0
fi
if [ "$NEED_NODE" -eq 1 ]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
fi
node --version

echo "==> usuário de serviço ${APP_USER}"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"

echo "==> ${APP_DIR}"
mkdir -p "$APP_DIR"
chown "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> systemd unit"
install -m 0644 "$HERE/a3k-cms.service" /etc/systemd/system/a3k-cms.service
systemctl daemon-reload
systemctl enable a3k-cms.service

echo "==> nginx site"
install -m 0644 "$HERE/nginx-a3k-cms.conf" /etc/nginx/sites-available/a3k-cms
ln -sfn /etc/nginx/sites-available/a3k-cms /etc/nginx/sites-enabled/a3k-cms
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> deploy key do ${APP_USER}"
SSH_DIR="/home/${APP_USER}/.ssh"
install -d -m 0700 -o "$APP_USER" -g "$APP_USER" "$SSH_DIR"
if [ ! -f "$SSH_DIR/id_ed25519" ]; then
  sudo -u "$APP_USER" ssh-keygen -t ed25519 -N '' -f "$SSH_DIR/id_ed25519" -C "a3k-cms-deploy@$(hostname)"
fi
sudo -u "$APP_USER" ssh-keyscan -t ed25519 github.com >> "$SSH_DIR/known_hosts" 2>/dev/null || true
sort -u "$SSH_DIR/known_hosts" -o "$SSH_DIR/known_hosts" 2>/dev/null || true
chown -R "$APP_USER:$APP_USER" "$SSH_DIR"

cat <<EOF

────────────────────────────────────────────────────────────
Base pronta. Próximos passos:

1) Cadastre esta DEPLOY KEY no repo (GitHub > Settings > Deploy keys,
   "Add deploy key", pode deixar SEM permissão de escrita):

$(cat "$SSH_DIR/id_ed25519.pub")

2) Primeiro deploy (clona + instala):
     sudo bash $HERE/deploy.sh

3) Crie o /opt/a3k-cms/.env a partir do .env.production.example
   (JWT_SECRET forte, SEED_ADMIN_PASSWORD). Depois:
     sudo -u ${APP_USER} bash -lc 'cd ${APP_DIR} && npm run migrate && npm run seed'
     systemctl restart a3k-cms
     curl -s localhost:3000/api/health

4) Agende o backup:
     ( crontab -l 2>/dev/null; echo '15 3 * * * /opt/a3k-cms/deploy/backup.sh >> /var/log/a3k-cms-backup.log 2>&1' ) | crontab -
────────────────────────────────────────────────────────────
EOF
