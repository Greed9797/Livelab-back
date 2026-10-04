// F4b estendida ao detalhe: comissão de franquia exibida por linha só de marca que gera
// receita (marcaGeraReceitaSql). Garante que as rotas de detalhe usam a MESMA regra do
// /resumo e do Ranking, que a fila de aprovação (/pendentes) ficou como antes e que
// nenhuma dessas rotas escreve em vendas_atribuidas. Prova numérica no *.pg.test.js.
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { comissoesRoutes } from '../src/routes/comissoes.js'
import { financeiroRoutes } from '../src/routes/financeiro.js'
import { marcaGeraReceitaSql } from '../src/lib/receita-marca-sql.js'

vi.mock('../src/services/commission-engine.js', () => ({ calcularComissoesDaLive: vi.fn() }))

const tenantId = '11111111-1111-4111-8111-111111111111'
const liveId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const apId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

async function sqlDe(url, routes = comissoesRoutes) {
  const query = vi.fn().mockResolvedValue({ rows: [] })
  const app = Fastify()
  app.decorate('authenticate', async (request) => { request.user = { tenant_id: tenantId, sub: 'u', papel: 'franqueado' } })
  app.decorate('requirePapel', () => async (request) => {
    if (!request.user) request.user = { tenant_id: tenantId, sub: 'u', papel: 'franqueado' }
  })
  app.decorate('withTenant', async (_t, fn) => fn({ query }))
  app.decorate('audit', { log: async () => {} })
  await app.register(routes)
  const res = await app.inject({ method: 'GET', url })
  expect(res.statusCode).toBe(200)
  await app.close()
  return query.mock.calls.map(([sql]) => String(sql)).join('\n')
}

const GATE_M = `CASE WHEN ${marcaGeraReceitaSql('m')}`

describe('comissão de franquia exibida — marca não-cliente (F4b detalhe)', () => {
  it.each([
    `/v1/lives/${liveId}/comissoes`,
    '/v1/comissoes/por-live?mes=2026-08',
    '/v1/comissoes/export-csv?mes=2026-08',
  ])('%s: franquia só de marca que gera receita; apresentadora/franqueadora sem gate', async (url) => {
    const sql = await sqlDe(url)
    expect(sql).toContain(GATE_M)
    expect(sql).toMatch(/ELSE 0 END\)\s+AS comissao_franquia/)
    // GMV e as outras duas comissões continuam lidas como antes.
    expect(sql).toMatch(/va\.comissao_apresentadora \* \(/)
    expect(sql).toMatch(/va\.comissao_franqueadora \* \(/)
    expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/)
  })

  it('/v1/comissoes/pendentes (fila de aprovação) não muda', async () => {
    const sql = await sqlDe('/v1/comissoes/pendentes')
    expect(sql).not.toContain(GATE_M)
    expect(sql).toMatch(/va\.comissao_franquia \* \(/)
  })

  it('/v1/comissoes/memoria não expõe comissão de franquia', async () => {
    const sql = await sqlDe(`/v1/comissoes/memoria?apresentadora_id=${apId}`)
    expect(sql).not.toContain('comissao_franquia')
  })

  it('/v1/financeiro/faturamento: comissão (receita_liquida) por live e vídeo só de marca que gera receita', async () => {
    const sql = await sqlDe('/v1/financeiro/faturamento?inicio=2026-08&fim=2026-08', financeiroRoutes)
    expect(sql).toContain(`CASE WHEN ${marcaGeraReceitaSql('marca_cliente')}`)
    expect(sql).toContain(`CASE WHEN NOT (${marcaGeraReceitaSql('m')}) THEN 0 ELSE`)
    // GMV não passa pelo gate.
    expect(sql).toMatch(/AS gmv,/)
    expect(sql).toContain('vr.gmv_atribuido AS gmv')
  })
})
