'use strict';

const express = require('express');
const pkg = require('../package.json');
const authRoutes = require('./auth/routes');
const { requireAuth } = require('./auth/middleware');
const { listAdapters, PLAYER_TYPES } = require('./adapters');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Health — sem auth.
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: pkg.name, version: pkg.version, milestone: 'M0' });
  });

  // Auth.
  app.use('/api/auth', authRoutes);

  // Adapters de player (stubs do M0) — exige admin autenticado.
  app.get('/api/adapters', requireAuth, (req, res) => {
    res.json({ player_types: PLAYER_TYPES, adapters: listAdapters() });
  });

  // Raiz informativa.
  app.get('/', (req, res) => {
    res.type('text/plain').send(
      `${pkg.name} v${pkg.version} — M0 (Fundacao)\n` +
        `GET /api/health | POST /api/auth/login | GET /api/auth/me | GET /api/adapters\n`
    );
  });

  // 404.
  app.use((req, res) => {
    res.status(404).json({ error: 'nao encontrado' });
  });

  // Handler de erro.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[erro]', err);
    res.status(err.status || 500).json({ error: err.message || 'erro interno' });
  });

  return app;
}

module.exports = { createApp };
