#!/usr/bin/env bash
# Deploy / update do A3K CMS. Rode como root:  sudo bash deploy/deploy.sh
# Faz clone na primeira vez, depois é git pull + npm ci + migrate + restart.
set -euo pipefail

APP_USER=a3k
APP_DIR=/opt/a3k-cms
REPO="${REPO:-git@github.com:andersona3k/a3k-cms.git}"
BRANCH="${BRANCH:-master}"

[ "$(id -u)" -eq 0 ] || { echo "rode como root (sudo)"; exit 1; }
as_app() { sudo -u "$APP_USER" bash -lc "$*"; }

if [ ! -d "$APP_DIR/.git" ]; then
  echo "==> clone inicial ($REPO)"
  as_app "git clone --branch '$BRANCH' '$REPO' '$APP_DIR'"
else
  echo "==> git fetch + reset --hard origin/$BRANCH"
  as_app "cd '$APP_DIR' && git fetch --prune origin '$BRANCH' && git reset --hard 'origin/$BRANCH'"
fi

echo "==> npm ci --omit=dev"
as_app "cd '$APP_DIR' && npm ci --omit=dev"

echo "==> migrações"
as_app "cd '$APP_DIR' && npm run migrate"

if [ -f "$APP_DIR/.env" ]; then
  echo "==> restart a3k-cms"
  systemctl restart a3k-cms
  sleep 1
  systemctl --no-pager --lines=8 status a3k-cms || true
  echo -n "==> health: "
  curl -fsS http://127.0.0.1:3000/api/health && echo
else
  echo "!! $APP_DIR/.env não existe — crie (veja .env.production.example),"
  echo "   rode 'npm run migrate && npm run seed' como $APP_USER e 'systemctl restart a3k-cms'."
fi
