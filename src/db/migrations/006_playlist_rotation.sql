-- Fase 3: rotacao definida na PLAYLIST (nao no dispositivo).
-- 0 = horizontal; 90 = vertical (horario); 180 = invertido; 270 = vertical (anti-horario).
-- Aplicada no player via CSS transform — funciona em qualquer aparelho.

ALTER TABLE playlists ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0;
