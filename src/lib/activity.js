'use strict';

// Trilha de auditoria de devices e grupos (tabela activity_log, migration 008).

/**
 * Registra uma mudanca. Silencioso: nunca deixa a rota principal quebrar por
 * causa do log.
 * @param {object} db
 * @param {object} p
 * @param {number} p.companyId
 * @param {'device'|'group'} p.targetType
 * @param {number} p.targetId
 * @param {string} p.action        codigo curto (ex.: 'assign', 'group', 'rename')
 * @param {string} [p.detail]      mensagem legivel (pt-br)
 * @param {object} [p.actor]       req.auth ({ userId, email })
 */
function logActivity(db, p) {
  try {
    db.prepare(
      `INSERT INTO activity_log
         (company_id, target_type, target_id, action, detail, actor_user_id, actor_email)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      p.companyId,
      p.targetType,
      p.targetId,
      p.action,
      p.detail || null,
      (p.actor && p.actor.userId) || null,
      (p.actor && p.actor.email) || null
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[activity] falha ao registrar:', err.message);
  }
}

/**
 * Ultimas N entradas que interessam a um device: as do proprio device + as do
 * grupo a que ele pertence, mescladas por data.
 */
function recentForDevice(db, { companyId, deviceId, groupId, limit = 5 }) {
  const lim = Math.max(1, Math.min(50, Number(limit) || 5));
  if (groupId) {
    return db
      .prepare(
        `SELECT id, target_type, target_id, action, detail, actor_email, created_at
           FROM activity_log
          WHERE company_id = ?
            AND ( (target_type = 'device' AND target_id = ?)
               OR (target_type = 'group'  AND target_id = ?) )
          ORDER BY datetime(created_at) DESC, id DESC
          LIMIT ?`
      )
      .all(companyId, deviceId, groupId, lim);
  }
  return db
    .prepare(
      `SELECT id, target_type, target_id, action, detail, actor_email, created_at
         FROM activity_log
        WHERE company_id = ? AND target_type = 'device' AND target_id = ?
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT ?`
    )
    .all(companyId, deviceId, lim);
}

module.exports = { logActivity, recentForDevice };
