'use strict';

const fs = require('fs');
const config = require('./config');
const { runMigrations } = require('./db/migrate');
const { createApp } = require('./app');

function bootstrap() {
  fs.mkdirSync(config.mediaDir, { recursive: true });

  // Aplica migrations pendentes no boot.
  runMigrations({ silent: true });

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[cms] M0 no ar em http://localhost:${config.port} (${config.env})`);
    console.log(`[cms] db: ${config.dbPath}`);
  });
}

bootstrap();
