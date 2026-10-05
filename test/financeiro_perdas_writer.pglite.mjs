// FIN-02 writer integration against in-process PostgreSQL; no external database.
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { applyMigration } from '../apply_migrations.js'
import { perderTitulo, desperderTitulo, receberTitulo } from '../src/services/receitas-comercial.js'
import {
  perderReceitaAvulsa, desperderReceitaAvulsa, receberReceitaAvulsa,
} from '../src/services/receitas-avulsas.js'

const pg = new PGlite()
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenantId = id(1)
const marcaId = id(2)
const tituloId = id(3)
const avulsaId = id(4)
const userId = id(5)

await pg.exec(`
  CREATE TABLE tenants (id uuid PRIMARY KEY);
  CREATE TABLE schema_migrations (version varchar(255) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE marcas (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, nome text, tipo text, tipo_cobranca text);
  CREATE TABLE clientes (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, nome text);
  CREATE TABLE receita_titulos (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, marca_id uuid NOT NULL, cliente_id uuid,
    competencia date NOT NULL, componente text NOT NULL, valor_previsto numeric(15,2) NOT NULL,
    valor_pago numeric(15,2) NOT NULL DEFAULT 0, data_vencimento date NOT NULL,
    data_pagamento date, observacao text, perdido_em timestamptz, perdido_motivo text,
    perdido_por uuid, atualizado_em timestamptz
  );
  CREATE TABLE receitas_avulsas (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, descricao text, grupo text,
    competencia date NOT NULL, valor_previsto numeric(15,2) NOT NULL,
    valor_pago numeric(15,2) NOT NULL DEFAULT 0, data_vencimento date NOT NULL,
    data_pagamento date, observacao text, perdido_em timestamptz, perdido_motivo text,
    perdido_por uuid, atualizado_em timestamptz
  );
  INSERT INTO tenants VALUES ('${tenantId}');
  INSERT INTO marcas VALUES ('${marcaId}', '${tenantId}', 'Alfa', 'cliente', 'fixo');
  INSERT INTO receita_titulos (id, tenant_id, marca_id, competencia, componente, valor_previsto, data_vencimento)
    VALUES ('${tituloId}', '${tenantId}', '${marcaId}', '2026-09-01', 'fixo', 100.00, '2026-09-15');
  INSERT INTO receitas_avulsas (id, tenant_id, descricao, grupo, competencia, valor_previsto, data_vencimento)
    VALUES ('${avulsaId}', '${tenantId}', 'Serviço', 'servico', '2026-09-01', 100.00, '2026-09-15');
`)

const migrationClient = {
  async query(sql, params) {
    if (params?.length) return pg.query(sql, params)
    await pg.exec(sql)
    return { rows: [] }
  },
}
await applyMigration(migrationClient, '181_financeiro_perdas_reversoes.sql')

const db = {
  query(sql, params) {
    if (String(sql).includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [] })
    if (String(sql).includes('WITH comissao_marca')) return Promise.resolve({ rows: [] })
    return pg.query(sql, params)
  },
}
const opts = { tenantId, actorUserId: userId, actorId: userId, actorType: 'usuario', hoje: '2026-10-05' }

const tituloPerda = await perderTitulo(db, { ...opts, id: tituloId, motivo: 'saldo parcial', valorPerda: '25.01', chaveOperacao: id(11) })
assert.equal(tituloPerda.item.valor_perdido, 25.01)
assert.equal(tituloPerda.item.status, 'atrasado')
const tituloRetry = await perderTitulo(db, { ...opts, id: tituloId, motivo: 'saldo parcial', valorPerda: '25.01', chaveOperacao: id(11) })
assert.equal(tituloRetry.item.valor_perdido, 25.01)
await assert.rejects(perderTitulo(db, { ...opts, id: tituloId, motivo: 'outro', valorPerda: '25.01', chaveOperacao: id(11) }),
  (e) => e.statusCode === 409 && e.code === 'IDEMPOTENCY_KEY_CONFLICT')
const tituloPago = await receberTitulo(db, { tenantId, id: tituloId, hoje: opts.hoje })
assert.equal(tituloPago.valor_pago, 74.99)
assert.equal(tituloPago.status, 'perdido')
const tituloReversao = await desperderTitulo(db, { ...opts, id: tituloId, motivo: 'novo acordo', valorReversao: '5.01', chaveOperacao: id(12) })
assert.equal(tituloReversao.item.valor_perdido, 20)
assert.equal(tituloReversao.item.status, 'atrasado')
assert.equal((await desperderTitulo(db, { ...opts, id: tituloId, motivo: 'novo acordo', valorReversao: '5.01', chaveOperacao: id(12) })).item.valor_perdido, 20)

