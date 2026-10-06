import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { compararLiquidacoesLegado } from '../src/services/financeiro-liquidacoes-legacy-comparison.js'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenantA = id(1)
const tenantB = id(2)
const db = new PGlite()

try {
  await db.exec(`
    CREATE TABLE tenants (id uuid PRIMARY KEY);
    INSERT INTO tenants VALUES ('${tenantA}'), ('${tenantB}');
    CREATE TABLE receita_titulos (id uuid, tenant_id uuid, componente text, valor_pago numeric(15,2));
    CREATE TABLE receitas_avulsas (id uuid, tenant_id uuid, valor_pago numeric(15,2));
    CREATE TABLE custos (id uuid, tenant_id uuid, tipo text, valor_pago numeric(15,2), recorrente_id uuid, parcela_grupo_id uuid);
    CREATE TABLE apresentadora_pagamentos (id uuid, tenant_id uuid, componente text, valor_pago numeric(15,2));
  `)
  await db.exec(await readFile(new URL('../migrations/180_financeiro_liquidacoes_estornos.sql', import.meta.url), 'utf8'))

  async function legado(tabela, tenant, origem, valor, tipo = null) {
    const colunas = tipo === null ? 'id, tenant_id, valor_pago' : 'id, tenant_id, valor_pago, tipo'
    const params = tipo === null ? [origem, tenant, valor] : [origem, tenant, valor, tipo]
    await db.query(`INSERT INTO ${tabela} (${colunas}) VALUES (${params.map((_, i) => `$${i + 1}`).join(', ')})`, params)
  }

  let seq = 0
  async function liquidacao(tenant, tipo, origem, valor, natureza = ['receita_titulo', 'receita_avulsa'].includes(tipo) ? 'receita' : 'custo') {
    const { rows } = await db.query(`
      INSERT INTO financeiro_liquidacoes
        (tenant_id, natureza, origem_tipo, origem_id, valor, data_liquidacao,
         comando_origem, ator_tipo, ator_id, idempotencia_chave, idempotencia_payload)
      VALUES ($1, $2, $3, $4, $5, DATE '2026-10-01', 'fixture', 'sistema',
              'pglite', $6, '{}'::jsonb) RETURNING id`,
      [tenant, natureza, tipo, origem, valor, `liq-${++seq}`],
    )
    return rows[0].id
  }
  async function estorno(tenant, liquidacaoId, valor) {
    await db.query(`
      INSERT INTO financeiro_estornos
        (tenant_id, liquidacao_id, valor, data_estorno, comando_origem,
         ator_tipo, ator_id, idempotencia_chave, idempotencia_payload)
      VALUES ($1, $2, $3, DATE '2026-10-02', 'fixture', 'sistema',
              'pglite', $4, '{}'::jsonb)`, [tenant, liquidacaoId, valor, `est-${++seq}`])
  }

  // As somas batem (200.00), mas as duas obrigações divergem em sentidos opostos.
  await legado('receita_titulos', tenantA, id(10), '100.00')
  await db.query('UPDATE receita_titulos SET componente = $1 WHERE tenant_id = $2 AND id = $3', ['fixo', tenantA, id(10)])
  await legado('receita_titulos', tenantA, id(11), '100.00')
  await liquidacao(tenantA, 'receita_titulo', id(10), '99.99')
  await liquidacao(tenantA, 'receita_titulo', id(11), '100.01')
  await legado('receita_titulos', tenantA, id(12), '5.25')
  await liquidacao(tenantA, 'receita_titulo', id(13), '7.50')
  await legado('receita_titulos', tenantA, id(14), '0.00')
  await legado('receita_titulos', tenantA, id(15), '9007199254740.91')
  const parcial = await liquidacao(tenantA, 'receita_titulo', id(15), '9007199254740.91')
  await estorno(tenantA, parcial, '0.01')
  await liquidacao(tenantA, 'receita_titulo', id(15), '0.01')
  await legado('receita_titulos', tenantA, id(16), '10.00')
  await liquidacao(tenantA, 'receita_titulo', id(16), '10.00', 'custo')
  await legado('receita_titulos', tenantB, id(10), '999.00')
  await liquidacao(tenantB, 'receita_titulo', id(10), '999.00')

  let queries = 0
  const contado = { query: (...args) => { queries++; return db.query(...args) } }
  const rows = await compararLiquidacoesLegado(contado, {
    tenantId: tenantA, origemTipo: 'receita_titulo',
    origemIds: [id(10), id(11), id(12), id(13), id(14), id(15), id(16), id(99)],
  })
  assert.equal(queries, 1, 'cada comparação deve usar um único snapshot SQL')
  assert.deepEqual(rows.map(({ origem_id, classificacao, diferenca }) =>
    [origem_id, classificacao, diferenca]), [
    [id(10), 'divergent', '-0.01'],
    [id(11), 'divergent', '0.01'],
    [id(12), 'legacy-only', '-5.25'],
    [id(13), 'canonical-only', '7.50'],
    [id(14), 'matching', '0.00'],
    [id(15), 'matching', '0.00'],
    [id(16), 'divergent', '0.00'],
  ])
  assert.equal(rows[2].valor_canonico, null)
  assert.equal(rows[3].valor_legado, null)
  assert.equal(rows.reduce((sum, row) => sum + Number(row.diferenca), 0), 2.25)
  assert.equal(rows[5].valor_legado, '9007199254740.91')
  assert.equal(rows[5].valor_canonico, '9007199254740.91')
  assert.equal(rows[6].natureza_incorreta, 1, 'natureza errada nunca é matching mesmo com valor igual')
  assert.equal(rows[0].componente, 'fixo', 'o componente da obrigação acompanha a evidência de diferença')
  assert.equal(rows[0].origem_categoria, 'marca_fixo')

  const outroTenant = await compararLiquidacoesLegado(db, {
    tenantId: tenantB, origemTipo: 'receita_titulo', origemIds: [id(10), id(11)],
  })
  assert.deepEqual(outroTenant.map((r) => [r.origem_id, r.classificacao]), [[id(10), 'matching']])

  for (const [tipo, tabela, origem, valor, subtipo] of [
    ['receita_avulsa', 'receitas_avulsas', id(20), '10.10'],
    ['custo', 'custos', id(21), '20.20', 'aluguel'],
    ['apresentadora_pagamento', 'apresentadora_pagamentos', id(22), '30.30'],
    ['imposto', 'custos', id(23), '40.40', 'imposto'],
  ]) {
    await legado(tabela, tenantA, origem, valor, subtipo)
    await liquidacao(tenantA, tipo, origem, valor)
    const result = await compararLiquidacoesLegado(db, {
      tenantId: tenantA, origemTipo: tipo, origemIds: [origem],
    })
    assert.deepEqual(result.map((r) => [r.classificacao, r.valor_legado, r.valor_canonico]),
      [['matching', valor, valor]])
    assert.equal(result[0].origem_categoria, tipo === 'custo' ? 'manual' : tipo === 'imposto' ? 'imposto' : tipo === 'receita_avulsa' ? 'avulsa' : 'apresentadora')
  }
  await db.query('UPDATE custos SET recorrente_id = $1 WHERE id = $2 AND tenant_id = $3', [id(55), id(21), tenantA])
  assert.equal((await compararLiquidacoesLegado(db, { tenantId: tenantA, origemTipo: 'custo', origemIds: [id(21)] }))[0].origem_categoria, 'recorrente')
  await legado('custos', tenantA, id(24), '5.00', 'parcelado')
  await db.query('UPDATE custos SET parcela_grupo_id = $1 WHERE id = $2 AND tenant_id = $3', [id(56), id(24), tenantA])
  await liquidacao(tenantA, 'custo', id(24), '5.00')
  assert.equal((await compararLiquidacoesLegado(db, { tenantId: tenantA, origemTipo: 'custo', origemIds: [id(24)] }))[0].origem_categoria, 'parcela')
  assert.deepEqual(await compararLiquidacoesLegado(db, {
    tenantId: tenantA, origemTipo: 'custo', origemIds: [id(23)],
  }), [], 'imposto não pode aparecer como custo comum')
  await assert.rejects(compararLiquidacoesLegado(db, {
    tenantId: tenantA, origemTipo: 'desconhecido', origemIds: [id(10)],
  }), /origemTipo/)
  await assert.rejects(compararLiquidacoesLegado(db, {
    tenantId: tenantA, origemTipo: 'receita_titulo', origemIds: Array.from({ length: 101 }, (_, n) => id(n + 100)),
  }), /origemIds/)

  console.log('PASS: FIN-03B shadow por obrigação, cinco origens, snapshot e isolamento de tenant')
} finally {
  await db.close()
}
