-- Aba Playlists: pastas (arvore lateral) + metadados de gestao.
--
-- playlist_folders: mesma ideia de `folders` (assets), independente. Raiz
--   ("Projeto") garantida pelo admin. Ate 3 niveis na UI.
-- playlists.folder_id   pasta (NULL = sem pasta / "Projeto")
-- playlists.created_by   e-mail de quem criou
-- playlists.valid_from   inicio da vigencia (YYYY-MM-DD), opcional
-- playlists.valid_until  fim da vigencia (YYYY-MM-DD), opcional
-- playlists.suspended    0/1 -> quando 1, o manifest sai vazio (playlist parada)
-- playlists.archived     0/1 -> some da lista normal do admin

CREATE TABLE playlist_folders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parent_id  INTEGER REFERENCES playlist_folders(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, parent_id, name)
);
CREATE INDEX idx_playlist_folders_company ON playlist_folders (company_id);

ALTER TABLE playlists ADD COLUMN folder_id   INTEGER REFERENCES playlist_folders(id) ON DELETE SET NULL;
ALTER TABLE playlists ADD COLUMN created_by  TEXT;
ALTER TABLE playlists ADD COLUMN valid_from  TEXT;
ALTER TABLE playlists ADD COLUMN valid_until TEXT;
ALTER TABLE playlists ADD COLUMN suspended   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE playlists ADD COLUMN archived    INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_playlists_folder ON playlists (folder_id);
