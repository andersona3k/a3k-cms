'use strict';

const express = require('express');
const { getDb } = require('../db');
const { requireAuth } = require('../auth/middleware');
const { upload, assetTypeFromMime, finalizeUpload } = require('../lib/media');

const router = express.Router();

// POST /api/assets  (multipart: campo "file", opcional "folder_id")
// M1: upload simples, sem ffprobe/sharp (metadados ficam null ate o M2).
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

    // Dedup por hash dentro da empresa.
    const existing = db
      .prepare('SELECT * FROM assets WHERE company_id = ? AND hash = ?')
      .get(req.auth.companyId, hash);
    if (existing) {
      return res.status(200).json({ asset: existing, deduped: true });
    }

    const info = db
      .prepare(
        `INSERT INTO assets (company_id, folder_id, type, filename, url, hash, size_bytes, mime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
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

    const asset = db
      .prepare('SELECT * FROM assets WHERE id = ?')
      .get(Number(info.lastInsertRowid));
    res.status(201).json({ asset });
  } catch (err) {
    next(err);
  }
});

// GET /api/assets
router.get('/', requireAuth, (req, res) => {
  const rows = getDb()
    .prepare('SELECT * FROM assets WHERE company_id = ? ORDER BY id DESC')
    .all(req.auth.companyId);
  res.json({ assets: rows });
});

// GET /api/assets/:id
router.get('/:id', requireAuth, (req, res) => {
  const row = getDb()
    .prepare('SELECT * FROM assets WHERE id = ? AND company_id = ?')
    .get(Number(req.params.id), req.auth.companyId);
  if (!row) return res.status(404).json({ error: 'asset nao encontrado' });
  res.json({ asset: row });
});

module.exports = router;
