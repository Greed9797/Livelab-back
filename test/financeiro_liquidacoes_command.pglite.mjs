import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

import { registrarEstorno, registrarLiquidacao } from '../src/services/financeiro-liquidacoes-command.js'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenantId = id(1)
const origemId = id(2)
const ator = { tipo: 'usuario', id: id(3) }

const db = new PGlite()
await db.exec(`
  CREATE TABLE tenants (id uuid PRIMARY KEY);
  INSERT INTO tenants (id) VALUES ('${tenantId}');

  CREATE TABLE origem_financeira (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    natureza text NOT NULL CHECK (natureza IN ('receita', 'custo')),
    saldo numeric(15,2) NOT NULL CHECK (saldo >= 0)
  );
`)

const migration180 = await readFile(new URL('../migrations/180_financeiro_liquidacoes_estornos.sql', import.meta.url), 'utf8')
await db.exec(migration180)
await db.exec(`
  CREATE ROLE fin03_app;
  GRANT USAGE ON SCHEMA public TO fin03_app;
  GRANT SELECT, INSERT, UPDATE ON financeiro_liquidacoes TO fin03_app;
  GRANT SELECT, INSERT ON financeiro_estornos TO fin03_app;
  GRANT SELECT, INSERT, UPDATE ON origem_financeira TO fin03_app;
  SELECT set_config('app.tenant_id', '${tenantId}', false);
  SET ROLE fin03_app;
`)

async function resetOrigin(saldo = '100.00') {
  await db.query(
    `INSERT INTO origem_financeira (id, tenant_id, natureza, saldo)
     VALUES ($1::uuid, $2::uuid, 'receita', $3::numeric)
     ON CONFLICT (id) DO UPDATE SET saldo = EXCLUDED.saldo`,
    [origemId, tenantId, saldo],
  )
}

async function validarOrigemParaUpdate(tx, contexto) {
  const { rows } = await tx.query(
    `SELECT tenant_id, natureza, saldo::text AS saldo
       FROM origem_financeira
      WHERE id = $1::uuid AND tenant_id = $2::uuid
      FOR UPDATE`,
    [contexto.origemId, contexto.tenantId],
  )
  const row = rows[0]
  if (!row) return null
  return { tenantId: row.tenant_id, natureza: row.natureza, saldoElegivel: row.saldo }
}

async function projetarLiquidacao(tx, evento) {
  await tx.query(
    `UPDATE origem_financeira
        SET saldo = saldo - $3::numeric
      WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [evento.origemId, evento.tenantId, evento.valor],
  )
}

async function projetarEstorno(tx, evento) {
  await tx.query(
    `UPDATE origem_financeira
        SET saldo = saldo + $3::numeric
      WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [evento.origemId, evento.tenantId, evento.valor],
  )
}

function liquidacaoInput(overrides = {}) {
  return {
    tenantId,
    origemTipo: 'receita_avulsa',
    origemId,
    valor: '40.00',
    data: '2026-10-05',
    ator,
    idempotenciaChave: 'liq-1',
    validarOrigemParaUpdate,
    aplicarProjecao: projetarLiquidacao,
    ...overrides,
  }
}

await resetOrigin()

// Replay idêntico devolve o mesmo fato e não reaplica a projeção.
const first = await registrarLiquidacao(db, liquidacaoInput())
const replay = await registrarLiquidacao(db, liquidacaoInput({ valor: '40.0' }))
assert.equal(first.id, replay.id)
assert.equal(replay.replay, true)
assert.equal((await db.query("SELECT count(*)::int AS n FROM financeiro_liquidacoes WHERE idempotencia_chave='liq-1'")).rows[0].n, 1)
assert.equal((await db.query('SELECT saldo::text AS saldo FROM origem_financeira')).rows[0].saldo, '60.00')

// Mesma chave com payload normalizado diferente é conflito.
await assert.rejects(
  registrarLiquidacao(db, liquidacaoInput({ valor: '41.00' })),
  (error) => error.code === 'FINANCEIRO_IDEMPOTENCIA_CONFLITO' && error.statusCode === 409,
)

// A validação da origem é parte obrigatória do contrato.
await assert.rejects(
  registrarLiquidacao(db, liquidacaoInput({ idempotenciaChave: 'sem-validacao', validarOrigemParaUpdate: null })),
  (error) => error.code === 'FINANCEIRO_VALIDACAO_ORIGEM_OBRIGATORIA',
)

// Falha na projeção reverte também o fato inserido.
await assert.rejects(
  registrarLiquidacao(db, liquidacaoInput({
    valor: '10.00',
    idempotenciaChave: 'rollback-liq',
    aplicarProjecao: async (tx, evento) => {
      await projetarLiquidacao(tx, evento)
      throw new Error('falha de projeção')
    },
  })),
  /falha de projeção/,
)
assert.equal((await db.query("SELECT count(*)::int AS n FROM financeiro_liquidacoes WHERE idempotencia_chave='rollback-liq'")).rows[0].n, 0)
assert.equal((await db.query('SELECT saldo::text AS saldo FROM origem_financeira')).rows[0].saldo, '60.00')

