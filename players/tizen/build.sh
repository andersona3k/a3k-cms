#!/usr/bin/env bash
# Empacota a casca Tizen num .wgt (ZIP com os arquivos na RAIZ) e coloca em
# public/player/A3Kplayer.wgt — servido para o "Install Web App" do URL Launcher.
#   bash players/tizen/build.sh [CMS_URL]
# CMS_URL default = o que já está no index.html.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../../public/player/A3Kplayer.wgt"

if [ "${1:-}" != "" ]; then
  sed -i "s#var CMS = '[^']*'#var CMS = '${1%/}'#" "$HERE/index.html"
  echo "CMS_URL -> ${1%/}"
fi

python - "$HERE" "$OUT" <<'PY'
import sys, zipfile, os
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for name in ('config.xml', 'index.html'):
        z.write(os.path.join(src, name), arcname=name)
print('gerado', out, os.path.getsize(out), 'bytes')
PY
