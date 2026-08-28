'use strict';

const { getDb } = require('../db');

// M1 e single-company. Endpoints de player (sem JWT) usam a empresa padrao =
// a primeira empresa cadastrada (a do seed). No M5 isso e resolvido pelo
// pareamento/claim explicito.
function defaultCompanyId() {
  const row = getDb().prepare('SELECT id FROM companies ORDER BY id LIMIT 1').get();
  if (!row) throw new Error('nenhuma empresa cadastrada — rode o seed');
  return row.id;
}

module.exports = { defaultCompanyId };
