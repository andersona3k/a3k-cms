-- M2 — biblioteca a fundo. Metadados extraidos no upload (sharp p/ imagem,
-- ffprobe p/ video/audio). As colunas width/height/duration/fps/bitrate/codec
-- ja existem do 001 (nullable); aqui adicionamos o resto do painel de info.

-- formato/container legivel (ex: "png", "mp4", "matroska,webm").
ALTER TABLE assets ADD COLUMN format TEXT;

-- dump cru do probe (sharp.metadata() ou ffprobe -show_format -show_streams).
ALTER TABLE assets ADD COLUMN metadata TEXT;

-- estado da extracao: pending | ok | error | skipped (tipo sem probe).
ALTER TABLE assets ADD COLUMN probe_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE assets ADD COLUMN probe_error  TEXT;

CREATE INDEX idx_assets_probe_status ON assets (probe_status);
