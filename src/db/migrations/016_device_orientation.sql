-- Orientação da TELA é propriedade do device (a instalação: TV parafusada de
-- lado, e modelos que invertem). Definida na ativação e ajustável por comando
-- remoto ou F2. Vem no manifest como deviceRotation; o player soma com a
-- rotação da playlist/item (que continua sendo do CONTEÚDO).

ALTER TABLE devices ADD COLUMN orientation INTEGER NOT NULL DEFAULT 0;  -- 0 | 90 | 180 | 270 (horário)
