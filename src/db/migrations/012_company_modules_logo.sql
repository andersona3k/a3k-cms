-- Empresa: logo (aparece no topo do painel do cliente) + modulos liberados.
--
-- logo_url  imagem servida em /assets/logo-c<id>.<ext>. NULL = usa "A3K CMS".
-- modules   JSON array: quais modulos a empresa tem. "digital" = o CMS de
--           signage feito ate aqui; "logistica" e "experience" entram depois.

ALTER TABLE companies ADD COLUMN logo_url TEXT;
ALTER TABLE companies ADD COLUMN modules  TEXT NOT NULL DEFAULT '["digital"]';
