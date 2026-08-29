'use strict';

const { newSerial, newToken } = require('./ids');
const { PLAYER_TYPES } = require('../adapters');

function normType(t) {
  return [...PLAYER_TYPES, 'unknown'].includes(t) ? t : 'unknown';
}

// Cria — ou re-vincula pelo hardware_id — um device ativo.
// Diferente de POST /api/pair/new, aqui o re-vínculo TROCA a empresa (o admin
// que resgatou o código está reivindicando o hardware para a empresa dele).
// Devolve { device, token, repaired }.
function provisionDevice(db, { companyId, hardwareId, playerType, name, groupId }) {
  const type = normType(playerType);
  const hw = hardwareId ? String(hardwareId) : null;

  if (hw) {
    const existing = db.prepare('SELECT * FROM devices WHERE hardware_id = ?').get(hw);
    if (existing) {
      const token = newToken();
      db.prepare(
        `UPDATE devices
            SET token = ?, company_id = ?,
                player_type = ?,
                name = COALESCE(?, name),
                group_id = ?,
                status = CASE WHEN status = 'disabled' THEN 'active' ELSE status END,
                last_seen = datetime('now'), updated_at = datetime('now')
          WHERE id = ?`
      ).run(
        token,
        companyId,
        type !== 'unknown' ? type : existing.player_type,
        name || null,
        groupId || null,
        existing.id
      );
      return { device: db.prepare('SELECT * FROM devices WHERE id = ?').get(existing.id), token, repaired: true };
    }
  }

  const serial = newSerial();
  const token = newToken();
  const info = db
    .prepare(
      `INSERT INTO devices (company_id, group_id, serial, name, status, player_type, hardware_id, token, last_seen)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, datetime('now'))`
    )
    .run(companyId, groupId || null, serial, name || null, type, hw, token);
  return {
    device: db.prepare('SELECT * FROM devices WHERE id = ?').get(Number(info.lastInsertRowid)),
    token,
    repaired: false,
  };
}

module.exports = { provisionDevice, normType };
