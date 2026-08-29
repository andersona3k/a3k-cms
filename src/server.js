'use strict';

const fs = require('fs');
const config = require('./config');
const { runMigrations } = require('./db/migrate');
const { createApp } = require('./app');
const { getDb } = require('./db');
const { backfillVideoThumbs } = require('./lib/library');

function bootstrap() {
  fs.mkdirSync(config.mediaDir, { recursive: true });

  // Aplica migrations pendentes no boot.
  runMigrations({ silent: true });

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[cms] M0 no ar em http://localhost:${config.port} (${config.env})`);
    console.log(`[cms] db: ${config.dbPath}`);
    // gera miniaturas de videos antigos sem poster (nao bloqueia o boot)
    Promise.resolve().then(() => backfillVideoThumbs(getDb())).catch(() => {});
  });
}

bootstrap();
