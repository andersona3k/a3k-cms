-- Ativação iniciada pelo PLAYER. A pessoa abre o link do player, o player chama
-- POST /api/activation/new e o servidor cunha um código curto (status 'pending').
-- O admin digita esse código no painel (POST /api/activation/redeem) -> cria o
-- device na empresa dele, amarra o assignment na playlist escolhida e marca o
-- código como 'redeemed' (uso único). O player faz poll de /status até virar.
--
-- Inverte o fluxo "Add player" do M4 (onde o admin gerava o código). As rotas
-- /api/pair/* seguem existindo por baixo, mas a UI passa a usar este fluxo.

CREATE TABLE activation_codes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,
  hardware_id  TEXT NOT NULL,
  player_type  TEXT NOT NULL DEFAULT 'unknown'
                 CHECK (player_type IN ('tizen', 'webos', 'android', 'windows', 'unknown')),
  capabilities TEXT,
  poll_secret  TEXT NOT NULL,               -- devolvido só a quem criou; exigido no /status
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'redeemed', 'expired')),
  company_id   INTEGER REFERENCES companies(id) ON DELETE CASCADE,   -- setado no redeem
  device_id    INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  playlist_id  INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_activation_status ON activation_codes (status);
CREATE INDEX idx_activation_hardware ON activation_codes (hardware_id);
