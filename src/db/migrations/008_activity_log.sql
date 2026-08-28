-- Trilha de auditoria + carimbo de "quando o player aplicou a versao".
--
-- activity_log: uma linha por mudanca relevante de device/grupo (atribuir
-- playlist, trocar de grupo, renomear...). O modal de edicao do player le as
-- ultimas N do proprio device + do grupo dele.
--
-- devices.last_version_at: quando last_version mudou pela ultima vez (setado
-- no heartbeat so quando a versao aplicada muda). Alimenta a "data de
-- atualizacao" na barra de progresso do admin.

CREATE TABLE activity_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  target_type   TEXT NOT NULL CHECK (target_type IN ('device', 'group')),
  target_id     INTEGER NOT NULL,
  action        TEXT NOT NULL,
  detail        TEXT,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_email   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_activity_target
  ON activity_log (company_id, target_type, target_id, created_at);

ALTER TABLE devices ADD COLUMN last_version_at TEXT;
