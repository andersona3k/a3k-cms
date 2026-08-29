'use strict';

const path = require('path');
const express = require('express');
const pkg = require('../package.json');
const config = require('./config');
const authRoutes = require('./auth/routes');
const { requireAuth } = require('./auth/middleware');
const { listAdapters, PLAYER_TYPES } = require('./adapters');

const assetsRoutes = require('./routes/assets');
const foldersRoutes = require('./routes/folders');
const playlistsRoutes = require('./routes/playlists');
const playlistFoldersRoutes = require('./routes/playlistFolders');
const devicesRoutes = require('./routes/devices');
const deviceGroupsRoutes = require('./routes/deviceGroups');
const pairingRoutes = require('./routes/pairing');
const activationRoutes = require('./routes/activation');
const downloadsRoutes = require('./routes/downloads');
const companiesRoutes = require('./routes/companies');
const rolesRoutes = require('./routes/roles');
const usersRoutes = require('./routes/users');
const playerRoutes = require('./routes/player');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Health — sem auth.
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: pkg.name, version: pkg.version, milestone: 'M6' });
  });

  // Auth.
  app.use('/api/auth', authRoutes);

  // Adapters de player (stubs) — exige admin autenticado.
  app.get('/api/adapters', requireAuth, (req, res) => {
    res.json({ player_types: PLAYER_TYPES, adapters: listAdapters() });
  });

  // Add player (JWT) — antes do playerRoutes p/ nao colidir com /api/pair/new.
  app.use('/api/pair/requests', pairingRoutes);

  // Ativação iniciada pelo player (o link gera o código; o admin resgata).
  // /new e /status sao publicos; /redeem exige JWT (guard dentro da rota).
  app.use('/api/activation', activationRoutes);

  // Player (sem JWT: pair aberto, manifest/heartbeat via token do device).
  // Registrado ANTES do router admin de /api/devices para que
  // /api/devices/:id/manifest nao caia no requireAuth do painel.
  app.use('/api', playerRoutes);

  // Admin (JWT).
  app.use('/api/assets', assetsRoutes);
  app.use('/api/folders', foldersRoutes);
  app.use('/api/playlist-folders', playlistFoldersRoutes);
  app.use('/api/playlists', playlistsRoutes);
  app.use('/api/device-groups', deviceGroupsRoutes);
  app.use('/api/devices', devicesRoutes);

  // M5 — multiempresa + permissoes.
  app.use('/api/companies', companiesRoutes);
  app.use('/api/roles', rolesRoutes);
  app.use('/api/users', usersRoutes);
  app.use('/api/downloads', downloadsRoutes);

  // Download de midia.
  app.use(
    '/assets',
    express.static(config.mediaDir, {
      index: false,
      setHeaders: (res) => res.set('Cache-Control', 'public, max-age=31536000, immutable'),
    })
  );

  // Arquivos para download (APK do player Android, etc.) — <media>/downloads/.
  app.use('/downloads', express.static(path.join(config.mediaDir, 'downloads'), { index: false }));

  // Player web (kiosk) e mini painel admin — HTML estatico; a autenticacao real
  // acontece nas chamadas /api que cada pagina faz.
  app.use('/player', express.static(path.join(__dirname, '..', 'public', 'player')));
  app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));

  // libs de frontend servidas direto do node_modules (SortableJS p/ drag-drop).
  app.use(
    '/vendor/sortablejs',
    express.static(path.join(__dirname, '..', 'node_modules', 'sortablejs'), { index: false })
  );

  app.get('/', (req, res) => {
    res.type('text/plain').send(
      `${pkg.name} v${pkg.version} — M6 (day-parting)\n\n` +
        `player kiosk : /player/\n` +
        `admin        : /admin/\n` +
        `health       : /api/health\n`
    );
  });

  app.use((req, res) => res.status(404).json({ error: 'nao encontrado' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[erro]', err);
    res.status(err.status || 500).json({ error: err.message || 'erro interno' });
  });

  return app;
}

module.exports = { createApp };
