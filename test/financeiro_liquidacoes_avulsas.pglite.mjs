import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import Fastify from 'fastify'
import { receberReceitaAvulsa, desfazerReceitaAvulsa } from '../src/services/receitas-avulsas.js'
import { financeiroReceitasAvulsasRoutes } from '../src/routes/financeiro_receitas_avulsas.js'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenantId = id(1)
const otherTenant = id(2)
const avulsaId = id(3)
const simplesId = id(5)
const legadoId = id(6)
const rotaId = id(7)
const db = new PGlite()

try {
  await db.exec(`
    CREATE TABLE tenants (id uuid PRIMARY KEY);
    INSERT INTO tenants VALUES ('${tenantId}'), ('${otherTenant}');
    CREATE TABLE receitas_avulsas (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, descricao text NOT NULL, grupo text NOT NULL,
      valor_previsto numeric(15,2) NOT NULL, valor_pago numeric(15,2) NOT NULL DEFAULT 0,
      observacao text, data_vencimento date NOT NULL, data_pagamento date, competencia date NOT NULL,
      perdido_em timestamptz, perdido_motivo text, perdido_por uuid,
      valor_perdido numeric(15,2), atualizado_em timestamptz
    );
  `)
  const migration = await readFile(new URL('../migrations/180_financeiro_liquidacoes_estornos.sql', import.meta.url), 'utf8')
  await db.exec(migration)
  await db.exec(`
    ALTER TABLE receitas_avulsas ENABLE ROW LEVEL SECURITY;
    ALTER TABLE receitas_avulsas FORCE ROW LEVEL SECURITY;
    CREATE POLICY avulsas_tenant ON receitas_avulsas
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
    CREATE ROLE avulsa_app;
    GRANT USAGE ON SCHEMA public TO avulsa_app;
    GRANT SELECT, UPDATE ON receitas_avulsas TO avulsa_app;
    GRANT SELECT, INSERT, UPDATE ON financeiro_liquidacoes TO avulsa_app;
    GRANT SELECT, INSERT ON financeiro_estornos TO avulsa_app;
    INSERT INTO receitas_avulsas (id, tenant_id, descricao, grupo, valor_previsto, data_vencimento, competencia)
      VALUES ('${avulsaId}', '${tenantId}', 'Aporte', 'aporte', 100.00, '2026-10-05', '2026-10-01'),
             ('${simplesId}', '${tenantId}', 'Serviço', 'servico', 30.00, '2026-10-05', '2026-10-01'),
             ('${rotaId}', '${tenantId}', 'UI antiga', 'servico', 40.00, '2026-10-05', '2026-10-01');
    INSERT INTO receitas_avulsas (id, tenant_id, descricao, grupo, valor_previsto, valor_pago, data_vencimento, data_pagamento, competencia)
      VALUES ('${legadoId}', '${tenantId}', 'Legado', 'servico', 20.00, 20.00, '2026-10-05', '2026-10-05', '2026-10-01');
    SELECT set_config('app.tenant_id', '${tenantId}', false);
    SET ROLE avulsa_app;
  `)
  const base = { tenantId, id: avulsaId, ator: { tipo: 'usuario', id: id(4) }, hoje: '2026-10-05' }
  const first = await receberReceitaAvulsa(db, { ...base, valorPago: '25.01', chaveOperacao: id(10) })
  assert.equal(first.valor_pago, 25.01)
  assert.equal(first.aporte, true)
  assert.equal((await receberReceitaAvulsa(db, { ...base, valorPago: '25.01', chaveOperacao: id(10) })).valor_pago, 25.01)
  await assert.rejects(receberReceitaAvulsa(db, { ...base, valorPago: '25.02', chaveOperacao: id(10) }),
    (e) => e.code === 'FINANCEIRO_IDEMPOTENCIA_CONFLITO')
  const second = await receberReceitaAvulsa(db, { ...base, valorPago: '74.99', chaveOperacao: id(11) })
  assert.equal(second.valor_pago, 100)
  await assert.rejects(receberReceitaAvulsa(db, { ...base, valorPago: '0.01', chaveOperacao: id(12) }),
    (e) => e.statusCode === 409)
  const { rows: liquidacoes } = await db.query(
    `SELECT id, valor::text AS valor FROM financeiro_liquidacoes
      WHERE tenant_id = $1::uuid AND origem_id = $2::uuid ORDER BY valor`, [tenantId, avulsaId])
  assert.deepEqual(liquidacoes.map((r) => r.valor), ['25.01', '74.99'])
  await assert.rejects(receberReceitaAvulsa(db, { tenantId, id: avulsaId, hoje: '2026-10-05' }),
    (e) => e.code === 'RECEITA_EXIGE_COMANDO')
  await assert.rejects(desfazerReceitaAvulsa(db, { tenantId, id: avulsaId, hoje: '2026-10-05' }),
    (e) => e.code === 'RECEITA_EXIGE_ESTORNO')
  await receberReceitaAvulsa(db, { ...base, id: simplesId, chaveOperacao: id(13) })
  assert.equal((await desfazerReceitaAvulsa(db, { ...base, id: simplesId, autoEstorno: true })).valor_pago, 0)
  await assert.rejects(desfazerReceitaAvulsa(db, { ...base, id: legadoId, autoEstorno: true }),
    (e) => e.code === 'RECEITA_ESTORNO_EXPLICITO')
  await assert.rejects(desfazerReceitaAvulsa(db, { ...base, id: avulsaId, autoEstorno: true }),
    (e) => e.code === 'RECEITA_ESTORNO_EXPLICITO')

  const app = Fastify()
  app.decorateRequest('user', null)
  app.addHook('onRequest', async (request) => { request.user = { tenant_id: tenantId, sub: id(4) } })
  app.decorate('requirePapel', () => async () => {})
  app.decorate('withTenant', async (_tenant, work) => work(db))
  await app.register(financeiroReceitasAvulsasRoutes)
  const url = `/v1/financeiro/receitas-avulsas/${rotaId}`
  const baixaUi = await app.inject({ method: 'PATCH', url: `${url}/receber`, payload: {} })
  assert.equal(baixaUi.statusCode, 200, baixaUi.body)
  assert.equal(baixaUi.json().valor_pago, 40)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM financeiro_liquidacoes WHERE origem_id = $1::uuid', [rotaId])).rows[0].n, 1)
  const desfazerUi = await app.inject({ method: 'PATCH', url: `${url}/desfazer` })
  assert.equal(desfazerUi.statusCode, 200, desfazerUi.body)
  assert.equal(desfazerUi.json().valor_pago, 0)
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM financeiro_estornos e
    JOIN financeiro_liquidacoes l ON l.id = e.liquidacao_id WHERE l.origem_id = $1::uuid`, [rotaId])).rows[0].n, 1)
  for (const ambiguoId of [legadoId, avulsaId]) {
    const ambiguo = await app.inject({ method: 'PATCH', url: `/v1/financeiro/receitas-avulsas/${ambiguoId}/desfazer` })
    assert.equal(ambiguo.statusCode, 409)
    assert.equal(ambiguo.json().code, 'RECEITA_ESTORNO_EXPLICITO')
  }
  await app.close()

  const estorno = {
    ...base, liquidacaoId: liquidacoes[0].id, valorEstorno: '10.01',
    dataEstorno: '2026-10-06', motivo: 'devolução parcial', chaveOperacao: id(20),
  }
  assert.equal((await desfazerReceitaAvulsa(db, estorno)).valor_pago, 89.99)
  assert.equal((await desfazerReceitaAvulsa(db, estorno)).valor_pago, 89.99)
  await assert.rejects(desfazerReceitaAvulsa(db, { ...estorno, valorEstorno: '10.02' }),
    (e) => e.code === 'FINANCEIRO_IDEMPOTENCIA_CONFLITO')
  await assert.rejects(desfazerReceitaAvulsa(db, { ...estorno, valorEstorno: '15.01', chaveOperacao: id(21) }),
    (e) => e.code === 'FINANCEIRO_ESTORNO_EXCEDENTE')
  assert.equal((await db.query('SELECT valor_pago::text AS pago FROM receitas_avulsas WHERE id = $1', [avulsaId])).rows[0].pago, '89.99')

  await db.exec(`SELECT set_config('app.tenant_id', '${otherTenant}', false)`)
  assert.equal(await receberReceitaAvulsa(db, { ...base, tenantId: otherTenant, chaveOperacao: id(30) }), null)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM financeiro_liquidacoes')).rows[0].n, 0)
  console.log('financeiro_liquidacoes_avulsas.pglite: ok')
} finally {
  await db.close()
}
