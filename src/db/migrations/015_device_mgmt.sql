-- Gestão remota do device (aba Dispositivos): comandos, capturas de tela e
-- log de comunicação. Os comandos pendentes viajam na resposta do heartbeat;
-- o player executa e dá ack.

CREATE TABLE device_commands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,                         -- ping | restart | clear_cache | unassign_playlist | screenshot
  params      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'ok', 'error')),
  result      TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  done_at     TEXT
);
CREATE INDEX idx_devcmd_device ON device_commands (device_id, id);
CREATE INDEX idx_devcmd_pending ON device_commands (device_id, status);

CREATE TABLE device_screenshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  bytes       INTEGER,
  source      TEXT NOT NULL DEFAULT 'auto'
                CHECK (source IN ('auto', 'manual')),
  taken_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_devshot_device ON device_screenshots (device_id, id);

-- Cada ciclo (a cada comm_interval min) o player faz 4 tentativas e loga cada uma.
CREATE TABLE device_comm_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  device_id   INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  attempt     INTEGER NOT NULL,                      -- 1..4
  ok          INTEGER NOT NULL,                      -- 0/1
  ms          INTEGER,
  detail      TEXT
);
CREATE INDEX idx_devcomm_device ON device_comm_log (device_id, id);

ALTER TABLE devices ADD COLUMN screenshot_interval INTEGER NOT NULL DEFAULT 30;  -- minutos (1/5/10/30/60)
ALTER TABLE devices ADD COLUMN comm_interval INTEGER NOT NULL DEFAULT 60;        -- minutos do log de comunicação
