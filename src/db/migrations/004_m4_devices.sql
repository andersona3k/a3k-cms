-- M4 — dispositivos a fundo. Fluxo "Add player": o admin gera um codigo de
-- pareamento (com nome/grupo/tipo pre-definidos), o player informa esse codigo
-- no primeiro boot e ja aparece vinculado. Sem codigo, o pair continua abrindo
-- um device solto (comportamento do M1).

CREATE TABLE pair_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT,
  group_id    INTEGER REFERENCES device_groups(id) ON DELETE SET NULL,
  player_type TEXT NOT NULL DEFAULT 'unknown'
                CHECK (player_type IN ('tizen', 'webos', 'android', 'windows', 'unknown')),
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'consumed', 'expired', 'cancelled')),
  device_id   INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  expires_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_pair_requests_company ON pair_requests (company_id);
CREATE INDEX idx_pair_requests_status ON pair_requests (status);
