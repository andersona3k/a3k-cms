'use strict';

// Fluxo "Add player" (admin). O admin cria uma solicitacao de pareamento com
// nome/grupo/tipo pre-definidos e recebe um codigo + as instrucoes de
// provisionamento do adapter. O player informa o codigo em POST /api/pair/new
// (rota publica, em routes/player.js) e ja nasce vinculado.

const express = require('express');
const { getDb } = require('../db');
const { requireAuth, writeGuard } = require('../auth/middleware');
const { newPairCode } = require('../lib/ids');
const { getAdapter, PLAYER_TYPES } = require('../adapters');

const router = express.Router();
router.use(requireAuth, writeGuard('pairing:manage'));

const TTL_MINUTES = 30;

// marca como expiradas as pendentes vencidas (lazy)
function sweepExpired(db, companyId) {
  db.prepare(
    `UPDATE pair_requests
        SET status = 'expired', updated_at = datetime('now')
      WHERE company_id = ? AND status = 'pending'
        AND expires_at IS NOT NULL AND expires_at < datetime('now')`
  ).run(companyId);
}

function serialize(db, row) {
  const device = row.device_id
    ? db.prepare('SELECT id, serial, name, status, player_type FROM devices WHERE id = ?').get(row.device_id)
    : null;
  const group = row.group_id
    ? db.prepare('SELECT id, name FROM device_groups WHERE id = ?').get(row.group_id)
    : null;
  return { ...row, device, group };
}

// POST /api/pair/requests  { name?, group_id?, player_type? }
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body || {};

  let playerType = b.player_type || 'unknown';
  if (![...PLAYER_TYPES, 'unknown'].includes(playerType)) {
    return res.status(400).json({ error: 'player_type invalido' });
  }
  let groupId = null;
  if (b.group_id) {
    groupId = Number(b.group_id);
    const g = db
      .prepare('SELECT id FROM device_groups WHERE id = ? AND company_id = ?')
      .get(groupId, req.auth.companyId);
    if (!g) return res.status(400).json({ error: 'group_id invalido' });
  }

  // gera codigo unico (poucas tentativas bastam)
  let code;
  for (let i = 0; i < 10; i++) {
    const c = newPairCode();
    if (!db.prepare('SELECT 1 FROM pair_requests WHERE code = ?').get(c)) { code = c; break; }
  }
  if (!code) return res.status(500).json({ error: 'nao consegui gerar codigo' });

  const info = db
    .prepare(
      `INSERT INTO pair_requests (company_id, code, name, group_id, player_type, expires_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', '+${TTL_MINUTES} minutes'))`
    )
    .run(req.auth.companyId, code, (b.name || '').trim() || null, groupId, playerType);

  const row = db.prepare('SELECT * FROM pair_requests WHERE id = ?').get(Number(info.lastInsertRowid));
  const adapter = getAdapter(playerType);
  res.status(201).json({
    request: serialize(db, row),
    provisioning: adapter.provisioning(),
    capabilities: adapter.capabilities(),
  });
});

// GET /api/pair/requests
router.get('/', (req, res) => {
  const db = getDb();
  sweepExpired(db, req.auth.companyId);
  const rows = db
    .prepare('SELECT * FROM pair_requests WHERE company_id = ? ORDER BY id DESC')
    .all(req.auth.companyId);
  res.json({ requests: rows.map((r) => serialize(db, r)) });
});

// GET /api/pair/requests/:id  (poll ate consumir)
router.get('/:id', (req, res) => {
  const db = getDb();
  sweepExpired(db, req.auth.companyId);
  const row = db
    .prepare('SELECT * FROM pair_requests WHERE id = ? AND company_id = ?')
    .get(Number(req.params.id), req.auth.companyId);
  if (!row) return res.status(404).json({ error: 'solicitacao nao encontrada' });
  res.json({ request: serialize(db, row) });
});

// DELETE /api/pair/requests/:id  (cancela)
router.delete('/:id', (req, res) => {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM pair_requests WHERE id = ? AND company_id = ?')
    .get(Number(req.params.id), req.auth.companyId);
  if (!row) return res.status(404).json({ error: 'solicitacao nao encontrada' });
  if (row.status === 'consumed') {
    return res.status(409).json({ error: 'solicitacao ja consumida' });
  }
  db.prepare(`UPDATE pair_requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`)
    .run(row.id);
  res.json({ ok: true });
});

module.exports = router;
