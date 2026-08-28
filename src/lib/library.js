'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { probeAsset } = require('./probe');

// url gravada e sempre "/assets/<storedName>"
function storedNameOf(url) {
  return String(url || '').replace(/^\/assets\//, '');
}
function absPathOf(url) {
  return path.join(config.mediaDir, storedNameOf(url));
}

// Roda o probe no arquivo do asset e grava as colunas de metadados.
async function applyProbeToAsset(db, asset) {
  const abs = absPathOf(asset.url);
  const result = await probeAsset(abs, asset.type);
  const f = result.fields || {};

  db.prepare(
    `UPDATE assets SET
        width = ?, height = ?, duration = ?, fps = ?, bitrate = ?, codec = ?, format = ?,
        metadata = ?, probe_status = ?, probe_error = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(
    f.width ?? null,
    f.height ?? null,
    f.duration ?? null,
    f.fps ?? null,
    f.bitrate ?? null,
    f.codec ?? null,
    f.format ?? null,
    result.raw != null ? JSON.stringify(result.raw) : null,
    result.status,
    result.error || null,
    asset.id
  );

  return db.prepare('SELECT * FROM assets WHERE id = ?').get(asset.id);
}

// Remove o arquivo do disco se nenhum outro asset apontar para o mesmo hash.
function deleteAssetFileIfOrphan(db, asset) {
  if (!asset.hash) return;
  const others = db
    .prepare('SELECT COUNT(*) AS n FROM assets WHERE hash = ? AND id <> ?')
    .get(asset.hash, asset.id).n;
  if (others > 0) return;
  const abs = absPathOf(asset.url);
  if (fs.existsSync(abs)) fs.rmSync(abs);
}

module.exports = { storedNameOf, absPathOf, applyProbeToAsset, deleteAssetFileIfOrphan };
