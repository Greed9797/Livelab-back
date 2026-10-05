import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { PGlite } from '@electric-sql/pglite'
import { lerLiquidacoesOrigem } from '../src/services/financeiro-liquidacoes-read.js'

const db = new PGlite()
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenantA = id(1)
const tenantB = id(2)
const origem = id(10)
const semEventos = id(11)

await db.exec(`
  CREATE TABLE tenants (id uuid PRIMARY KEY);
  INSERT INTO tenants(id) VALUES ('${tenantA}'), ('${tenantB}');
`)

const migration180 = await readFile(
  new URL('../migrations/180_financeiro_liquidacoes_estornos.sql', import.meta.url),
  'utf8',
)
await db.exec(migration180)

async function inserirLiquidacao({ tenantId, origemId, valor, data, chave }) {
  const { rows } = await db.query(`
    INSERT INTO financeiro_liquidacoes (
      tenant_id, natureza, origem_tipo, origem_id, valor, data_liquidacao,
      comando_origem, ator_tipo, ator_id, idempotencia_chave, idempotencia_payload
    ) VALUES (
      $1::uuid, 'receita', 'receita_titulo', $2::uuid, $3::numeric, $4::date,
      'teste-read', 'sistema', 'pglite', $5, '{}'::jsonb
    )
    RETURNING id
  `, [tenantId, origemId, valor, data, chave])
  return rows[0].id
}

async function inserirEstorno({ tenantId, liquidacaoId, valor, data, chave }) {
  const { rows } = await db.query(`
    INSERT INTO financeiro_estornos (
      tenant_id, liquidacao_id, valor, data_estorno, comando_origem,
      ator_tipo, ator_id, idempotencia_chave, idempotencia_payload
    ) VALUES (
      $1::uuid, $2::uuid, $3::numeric, $4::date, 'teste-read',
      'sistema', 'pglite', $5, '{}'::jsonb
    )
    RETURNING id
  `, [tenantId, liquidacaoId, valor, data, chave])
  return rows[0].id
}

const liq1 = await inserirLiquidacao({
  tenantId: tenantA, origemId: origem, valor: '100.10', data: '2026-10-01', chave: 'a-liq-1',
})
const liq2 = await inserirLiquidacao({
  tenantId: tenantA, origemId: origem, valor: '200.20', data: '2026-10-03', chave: 'a-liq-2',
})

const est1 = await inserirEstorno({
  tenantId: tenantA, liquidacaoId: liq1, valor: '10.01', data: '2026-10-04', chave: 'a-est-1',
})
const est2 = await inserirEstorno({
  tenantId: tenantA, liquidacaoId: liq1, valor: '20.02', data: '2026-10-05', chave: 'a-est-2',
})
const est3 = await inserirEstorno({
  tenantId: tenantA, liquidacaoId: liq2, valor: '30.03', data: '2026-10-06', chave: 'a-est-3',
})

const liqOutroTenant = await inserirLiquidacao({
  tenantId: tenantB, origemId: origem, valor: '999.99', data: '2026-10-01', chave: 'b-liq-1',
})
await inserirEstorno({
  tenantId: tenantB, liquidacaoId: liqOutroTenant, valor: '111.11', data: '2026-10-02', chave: 'b-est-1',
})

const total = await lerLiquidacoesOrigem(db, {
  tenantId: tenantA,
  origemTipo: 'receita_titulo',
  origemId: origem,
})
assert.deepEqual(total, {
  total_liquidado: '300.30',
  total_estornado: '60.06',
  total_liquido: '240.24',
})

let consultasDetalhadas = 0
const leituraContada = {
  query(sql, params) {
    consultasDetalhadas += 1
    return db.query(sql, params)
  },
}
const comDatas = await lerLiquidacoesOrigem(leituraContada, {
  tenantId: tenantA,
  origemTipo: 'receita_titulo',
  origemId: origem,
  listarDatas: true,
})
assert.equal(consultasDetalhadas, 1, 'listarDatas deve usar um único snapshot SQL')
assert.deepEqual(comDatas, {
  ...total,
  liquidacoes: [
    {
      id: liq1,
      valor: '100.10',
      data_liquidacao: '2026-10-01',
      total_estornado: '30.03',
      total_liquido: '70.07',
      estornos: [
        { id: est1, valor: '10.01', data_estorno: '2026-10-04' },
        { id: est2, valor: '20.02', data_estorno: '2026-10-05' },
      ],
    },
    {
      id: liq2,
      valor: '200.20',
      data_liquidacao: '2026-10-03',
      total_estornado: '30.03',
      total_liquido: '170.17',
      estornos: [
        { id: est3, valor: '30.03', data_estorno: '2026-10-06' },
      ],
    },
  ],
})

consultasDetalhadas = 0
const vazio = await lerLiquidacoesOrigem(leituraContada, {
  tenantId: tenantA,
  origemTipo: 'receita_titulo',
  origemId: semEventos,
  listarDatas: true,
})
assert.equal(consultasDetalhadas, 1, 'escopo vazio também deve usar um único SELECT')
assert.deepEqual(vazio, {
  total_liquidado: '0.00',
  total_estornado: '0.00',
  total_liquido: '0.00',
  liquidacoes: [],
})

const tenantBTotal = await lerLiquidacoesOrigem(db, {
  tenantId: tenantB,
  origemTipo: 'receita_titulo',
  origemId: origem,
})
assert.deepEqual(tenantBTotal, {
  total_liquidado: '999.99',
  total_estornado: '111.11',
  total_liquido: '888.88',
})

console.log('PASS: FIN-03A/03B leitura canônica sem fan-out, isolada por tenant/origem e com decimais exatos')
await db.close()
