'use strict';

const path = require('path');
require('dotenv').config();

const ROOT = path.resolve(__dirname, '..');

function resolveFromRoot(p, fallback) {
  return path.resolve(ROOT, p || fallback);
}

const config = {
  root: ROOT,
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),

  dbPath: resolveFromRoot(process.env.DB_PATH, 'data/cms.sqlite'),
  mediaDir: resolveFromRoot(process.env.MEDIA_DIR, 'media'),
  migrationsDir: path.join(__dirname, 'db', 'migrations'),

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-insecure-secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  },

  seed: {
    companyName: process.env.SEED_COMPANY_NAME || 'A3K',
    adminEmail: process.env.SEED_ADMIN_EMAIL || 'admin@a3k.local',
    adminPassword: process.env.SEED_ADMIN_PASSWORD || 'admin123',
  },
};

if (config.env === 'production' && config.jwt.secret === 'dev-insecure-secret') {
  console.warn('[config] AVISO: JWT_SECRET nao definido em producao.');
}

module.exports = config;
