'use strict';

const express = require('express');
const { getDb } = require('../db');
const { requireAuth } = require('../auth/middleware');
const { upload, assetTypeFromMime, finalizeUpload } = require('../lib/media');
const { applyProbeToAsset, deleteAssetFileIfOrphan } = require('../lib/library');

const router = express.Router();

function scoped(db, id, companyId) {
  return db
    .prepare('SELECT * FROM assets WHERE id = ? AND company_id = ?')
    .get(Number(id), companyId);
}

// POST /api/assets  (multipart: "file", opcional "folder_id")
// M2: extrai metadados no upload (sharp p/ imagem, ffprobe p/ video/audio).
router.post('/', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'campo "file" ausente' });

    const { storedName, hash, size } = await finalizeUpload(
      req.file.path,
      req.file.originalname
    );

    const db = getDb();
    const folderId = req.body.folder_id ? Number(req.body.folder_id) : null;
    if (folderId) {
      const f = db
        .prepare('SELECT id FROM folders WHERE id = ? AND company_id = ?')
        .get(folderId, req.auth.companyId);
      if (!f) return res.status(400).json({ error: 'folder_id invalido' });
    }

    const existing = db
      .prepare('SELECT * FROM assets WHERE company_id = ? AND hash = ?')
      .get(req.auth.companyId, hash);
    if (existing) {
      return res.status(200).json({ asset: existing, deduped: true });
    }

    const info = db
      .prepare(
        `INSERT INTO assets (company_id, folder_id, type, filename, url, hash, size_bytes, mime, probe_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
      )
      .run(
        req.auth.companyId,
        folderId,
        assetTypeFromMime(req.file.mimetype),
        req.file.originalname,
        `/assets/${storedName}`,
        hash,
        size,
        req.file.mimetype || null
      );

    let asset = scoped(db, Number(info.lastInsertRowid), req.auth.companyId);
    asset = await applyProbeToAsset(db, asset);
    res.status(201).json({ asset });
  } catch (err) {
    next(err);
  }
});

// GET /api/assets[?folder_id=N|unfiled]
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const { folder_id: folderId } = req.query;
  let rows;
  if (folderId === undefined) {
    rows = db
      .prepare('SELECT * FROM assets WHERE company_id = ? ORDER BY id DESC')
      .all(req.auth.companyId);
  } else if (folderId === 'unfiled' || folderId === 'null' || folderId === '') {
    rows = db
      .prepare('SELECT * FROM assets WHERE company_id = ? AND folder_id IS NULL ORDER BY id DESC')
      .all(req.auth.companyId);
  } else {
    rows = db
      .prepare('SELECT * FROM assets WHERE company_id = ? AND folder_id = ? ORDER BY id DESC')
      .all(req.auth.companyId, Number(folderId));
  }
  res.json({ assets: rows });
});

// GET /api/assets/:id  (painel de info)
router.get('/:id', requireAuth, (req, res) => {
  const asset = scoped(getDb(), req.params.id, req.auth.companyId);
  if (!asset) return res.status(404).json({ error: 'asset nao encontrado' });
  res.json({ asset });
});

// PATCH /api/assets/:id  { folder_id?, filename? }   (mover / renomear)
router.patch('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const asset = scoped(db, req.params.id, req.auth.companyId);
  if (!asset) return res.status(404).json({ error: 'asset nao encontrado' });

  const b = req.body || {};
  const sets = [];
  const vals = [];

  if (b.folder_id !== undefined) {
    const fid = b.folder_id === null || b.folder_id === '' ? null : Number(b.folder_id);
    if (fid !== null) {
      const f = db
        .prepare('SELECT id FROM folders WHERE id = ? AND company_id = ?')
        .get(fid, req.auth.companyId);
      if (!f) return res.status(400).json({ error: 'folder_id invalido' });
    }
    sets.push('folder_id = ?'); vals.push(fid);
  }
  if (b.filename !== undefined) {
    const fn = String(b.filename).trim();
    if (!fn) return res.status(400).json({ error: 'filename vazio' });
    sets.push('filename = ?'); vals.push(fn);
  }
  if (!sets.length) return res.status(400).json({ error: 'nada para atualizar' });

  sets.push(`updated_at = datetime('now')`);
  vals.push(asset.id);
  db.prepare(`UPDATE assets SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ asset: scoped(db, asset.id, req.auth.companyId) });
});

// POST /api/assets/:id/reprobe   (re-extrai metadados)
router.post('/:id/reprobe', requireAuth, async (req, res, next) => {
  try {
    const db = getDb();
    const asset = scoped(db, req.params.id, req.auth.companyId);
    if (!asset) return res.status(404).json({ error: 'asset nao encontrado' });
    const updated = await applyProbeToAsset(db, asset);
    res.json({ asset: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/assets/:id
router.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const asset = scoped(db, req.params.id, req.auth.companyId);
  if (!asset) return res.status(404).json({ error: 'asset nao encontrado' });

  const affectedPlaylists = db
    .prepare('SELECT DISTINCT playlist_id FROM playlist_items WHERE asset_id = ?')
    .all(asset.id)
    .map((r) => r.playlist_id);
  if (affectedPlaylists.length > 0 && req.query.force !== 'true') {
    return res.status(409).json({
      error: 'asset em uso em playlist(s)',
      playlists: affectedPlaylists,
      hint: 'repita com ?force=true',
    });
  }

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM assets WHERE id = ?').run(asset.id); // playlist_items caem por FK CASCADE
    for (const pid of affectedPlaylists) {
      db.prepare(
        `UPDATE playlists SET version = version + 1, updated_at = datetime('now') WHERE id = ?`
      ).run(pid);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  deleteAssetFileIfOrphan(db, asset);
  res.json({ ok: true, bumped_playlists: affectedPlaylists });
});

module.exports = router;
