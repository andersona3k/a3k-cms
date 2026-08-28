'use strict';

// Cria a empresa padrao + role admin + usuario admin. Idempotente.

const config = require('../src/config');
const { getDb, closeDb } = require('../src/db');
const { runMigrations } = require('../src/db/migrate');
const { hashPassword } = require('../src/auth/password');

function seed() {
  runMigrations({ silent: true });
  const db = getDb();

  const companyName = config.seed.companyName;
  const adminEmail = config.seed.adminEmail.toLowerCase();
  const adminPassword = config.seed.adminPassword;

  const tx = db.exec.bind(db);
  tx('BEGIN');
  try {
    let company = db.prepare('SELECT * FROM companies WHERE name = ?').get(companyName);
    if (!company) {
      const info = db.prepare('INSERT INTO companies (name) VALUES (?)').run(companyName);
      company = { id: Number(info.lastInsertRowid), name: companyName };
      console.log(`[seed] empresa criada: ${companyName} (id ${company.id})`);
    } else {
      console.log(`[seed] empresa ja existe: ${companyName} (id ${company.id})`);
    }

    let role = db
      .prepare('SELECT * FROM roles WHERE company_id = ? AND name = ?')
      .get(company.id, 'admin');
    if (!role) {
      const info = db
        .prepare(
          `INSERT INTO roles (company_id, name, permissions) VALUES (?, 'admin', '{"*":true}')`
        )
        .run(company.id);
      role = { id: Number(info.lastInsertRowid) };
      console.log(`[seed] role admin criada (id ${role.id})`);
    } else {
      console.log(`[seed] role admin ja existe (id ${role.id})`);
    }

    const existingUser = db
      .prepare('SELECT id FROM users WHERE company_id = ? AND email = ?')
      .get(company.id, adminEmail);
    if (!existingUser) {
      db.prepare(
        `INSERT INTO users (company_id, role_id, email, password_hash, name, active, is_superadmin)
         VALUES (?, ?, ?, ?, 'Administrador', 1, 1)`
      ).run(company.id, role.id, adminEmail, hashPassword(adminPassword));
      console.log(`[seed] admin (superadmin) criado: ${adminEmail} / senha: ${adminPassword}`);
    } else {
      db.prepare('UPDATE users SET is_superadmin = 1 WHERE id = ?').run(existingUser.id);
      console.log(`[seed] admin ja existe: ${adminEmail}`);
    }

    tx('COMMIT');
  } catch (err) {
    tx('ROLLBACK');
    throw err;
  }
}

if (require.main === module) {
  try {
    seed();
    console.log('[seed] ok');
  } catch (err) {
    console.error('[seed] falhou:', err.message);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

module.exports = { seed };
