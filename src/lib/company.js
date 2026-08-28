'use strict';

const { getDb } = require('../db');

function companyCount() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM companies').get().n;
}

// Empresa alvo de um pareamento SEM codigo. So faz sentido com uma unica
// empresa; com multiempresa o pareamento sem codigo e recusado (o codigo do
// fluxo "Add player" carrega a empresa).
function defaultCompanyId() {
  const row = getDb().prepare('SELECT id FROM companies ORDER BY id LIMIT 1').get();
  if (!row) throw new Error('nenhuma empresa cadastrada — rode o seed');
  return row.id;
}

module.exports = { defaultCompanyId, companyCount };
