'use strict';

// Arquivos para download — hoje só o APK do player Android.
// GET  /api/downloads/apk/info  (público) -> { exists, size, updated_at, url }
// POST /api/downloads/apk       (admin)   -> sobe/substitui <media>/downloads/a3k-player.apk
// O arquivo em si é servido estático em /downloads/a3k-player.apk (src/app.js).

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('../config');
const { requireAuth, writeGuard } = require('../auth/middleware');

const router = express.Router();
const DIR = path.join(config.mediaDir, 'downloads');
const APK = path.join(DIR, 'a3k-player.apk');
const APK_URL = '/downloads/a3k-player.apk';

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { fs.mkdirSync(DIR, { recursive: true }); cb(null, DIR); },
    filename: (req, file, cb) => cb(null, 'a3k-player.apk'),
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
});

router.get('/apk/info', (req, res) => {
  try {
    const st = fs.statSync(APK);
    res.json({ exists: true, size: st.size, updated_at: st.mtime.toISOString(), url: APK_URL });
  } catch {
    res.json({ exists: false });
  }
});

router.post('/apk', requireAuth, writeGuard('pairing:manage'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'campo "file" ausente' });
  if (!/\.apk$/i.test(req.file.originalname || '')) {
    try { fs.unlinkSync(APK); } catch {}
    return res.status(400).json({ error: 'envie um arquivo .apk' });
  }
  const st = fs.statSync(APK);
  res.status(201).json({ ok: true, size: st.size, url: APK_URL, updated_at: st.mtime.toISOString() });
});

module.exports = router;
