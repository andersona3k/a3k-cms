'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getDb, closeDb } = require('./index');

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function appliedNames(db) {
  const rows = db.prepare('SELECT name FROM _migrations ORDER BY name').all();
  return new Set(rows.map((r) => r.name));
}

function pendingFiles(db) {
  if (!fs.existsSync(config.migrationsDir)) return [];
  const applied = appliedNames(db);
  return fs
    .readdirSync(config.migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => !applied.has(f));
}

function runMigrations({ silent = false } = {}) {
  const db = getDb();
  ensureMigrationsTable(db);

  const files = pendingFiles(db);
  if (files.length === 0) {
    if (!silent) console.log('[migrate] nada pendente.');
    return { applied: [] };
  }

  const done = [];
  for (const file of files) {
    const sql = fs.readFileSync(path.join(config.migrationsDir, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
      db.exec('COMMIT');
      done.push(file);
      if (!silent) console.log(`[migrate] aplicada: ${file}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Falha na migration ${file}: ${err.message}`);
    }
  }
  return { applied: done };
}

if (require.main === module) {
  try {
    runMigrations();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

module.exports = { runMigrations };
