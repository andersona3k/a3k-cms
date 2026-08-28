-- M5 — multiempresa + permissoes (ativacao).
-- O schema ja e todo escopado por company_id desde o 001; aqui so entra a
-- flag de superadmin (operador da plataforma, atravessa empresas) e um
-- indice p/ acelerar a listagem de usuarios por empresa.

ALTER TABLE users ADD COLUMN is_superadmin INTEGER NOT NULL DEFAULT 0;

-- o admin do seed vira superadmin (unico caminho p/ gerir empresas no inicio)
UPDATE users SET is_superadmin = 1
 WHERE id = (SELECT MIN(id) FROM users);

CREATE INDEX IF NOT EXISTS idx_users_role ON users (role_id);
