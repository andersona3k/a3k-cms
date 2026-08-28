-- Mais parametros por item de playlist:
--  rotation   NULL = herda da playlist; senao 0/90/180/270
--  mirror     NULL = herda; senao 0/1 (espelhamento horizontal)
--  suspended  0/1  -> item fica na playlist mas nao toca (pre-salvo, volta a qualquer hora)
-- E espelhamento no nivel da playlist (o giro ja existe: playlists.rotation).

ALTER TABLE playlists ADD COLUMN mirror INTEGER NOT NULL DEFAULT 0;

ALTER TABLE playlist_items ADD COLUMN rotation  INTEGER;
ALTER TABLE playlist_items ADD COLUMN mirror    INTEGER;
ALTER TABLE playlist_items ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_playlist_items_suspended ON playlist_items (playlist_id, suspended);