// Chamadas concorrentes disputando o mesmo saldo passam pela transação do
// PGlite; somente uma pode consumir um total que faria a outra exceder 100.
await resetOrigin()
const concurrentLiquidacoes = await Promise.allSettled([
  registrarLiquidacao(db, liquidacaoInput({ valor: '70.00', idempotenciaChave: 'conc-liq-a' })),
  registrarLiquidacao(db, liquidacaoInput({ valor: '40.00', idempotenciaChave: 'conc-liq-b' })),
])
assert.equal(concurrentLiquidacoes.filter((r) => r.status === 'fulfilled').length, 1)
assert.equal(concurrentLiquidacoes.filter((r) => r.status === 'rejected' && r.reason?.code === 'FINANCEIRO_SALDO_INSUFICIENTE').length, 1)
const liqTotal = (await db.query(
  `SELECT COALESCE(sum(valor),0)::text AS total
     FROM financeiro_liquidacoes
    WHERE idempotencia_chave IN ('conc-liq-a', 'conc-liq-b')`,
)).rows[0].total
const saldoDepoisConcorrencia = (await db.query('SELECT saldo::text AS saldo FROM origem_financeira')).rows[0].saldo
assert.equal(Number(liqTotal) + Number(saldoDepoisConcorrencia), 100)

// Cria uma liquidação integral para exercitar limite agregado de estorno.
await resetOrigin()
const original = await registrarLiquidacao(db, liquidacaoInput({ valor: '100.00', idempotenciaChave: 'liq-original' }))
assert.equal((await db.query('SELECT saldo::text AS saldo FROM origem_financeira')).rows[0].saldo, '0.00')

const estornoBase = {
  tenantId,
  liquidacaoId: original.id,
  valor: '60.00',
  data: '2026-10-05',
  ator,
  idempotenciaChave: 'est-1',
  aplicarProjecao: projetarEstorno,
}
const estorno = await registrarEstorno(db, estornoBase)
const estornoReplay = await registrarEstorno(db, { ...estornoBase, valor: '60.0' })
assert.equal(estorno.id, estornoReplay.id)
assert.equal(estornoReplay.replay, true)
assert.equal((await db.query('SELECT saldo::text AS saldo FROM origem_financeira')).rows[0].saldo, '60.00')

await assert.rejects(
  registrarEstorno(db, { ...estornoBase, valor: '50.00', idempotenciaChave: 'est-excede' }),
  (error) => error.code === 'FINANCEIRO_ESTORNO_EXCEDENTE' && error.statusCode === 409,
)

// Rollback do estorno preserva fato e projeção anteriores.
await assert.rejects(
  registrarEstorno(db, {
    ...estornoBase,
    valor: '10.00',
    idempotenciaChave: 'rollback-est',
    aplicarProjecao: async (tx, evento) => {
      await projetarEstorno(tx, evento)
      throw new Error('falha de projeção de estorno')
    },
  }),
  /falha de projeção de estorno/,
)
assert.equal((await db.query("SELECT count(*)::int AS n FROM financeiro_estornos WHERE idempotencia_chave='rollback-est'")).rows[0].n, 0)
assert.equal((await db.query('SELECT saldo::text AS saldo FROM origem_financeira')).rows[0].saldo, '60.00')

// Concorrência de estornos: o FOR UPDATE no fato original serializa a soma.
await resetOrigin()
const originalConcorrente = await registrarLiquidacao(db, liquidacaoInput({
  valor: '100.00',
  idempotenciaChave: 'liq-original-concorrencia',
}))
const concurrentEstornos = await Promise.allSettled([
  registrarEstorno(db, { ...estornoBase, liquidacaoId: originalConcorrente.id, valor: '60.00', idempotenciaChave: 'conc-est-a' }),
  registrarEstorno(db, { ...estornoBase, liquidacaoId: originalConcorrente.id, valor: '50.00', idempotenciaChave: 'conc-est-b' }),
])
assert.equal(concurrentEstornos.filter((r) => r.status === 'fulfilled').length, 1)
assert.equal(concurrentEstornos.filter((r) => r.status === 'rejected' && r.reason?.code === 'FINANCEIRO_ESTORNO_EXCEDENTE').length, 1)
const estornoTotal = (await db.query(
  'SELECT COALESCE(sum(valor),0)::text AS total FROM financeiro_estornos WHERE liquidacao_id = $1::uuid',
  [originalConcorrente.id],
)).rows[0].total
const saldoFinal = (await db.query('SELECT saldo::text AS saldo FROM origem_financeira')).rows[0].saldo
assert.equal(estornoTotal, saldoFinal)
assert(Number(estornoTotal) <= 100)

await assert.rejects(
  db.query('UPDATE financeiro_liquidacoes SET motivo = $1 WHERE id = $2::uuid', ['mutação proibida', original.id]),
  /imutáveis/,
)

await db.close()
console.log('PASS FIN-03A: idempotência, conflito, validação obrigatória, atomicidade, concorrência e limite de estorno')
