-- M0 — Fundacao. Schema completo do CMS de Digital Signage A3K.
-- Tudo escopado por company_id desde a primeira linha (multiempresa no schema,
-- enforcement so no M5). Adapters de player sao codigo (src/adapters), aqui
-- so gravamos player_type + capabilities por device.

-- ---------------------------------------------------------------------------
-- Configuracao: empresas, papeis, usuarios
-- ---------------------------------------------------------------------------

CREATE TABLE companies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- JSON: lista de strings de permissao, ou {"*": true} para admin total.
  permissions TEXT NOT NULL DEFAULT '{"*":true}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, name)
);

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role_id       INTEGER REFERENCES roles(id) ON DELETE SET NULL,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  last_login    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, email)
);

CREATE INDEX idx_users_company ON users (company_id);
CREATE INDEX idx_roles_company ON roles (company_id);

-- ---------------------------------------------------------------------------
-- Biblioteca / Conteudo: pastas e assets
-- ---------------------------------------------------------------------------

CREATE TABLE folders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parent_id  INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, parent_id, name)
);

CREATE INDEX idx_folders_company ON folders (company_id);
CREATE INDEX idx_folders_parent ON folders (parent_id);

CREATE TABLE assets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  folder_id  INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  type       TEXT NOT NULL CHECK (type IN ('image', 'video', 'audio', 'html', 'other')),
  filename   TEXT NOT NULL,
  url        TEXT NOT NULL,
  hash       TEXT,
  size_bytes INTEGER,
  -- metadados extraidos so no M2 (ffprobe/sharp); nullable na fundacao.
  width      INTEGER,
  height     INTEGER,
  duration   REAL,
  fps        REAL,
  bitrate    INTEGER,
  codec      TEXT,
  mime       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_assets_company ON assets (company_id);
CREATE INDEX idx_assets_folder ON assets (folder_id);
CREATE INDEX idx_assets_hash ON assets (hash);

-- ---------------------------------------------------------------------------
-- Playlist
-- ---------------------------------------------------------------------------

CREATE TABLE playlists (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  -- alterar a playlist incrementa version -> dispara re-sync no player.
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, name)
);

CREATE INDEX idx_playlists_company ON playlists (company_id);

CREATE TABLE playlist_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  asset_id    INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  ordem       INTEGER NOT NULL DEFAULT 0,
  duration    REAL,
  -- schedule / day-parting entra no M6. Coluna JSON reservada, nullable.
  schedule    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_playlist_items_playlist ON playlist_items (playlist_id, ordem);
CREATE INDEX idx_playlist_items_asset ON playlist_items (asset_id);

-- ---------------------------------------------------------------------------
-- Dispositivos: grupos, devices, assignments
-- ---------------------------------------------------------------------------

CREATE TABLE device_groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, name)
);

CREATE INDEX idx_device_groups_company ON device_groups (company_id);

CREATE TABLE devices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  group_id     INTEGER REFERENCES device_groups(id) ON DELETE SET NULL,
  serial       TEXT NOT NULL UNIQUE,
  name         TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'active', 'disabled')),
  player_type  TEXT NOT NULL DEFAULT 'unknown'
                 CHECK (player_type IN ('tizen', 'webos', 'android', 'windows', 'unknown')),
  last_seen    TEXT,
  -- JSON: capacidades reportadas no heartbeat (reboot, screenshot, ...).
  capabilities TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_devices_company ON devices (company_id);
CREATE INDEX idx_devices_group ON devices (group_id);

CREATE TABLE assignments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('device', 'group')),
  target_id   INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  -- um alvo (device ou grupo) aponta para no maximo uma playlist.
  -- device sem assignment proprio herda a do grupo (resolvido em codigo).
  UNIQUE (company_id, target_type, target_id)
);

CREATE INDEX idx_assignments_company ON assignments (company_id);
CREATE INDEX idx_assignments_playlist ON assignments (playlist_id);
CREATE INDEX idx_assignments_target ON assignments (target_type, target_id);
