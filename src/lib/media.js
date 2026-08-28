'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');

fs.mkdirSync(config.mediaDir, { recursive: true });
const TMP_DIR = path.join(config.mediaDir, '.tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_DIR),
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
});

function assetTypeFromMime(mime) {
  if (!mime) return 'other';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'text/html') return 'html';
  return 'other';
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(filePath);
    rs.on('error', reject);
    rs.on('data', (d) => hash.update(d));
    rs.on('end', () => resolve(hash.digest('hex')));
  });
}

// Move o upload temporario para media/<hash><ext>. Se ja existir (mesmo hash),
// descarta o novo e reaproveita. Retorna { storedName, hash, size }.
async function finalizeUpload(tmpPath, originalName) {
  const hash = await sha256File(tmpPath);
  const ext = path.extname(originalName || '').toLowerCase();
  const storedName = `${hash}${ext}`;
  const dest = path.join(config.mediaDir, storedName);
  const { size } = fs.statSync(tmpPath);

  if (fs.existsSync(dest)) {
    fs.rmSync(tmpPath);
  } else {
    fs.renameSync(tmpPath, dest);
  }
  return { storedName, hash, size };
}

module.exports = { upload, assetTypeFromMime, finalizeUpload, sha256File };
