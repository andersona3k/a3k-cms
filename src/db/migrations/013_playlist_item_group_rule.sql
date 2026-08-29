-- Regra de grupo por item de playlist (bloco "Reprodução" do editor).
--
-- group_rule  JSON: { "mode": "allow" | "deny", "groups": [id, ...] }  ou NULL.
--   allow -> SO os grupos listados exibem este item; os demais pulam.
--   deny  -> os grupos listados pulam este item; os demais exibem.
--   NULL  -> todos exibem (sem restricao).
--
-- Alem disso o item passa a herdar a condicional (schedule) do proprio arquivo
-- quando pi.schedule for NULL (ver src/lib/manifest.js). Nenhuma coluna nova p/
-- isso: pi.schedule (M6) ja existe e a.schedule (migration 010) tambem.

ALTER TABLE playlist_items ADD COLUMN group_rule TEXT;
