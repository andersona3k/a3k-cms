-- Bloco "Condicionais" do visualizador de asset + rastro de autoria.
--
-- schedule    JSON: { from, until (datetime-local "YYYY-MM-DDTHH:MM"),
--                      days [1..7 ISO], start, end ("HH:MM" 24h) }. NULL = sem
--             condicao. (Guardado no asset como padrao; a aplicacao no player
--             continua sendo por item de playlist.)
-- created_by  e-mail de quem fez o upload.
-- history     JSON: array das ultimas modificacoes [{ user, at, change }].

ALTER TABLE assets ADD COLUMN schedule   TEXT;
ALTER TABLE assets ADD COLUMN created_by TEXT;
ALTER TABLE assets ADD COLUMN history    TEXT;
