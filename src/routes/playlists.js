'use strict';

const express = require('express');
const { getDb } = require('../db');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();
router.use(requireAuth);

function getPlaylistScoped(db, id, companyId) {
  return db
    .prepare('SELECT * FROM playlists WHERE id = ? AND company_id = ?')
    .get(Number(id), companyId);
}

// Qualquer mudanca no conteudo incrementa version -> dispara re-sync no player.
function bumpVersion(db, playlistId) {
  db.prepare(
    `UPDATE playlists SET version = version + 1, updated_at = datetime('now') WHERE id = ?`
  ).run(playlistId);
}

function itemsOf(db, playlistId) {
  return db
    .prepare(
      `SELECT pi.id, pi.asset_id, pi.ordem, pi.duration,
              a.type, a.filename, a.url, a.hash, a.size_bytes
         FROM playlist_items pi
         JOIN assets a ON a.id = pi.asset_id
        WHERE pi.playlist_id = ?
        ORDER BY pi.ordem, pi.id`
    )
    .all(playlistId);
}

// POST /api/playlists  { name }
router.post('/', (req, res) => {
  const name = (req.body && req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name obrigatorio' });
  const db = getDb();
  try {
    const info = db
      .prepare('INSERT INTO playlists (company_id, name) VALUES (?, ?)')
      .run(req.auth.companyId, name);
    const playlist = db
      .prepare('SELECT * FROM playlists WHERE id = ?')
      .get(Number(info.lastInsertRowid));
    res.status(201).json({ playlist });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'ja existe playlist com esse nome' });
    }
    throw err;
  }
});

// GET /api/playlists
router.get('/', (req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM playlist_items WHERE playlist_id = p.id) AS item_count
         FROM playlists p WHERE p.company_id = ? ORDER BY p.id DESC`
    )
    .all(req.auth.companyId);
  res.json({ playlists: rows });
});

// GET /api/playlists/:id  (com itens)
router.get('/:id', (req, res) => {
  const db = getDb();
  const playlist = getPlaylistScoped(db, req.params.id, req.auth.companyId);
  if (!playlist) return res.status(404).json({ error: 'playlist nao encontrada' });
  res.json({ playlist, items: itemsOf(db, playlist.id) });
});

// PATCH /api/playlists/:id  { name }
router.patch('/:id', (req, res) => {
  const db = getDb();
  const playlist = getPlaylistScoped(db, req.params.id, req.auth.companyId);
  if (!playlist) return res.status(404).json({ error: 'playlist nao encontrada' });
  const name = (req.body && req.body.name || '').trim();
  if (name) {
    db.prepare(`UPDATE playlists SET name = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(name, playlist.id);
  }
  res.json({ playlist: getPlaylistScoped(db, playlist.id, req.auth.companyId) });
});

// POST /api/playlists/:id/items  { asset_id, duration?, ordem? }
router.post('/:id/items', (req, res) => {
  const db = getDb();
  const playlist = getPlaylistScoped(db, req.params.id, req.auth.companyId);
  if (!playlist) return res.status(404).json({ error: 'playlist nao encontrada' });

  const assetId = Number(req.body && req.body.asset_id);
  if (!assetId) return res.status(400).json({ error: 'asset_id obrigatorio' });
  const asset = db
    .prepare('SELECT * FROM assets WHERE id = ? AND company_id = ?')
    .get(assetId, req.auth.companyId);
  if (!asset) return res.status(400).json({ error: 'asset_id invalido' });

  let ordem = req.body.ordem;
  if (ordem === undefined || ordem === null) {
    const max = db
      .prepare('SELECT COALESCE(MAX(ordem), -1) AS m FROM playlist_items WHERE playlist_id = ?')
      .get(playlist.id).m;
    ordem = max + 1;
  }
  const duration =
    req.body.duration != null ? Number(req.body.duration) : asset.duration || 10;

  db.exec('BEGIN');
  try {
    const info = db
      .prepare(
        `INSERT INTO playlist_items (playlist_id, asset_id, ordem, duration)
         VALUES (?, ?, ?, ?)`
      )
      .run(playlist.id, assetId, ordem, duration);
    bumpVersion(db, playlist.id);
    db.exec('COMMIT');
    res.status(201).json({
      item: db.prepare('SELECT * FROM playlist_items WHERE id = ?').get(Number(info.lastInsertRowid)),
      version: getPlaylistScoped(db, playlist.id, req.auth.companyId).version,
    });
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
});

// DELETE /api/playlists/:id/items/:itemId
router.delete('/:id/items/:itemId', (req, res) => {
  const db = getDb();
  const playlist = getPlaylistScoped(db, req.params.id, req.auth.companyId);
  if (!playlist) return res.status(404).json({ error: 'playlist nao encontrada' });

  db.exec('BEGIN');
  try {
    const info = db
      .prepare('DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?')
      .run(Number(req.params.itemId), playlist.id);
    if (info.changes === 0) {
      db.exec('ROLLBACK');
      return res.status(404).json({ error: 'item nao encontrado' });
    }
    bumpVersion(db, playlist.id);
    db.exec('COMMIT');
    res.json({ ok: true, version: getPlaylistScoped(db, playlist.id, req.auth.companyId).version });
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
});

// PUT /api/playlists/:id/items  { items: [{ asset_id, duration }] }  (substitui tudo)
router.put('/:id/items', (req, res) => {
  const db = getDb();
  const playlist = getPlaylistScoped(db, req.params.id, req.auth.companyId);
  if (!playlist) return res.status(404).json({ error: 'playlist nao encontrada' });
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : null;
  if (!items) return res.status(400).json({ error: 'items[] obrigatorio' });

  const assetIds = items.map((i) => Number(i.asset_id));
  const placeholders = assetIds.map(() => '?').join(',') || 'NULL';
  const found = db
    .prepare(`SELECT id FROM assets WHERE company_id = ? AND id IN (${placeholders})`)
    .all(req.auth.companyId, ...assetIds)
    .map((r) => r.id);
  if (found.length !== new Set(assetIds).size) {
    return res.status(400).json({ error: 'algum asset_id e invalido' });
  }

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(playlist.id);
    const ins = db.prepare(
      `INSERT INTO playlist_items (playlist_id, asset_id, ordem, duration) VALUES (?, ?, ?, ?)`
    );
    items.forEach((it, idx) => {
      ins.run(playlist.id, Number(it.asset_id), idx, it.duration != null ? Number(it.duration) : 10);
    });
    bumpVersion(db, playlist.id);
    db.exec('COMMIT');
    res.json({ items: itemsOf(db, playlist.id), version: getPlaylistScoped(db, playlist.id, req.auth.companyId).version });
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
});

module.exports = router;
