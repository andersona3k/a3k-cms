'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { probeAsset } = require('./probe');
const { needsNormalize, normalizeVideo, extractPoster } = require('./transcode');

// url gravada e sempre "/assets/<storedName>"
function storedNameOf(url) {
  return String(url || '').replace(/^\/assets\//, '');
}
function absPathOf(url) {
  return path.join(config.mediaDir, storedNameOf(url));
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(filePath);
    rs.on('error', reject);
    rs.on('data', (d) => h.update(d));
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

function writeProbeFields(db, id, result) {
  const f = result.fields || {};
  db.prepare(
    `UPDATE assets SET
        width = ?, height = ?, duration = ?, fps = ?, bitrate = ?, codec = ?, format = ?,
        metadata = ?, probe_status = ?, probe_error = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(
    f.width ?? null, f.height ?? null, f.duration ?? null, f.fps ?? null,
    f.bitrate ?? null, f.codec ?? null, f.format ?? null,
    result.raw != null ? JSON.stringify(result.raw) : null,
    result.status, result.error || null, id
  );
}

// Probe + (video) normalizacao para um perfil que roda em qualquer tela.
async function applyProbeToAsset(db, asset) {
  const abs = absPathOf(asset.url);
  let result = await probeAsset(abs, asset.type);

  // Normaliza video que nao seja H.264 8-bit <=1080p sem rotacao.
  if (asset.type === 'video' && result.status === 'ok') {
    const verdict = needsNormalize(result.raw);
    if (verdict.normalize) {
      const tmpOut = path.join(config.mediaDir, `.transcode-${asset.id}-${Date.now()}.mp4`);
      try {
        await normalizeVideo(abs, tmpOut);
        const newHash = await sha256(tmpOut);
        const newName = `${newHash}.mp4`;
        const newAbs = path.join(config.mediaDir, newName);
        if (fs.existsSync(newAbs)) fs.rmSync(tmpOut);
        else fs.renameSync(tmpOut, newAbs);

        const oldHash = asset.hash;
        db.prepare(
          `UPDATE assets SET url = ?, hash = ?, size_bytes = ?, mime = 'video/mp4', updated_at = datetime('now')
             WHERE id = ?`
        ).run(`/assets/${newName}`, newHash, fs.statSync(newAbs).size, asset.id);

        // o arquivo do asset mudou -> forca re-sync nos players que o usam
        db.prepare(
          `UPDATE playlists SET version = version + 1, updated_at = datetime('now')
             WHERE id IN (SELECT playlist_id FROM playlist_items WHERE asset_id = ?)`
        ).run(asset.id);

        // apaga o original se nenhum outro asset o usar
        if (oldHash && oldHash !== newHash) {
          const others = db.prepare('SELECT COUNT(*) n FROM assets WHERE hash = ? AND id <> ?')
            .get(oldHash, asset.id).n;
          if (others === 0 && fs.existsSync(abs)) fs.rmSync(abs);
        }

        asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(asset.id);
        result = await probeAsset(absPathOf(asset.url), 'video');
        result.normalized = verdict.reason;
      } catch (err) {
        if (fs.existsSync(tmpOut)) fs.rmSync(tmpOut);
        // mantem o original; sinaliza o aviso
        result.error = `normalizacao falhou (${verdict.reason}): ${String(err.message || err).slice(0, 200)}`;
      }
    }
  }

  // miniatura de video: 1 frame -> media/<hash>.thumb.jpg (servido em /assets/...)
  if (asset.type === 'video' && result.status === 'ok') {
    try {
      const thumbName = `${asset.hash}.thumb.jpg`;
      const thumbAbs = path.join(config.mediaDir, thumbName);
      await extractPoster(absPathOf(asset.url), thumbAbs);
      if (fs.existsSync(thumbAbs) && fs.statSync(thumbAbs).size > 0) {
        db.prepare(`UPDATE assets SET thumb_url = ? WHERE id = ?`).run(`/assets/${thumbName}`, asset.id);
      }
    } catch (err) {
      // miniatura e opcional; segue sem ela
      console.warn('[library] poster falhou p/ asset', asset.id, String(err.message || err).slice(0, 160));
    }
  }

  writeProbeFields(db, asset.id, result);
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
  const thumbAbs = path.join(config.mediaDir, `${asset.hash}.thumb.jpg`);
  if (fs.existsSync(thumbAbs)) fs.rmSync(thumbAbs);
}

// Gera a miniatura (poster) dos videos que ainda nao tem thumb_url.
// Roda no boot do server (best-effort, nao bloqueia).
async function backfillVideoThumbs(db, { silent = true } = {}) {
  const rows = db
    .prepare(
      `SELECT id, hash, url FROM assets
        WHERE type = 'video' AND probe_status = 'ok'
          AND (thumb_url IS NULL OR thumb_url = '')`
    )
    .all();
  let done = 0;
  for (const a of rows) {
    try {
      const thumbName = `${a.hash}.thumb.jpg`;
      const thumbAbs = path.join(config.mediaDir, thumbName);
      if (!fs.existsSync(thumbAbs) || fs.statSync(thumbAbs).size === 0) {
        await extractPoster(absPathOf(a.url), thumbAbs);
      }
      if (fs.existsSync(thumbAbs) && fs.statSync(thumbAbs).size > 0) {
        db.prepare('UPDATE assets SET thumb_url = ? WHERE id = ?').run(`/assets/${thumbName}`, a.id);
        done++;
      }
    } catch (err) {
      if (!silent) console.warn('[backfill] poster falhou p/ asset', a.id, String(err.message || err).slice(0, 120));
    }
  }
  if (!silent || done) console.log(`[backfill] miniaturas de video: ${done}/${rows.length}`);
  return { total: rows.length, done };
}

module.exports = { storedNameOf, absPathOf, applyProbeToAsset, deleteAssetFileIfOrphan, backfillVideoThumbs };
