#!/usr/bin/env bash
# Deploy da máquina de desenvolvimento PARA a VM, por SSH — sem passar pelo
# GitHub. Use quando a VM não alcança github.com (rede que filtra a GitHub).
#
#   bash deploy/push-deploy.sh [host-ssh]     (default: a3k-cms-vm)
#
# Envia só os arquivos versionados do branch atual (git archive), roda
# npm ci --omit=dev --ignore-scripts (a VM usa ffmpeg/ffprobe do sistema via
# .env), migra e reinicia o serviço.
set -euo pipefail

HOST="${1:-a3k-cms-vm}"
APP_DIR=/opt/a3k-cms
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

echo "==> enviando $BRANCH -> $HOST:$APP_DIR"
git archive --format=tar "$BRANCH" | ssh "$HOST" "sudo -u a3k tar -x --overwrite -C $APP_DIR"

echo "==> npm ci + migrate + restart"
ssh "$HOST" "cd $APP_DIR \
  && sudo -u a3k npm ci --omit=dev --ignore-scripts \
  && sudo -u a3k npm run migrate \
  && sudo systemctl restart a3k-cms \
  && sleep 1 && curl -fsS http://127.0.0.1:3000/api/health && echo"
