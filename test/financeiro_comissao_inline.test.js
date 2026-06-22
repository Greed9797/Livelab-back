// Regressão (causa-raiz da divergência Analytics × Financeiro):
// O Financeiro derivava a receita da coluna PRÉ-CALCULADA e estagnada
// `lives.comissao_calculada`, que fica 0 para lives recentes que o motor de
// comissão ainda não processou (ou cuja marca não resolveu). Resultado: o GMV
// batia com o Analytics (lê `lives` cru) mas a receita "parava" nas lives da 2ª
// metade do mês. O fix: calcular a comissão de franquia INLINE no SQL
// (gmv × marca.comissao_franquia_pct), resolvendo a marca igual ao
// commission-engine (status='ativa' + m.id=l.marca_id OR cliente_id), sem
// depender de nenhum job/coluna pré-calculada — idêntico em valor, imediato.

import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { financeiroRoutes } from '../src/routes/financeiro.js'

const tenantId = '11111111-1111-4111-8111-111111111111'

function buildApp({ queryMock } = {}) {
  const app = Fastify()
  const query = queryMock ?? vi.fn().mockResolvedValue({ rows: [{}] })

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async (request) => {
    if (!request.user) request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('withTenant', async (_t, fn) => fn({ query }))
  app.decorate('db', { query })
  app.decorate('audit', { log: async () => {} })

  return { app, query }
}

describe('financeiro — comissão de franquia calculada INLINE (não da coluna estagnada)', () => {
  it('GET /financeiro/resumo: receita NÃO depende de lives.comissao_calculada; usa gmv × pct da marca resolvida', async () => {
    const resumoRow = {
      gmv_lives: '55658.00', pedidos_lives: 10, total_lives: 8,
      comissao_franquia_lives: '6679.00', comissao_configurada: 8, comissao_faltante_count: 0,
      gmv_videos: '0', pedidos_videos: 0, total_videos: 0,
      total_custos: '0', fixo_mensal_total: '0',
    }
    const query = vi.fn().mockResolvedValue({ rows: [resumoRow] })
    const { app } = buildApp({ queryMock: query })
    await app.register(financeiroRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/financeiro/resumo?inicio=2026-06&fim=2026-06' })
    expect(res.statusCode).toBe(200)

    const call = query.mock.calls.find(([sql]) => String(sql).includes('AS comissao_franquia_lives'))
    expect(call).toBeTruthy()
    const sql = String(call[0])

    // A receita de franquia NÃO pode mais vir da coluna pré-calculada/estagnada.
    expect(sql).not.toContain('SUM(l.comissao_calculada)')
    expect(sql).not.toContain('comissao_calculada')
    // Deve calcular inline: gmv × pct da marca, resolvendo a marca como o engine.
    expect(sql).toContain('comissao_franquia_pct')
    expect(sql).toContain("m.status = 'ativa'")
    expect(sql).toContain('m.cliente_id = l.cliente_id')

    // Período expande pro mês inteiro (já era assim) — sanity.
    expect(call[1]).toContain('2026-06-01')
    expect(call[1]).toContain('2026-06-30')
    await app.close()
  })

  it('GET /financeiro/resumo: receita_liquida = comissão variável (vinda do SQL inline) + fixo mensal', async () => {
    const resumoRow = {
      gmv_lives: '1000', pedidos_lives: 1, total_lives: 1,
      comissao_franquia_lives: '120', comissao_configurada: 1, comissao_faltante_count: 0,
      gmv_videos: '0', pedidos_videos: 0, total_videos: 0,
      total_custos: '0', fixo_mensal_total: '50',
    }
    const query = vi.fn().mockResolvedValue({ rows: [resumoRow] })
    const { app } = buildApp({ queryMock: query })
    await app.register(financeiroRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/financeiro/resumo?inicio=2026-06&fim=2026-06' })
    const body = res.json()
    expect(body.receita_liquida).toBe(170) // 120 (variável inline) + 50 (fixo)
    expect(body.gmv_total).toBe(1000)
    await app.close()
  })

  it('GET /financeiro/faturamento: breakdown por cliente também usa comissão inline, não comissao_calculada', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const { app } = buildApp({ queryMock: query })
    await app.register(financeiroRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/financeiro/faturamento?inicio=2026-06&fim=2026-06' })
    expect(res.statusCode).toBe(200)

    const call = query.mock.calls.find(([sql]) => String(sql).includes('AS comissao_franquia'))
    expect(call).toBeTruthy()
    const sql = String(call[0])
    expect(sql).not.toContain('comissao_calculada')
    expect(sql).toContain('comissao_franquia_pct')
    expect(sql).toContain('m.cliente_id = l.cliente_id')
    await app.close()
  })
})