const avulsaPerda = await perderReceitaAvulsa(db, { ...opts, id: avulsaId, motivo: 'saldo parcial', valorPerda: '25.01', chaveOperacao: id(13) })
assert.equal(avulsaPerda.item.valor_perdido, 25.01)
assert.equal(avulsaPerda.item.status, 'atrasado')
assert.equal((await perderReceitaAvulsa(db, { ...opts, id: avulsaId, motivo: 'saldo parcial', valorPerda: '25.01', chaveOperacao: id(13) })).item.valor_perdido, 25.01)
const avulsaPaga = await receberReceitaAvulsa(db, { tenantId, id: avulsaId, hoje: opts.hoje })
assert.equal(avulsaPaga.valor_pago, 74.99)
assert.equal(avulsaPaga.status, 'perdido')
const avulsaReversao = await desperderReceitaAvulsa(db, { ...opts, id: avulsaId, motivo: 'novo acordo', valorReversao: '5.01', chaveOperacao: id(14) })
assert.equal(avulsaReversao.item.valor_perdido, 20)
assert.equal(avulsaReversao.item.status, 'atrasado')
assert.equal((await desperderReceitaAvulsa(db, { ...opts, id: avulsaId, motivo: 'novo acordo', valorReversao: '5.01', chaveOperacao: id(14) })).item.valor_perdido, 20)

const { rows: events } = await pg.query(`
  SELECT tipo, origem_tipo, valor::text AS valor, motivo, ator_tipo, ator_id,
         competencia_obrigacao::text AS competencia, perda_original_id,
         registrado_em::date::text AS data_registro, id
    FROM financeiro_perdas_eventos ORDER BY origem_tipo, registrado_em, id
`)
assert.equal(events.length, 4)
for (const origem of ['receita_titulo', 'receita_avulsa']) {
  const perda = events.find((e) => e.origem_tipo === origem && e.tipo === 'perda')
  const reversao = events.find((e) => e.origem_tipo === origem && e.tipo === 'reversao')
  assert.equal(perda.valor, '25.01')
  assert.equal(reversao.valor, '5.01')
  assert.equal(reversao.perda_original_id, perda.id)
  assert.equal(perda.competencia, '2026-09-01')
  assert.equal(perda.data_registro, '2026-10-05')
  assert.equal(reversao.data_registro, '2026-10-05')
  assert.equal(perda.ator_tipo, 'usuario')
  assert.equal(perda.ator_id, userId)
}

// A baixa usada pela conciliação pode entrar numa transação já aberta; ela
// libera apenas seu SAVEPOINT e deixa o COMMIT/ROLLBACK com o chamador.
const avulsaEmConcilia = id(6)
await pg.query(`INSERT INTO receitas_avulsas
  (id, tenant_id, descricao, grupo, competencia, valor_previsto, data_vencimento)
  VALUES ($1::uuid, $2::uuid, 'Conciliação', 'servico', '2026-09-01', 50.00, '2026-09-15')`,
[avulsaEmConcilia, tenantId])
await pg.query('BEGIN')
const baixaExterna = await receberReceitaAvulsa(db, { tenantId, id: avulsaEmConcilia, valorPago: 50, hoje: opts.hoje })
assert.equal(baixaExterna.valor_pago, 50)
await pg.query('ROLLBACK')
assert.equal((await pg.query('SELECT valor_pago::text AS pago FROM receitas_avulsas WHERE id = $1',
  [avulsaEmConcilia])).rows[0].pago, '0.00')

await assert.rejects(perderReceitaAvulsa(db, {
  tenantId, id: avulsaEmConcilia, motivo: 'sem ator', valorPerda: '1.00', chaveOperacao: id(15), actorId: null,
}), (error) => error.code === 'INVALID_PERDA_ACTOR')
assert.equal((await pg.query('SELECT valor_perdido FROM receitas_avulsas WHERE id = $1',
  [avulsaEmConcilia])).rows[0].valor_perdido, null)

await pg.close()
console.log('financeiro_perdas_writer.pglite: ok')
