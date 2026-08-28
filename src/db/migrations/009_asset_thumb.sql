-- Miniatura (poster) para assets de video: um frame extraido no probe, servido
-- como imagem em /assets/<hash>.thumb.jpg. NULL = sem miniatura (imagem usa o
-- proprio arquivo; video sem poster cai no icone).

ALTER TABLE assets ADD COLUMN thumb_url TEXT;
