import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { financeiroRoutes } from '../src/routes/financeiro.js'

const TENANT = '11111111-1111-4111-8111-111111111111'

/** db fake: responde conforme o SQL (primeiro matcher que casar). */
function buildApp({ papel = 'franqueado', responder = () => ({ rows: [] }) } = {}) {
  const app = Fastify()
  const queryMock = vi.fn(async (sql, params) => responder(sql, params))
  const release = vi.fn()
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: TENANT, sub: 'user-1', papel }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: TENANT, sub: 'user-1', papel }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('dbTenant', async () => ({ query: queryMock, release }))
  app.decorate('withTenant', async (tenantId, fn) => {
    const db = await app.dbTenant(tenantId)
    try { return await fn(db) } finally { db.release() }
  })
  app.decorate('db', { query: vi.fn() })
  return { app, queryMock, release }
}

const dadosBase = (sql) => {
  if (sql.includes('FROM tenants')) return { rows: [{ aliquota_imposto_pct: '6.00' }] }
  if (sql.includes('FROM contratos c')) {
    return { rows: [
      { id: 'c1', cliente_id: 'cli1', status: 'ativo', valor_fixo: '1000', dia_vencimento: 10, ativado_em: '2025-12-10', fim_em: null },
      { id: 'c2', cliente_id: 'cli2', status: 'cancelado', valor_fixo: '500', dia_vencimento: 5, ativado_em: '2025-10-01', fim_em: '2026-02-15' },
    ] }
  }
  if (sql.includes('FROM vendas_atribuidas')) return { rows: [] }
  if (sql.includes('FROM receitas_previstas')) return { rows: [] }
  if (sql.includes('FROM custos_recorrentes')) return { rows: [] }
  if (sql.includes('FROM custos')) {
    return { rows: [{ id: 'k1', grupo: 'estrutural', tipo: 'aluguel', valor: '300', competencia: '2026-01-01', status: 'pago', dia_vencimento: 10, cartao: false }] }
  }
  return { rows: [] }
}

/** Toda query de leitura/escrita deve filtrar o tenant explicitamente. */
function expectTenantExplicito(queryMock) {
  for (const [sql, params] of queryMock.mock.calls) {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) continue
    expect(params).toContain(TENANT)
    expect(sql).toMatch(/tenant_id = \$\d::uuid|INSERT INTO \w+\s*\(tenant_id,|FROM tenants WHERE id = \$1::uuid|UPDATE tenants SET/)
  }
}

describe('GET /v1/financeiro/resumo', () => {
  it('fixo por período soma mês a mês e toda query filtra tenant_id', async () => {
    const { app, queryMock } = buildApp({ responder: dadosBase })
    await app.register(financeiroRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/financeiro/resumo?inicio=2026-01&fim=2026-03' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // c1: jan, fev, mar = 3000 | c2 (cancelado 15/02): jan, fev = 1000
    expect(body.meses.map((m) => m.previsto.receita.fixo)).toEqual([1500, 1500, 1000])
    expect(body.previsto.receita.fixo).toBe(4000)
    expect(body.previsto.imposto).toBe(240)
    expect(body.previsto.custos_fixos.total).toBe(300)
    expect(body.realizado.custos_fixos.total).toBe(300)
    expect(body).toMatchObject({ fat_bruto: 4000, total_custos: 300, fat_liquido: 3460, periodo: '2026-01-01', aliquota_imposto_pct: 6 })
    expectTenantExplicito(queryMock)
    const custosSql = queryMock.mock.calls.find(([sql]) => sql.includes('FROM custos\n'))
    expect(custosSql[0]).toContain('tenant_id = $1::uuid')
    await app.close()
  })

  it('período inválido retorna 400', async () => {
    const { app } = buildApp({ responder: dadosBase })
    await app.register(financeiroRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/financeiro/resumo?inicio=2026-05&fim=2026-01' })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('endpoint /franqueadora (royalties fixos) não existe mais', async () => {
    const { app } = buildApp({ papel: 'franqueador_master', responder: dadosBase })
    await app.register(financeiroRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/financeiro/franqueadora' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})

describe('GET /v1/financeiro/fluxo-caixa', () => {
  it('retorna linhas por vencimento, série anual e formato legado', async () => {
    const { app, queryMock } = buildApp({ responder: dadosBase })
    await app.register(financeiroRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/financeiro/fluxo-caixa?mes=2026-03' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.linhas.map((l) => l.dia)).toEqual(['5', '10', '15', '20', '25', '30', 'cartao'])
    expect(body.serie_anual).toHaveLength(12)
    expect(body.saldo_inicial.previsto).toBe(body.serie_anual[1].acumulado_previsto)
    expect(body.linhas.at(-1).acumulado_previsto).toBe(body.serie_anual[2].acumulado_previsto)
    expect(body.entradas[0]).toEqual({ dia: '2026-03-10', valor: 1000 })
    expectTenantExplicito(queryMock)
    await app.close()
  })
})

describe('POST /v1/financeiro/receitas/gerar', () => {
  it('1ª rodada insere, 2ª não insere nada (idempotente)', async () => {
    const gravadas = []
    const responder = (sql, params) => {
      if (sql.includes('INSERT INTO receitas_previstas')) {
        gravadas.push({ id: `rp${gravadas.length}`, contrato_id: params[1], fixo_previsto: params[4], comissao_prevista: params[5],
          gmv_base: params[6], dia_vencimento: params[7], fixo_recebido: 0, comissao_recebida: 0, status: 'previsto', ajuste_manual: false })
        return { rows: [{ id: 'novo' }] }
      }
      if (sql.includes('FROM receitas_previstas')) return { rows: gravadas }
      return dadosBase(sql, params)
    }
    const { app, queryMock } = buildApp({ responder })
    await app.register(financeiroRoutes)

    const r1 = await app.inject({ method: 'POST', url: '/v1/financeiro/receitas/gerar?mes=2026-03' })
    expect(r1.statusCode).toBe(200)
    expect(r1.json()).toMatchObject({ inseridas: 1, atualizadas: 0 })

    const r2 = await app.inject({ method: 'POST', url: '/v1/financeiro/receitas/gerar?mes=2026-03' })
    expect(r2.json()).toMatchObject({ inseridas: 0, atualizadas: 0, inalteradas: 1 })

    const inserts = queryMock.mock.calls.filter(([sql]) => sql.includes('INSERT INTO receitas_previstas'))
    expect(inserts).toHaveLength(1)
    expect(inserts[0][0]).toContain('ON CONFLICT (contrato_id, competencia) DO NOTHING')
    expectTenantExplicito(queryMock)
    await app.close()
  })

  it('mes inválido retorna 400', async () => {
    const { app } = buildApp()
    await app.register(financeiroRoutes)
    const res = await app.inject({ method: 'POST', url: '/v1/financeiro/receitas/gerar?mes=03-2026' })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})

describe('POST /v1/financeiro/custos/gerar', () => {
  it('materializa recorrentes com ON CONFLICT e pula os já gerados', async () => {
    const responder = (sql) => {
      if (sql.includes('FROM custos_recorrentes')) {
        return { rows: [
          { id: 'r1', nome: 'Aluguel', grupo: 'estrutural', valor: '3000', dia_vencimento: 10, cartao: false, inicio: '2026-01-01', fim: null, ativo: true },
          { id: 'r2', nome: 'Contabilidade', grupo: 'diversos', valor: '400', dia_vencimento: 5, cartao: false, inicio: '2026-01-01', fim: null, ativo: true },
        ] }
      }
      if (sql.includes('FROM custos')) return { rows: [{ recorrente_id: 'r1', competencia: '2026-03-01' }] }
      if (sql.includes('INSERT INTO custos')) return { rows: [{ id: 'novo' }] }
      return { rows: [] }
    }
    const { app, queryMock } = buildApp({ responder })
    await app.register(financeiroRoutes)
    const res = await app.inject({ method: 'POST', url: '/v1/financeiro/custos/gerar?mes=2026-03' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ inseridos: 1 })
    const ins = queryMock.mock.calls.filter(([sql]) => sql.includes('INSERT INTO custos'))
    expect(ins).toHaveLength(1)
    expect(ins[0][0]).toContain('ON CONFLICT (recorrente_id, competencia) DO NOTHING')
    expect(ins[0][1]).toEqual([TENANT, 'Contabilidade', 400, 'fixo', 'diversos', '2026-03-01', 5, false, 'r2', null])
    expectTenantExplicito(queryMock)
    await app.close()
  })
})

describe('custos e receitas — escrita', () => {
  it('PATCH /custos/:id/pagar marca como pago com tenant explícito', async () => {
    const { app, queryMock } = buildApp({ responder: () => ({ rows: [{ id: 'k1', valor: '100', status: 'pago' }] }) })
    await app.register(financeiroRoutes)
    const id = '22222222-2222-4222-8222-222222222222'
    const res = await app.inject({ method: 'PATCH', url: `/v1/financeiro/custos/${id}/pagar`, payload: { data_pagamento: '2026-03-10' } })
    expect(res.statusCode).toBe(200)
    expect(queryMock.mock.calls[0][1]).toEqual([id, TENANT, '2026-03-10', null])
    expect(queryMock.mock.calls[0][0]).toContain("status = 'pago'")
    await app.close()
  })

  it('PATCH /receitas/:id/receber sem valores recebe o previsto integral', async () => {
    const responder = (sql) => {
      if (sql.startsWith('\n        SELECT')) {
        return { rows: [{ id: 'rp1', fixo_previsto: '1000', comissao_prevista: '250', dia_vencimento: 10, competencia: '2026-03-01' }] }
      }
      if (sql.includes('UPDATE receitas_previstas\n           SET fixo_recebido')) {
        return { rows: [{ fixo_previsto: '1000', comissao_prevista: '250', fixo_recebido: '1000', comissao_recebida: '250', dia_vencimento: 10, competencia: '2026-03-01' }] }
      }
      return { rows: [] }
    }
    const { app, queryMock } = buildApp({ responder })
    await app.register(financeiroRoutes)
    const id = '33333333-3333-4333-8333-333333333333'
    const res = await app.inject({ method: 'PATCH', url: `/v1/financeiro/receitas/${id}/receber`, payload: {} })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'recebido', fixo_recebido: 1000, comissao_recebida: 250 })
    expectTenantExplicito(queryMock)
    await app.close()
  })

  it('POST /custos aceita payload legado e preenche grupo pelo tipo', async () => {
    const { app, queryMock } = buildApp({ responder: () => ({ rows: [{ id: 'k1', valor: '1500' }] }) })
    await app.register(financeiroRoutes)
    const res = await app.inject({
      method: 'POST', url: '/v1/financeiro/custos',
      payload: { descricao: 'Aluguel', valor: 1500, tipo: 'aluguel', competencia: '2026-04' },
    })
    expect(res.statusCode).toBe(201)
    expect(queryMock.mock.calls[0][1]).toEqual([TENANT, 'Aluguel', 1500, 'aluguel', '2026-04-01', 'estrutural', 'previsto', null, null, false, null])
    await app.close()
  })

  it('id inválido retorna 400 sem tocar no banco', async () => {
    const { app, queryMock } = buildApp()
    await app.register(financeiroRoutes)
    const res = await app.inject({ method: 'DELETE', url: '/v1/financeiro/custos/abc' })
    expect(res.statusCode).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('papel sem WRITE_FINANCEIRO não gera receitas', async () => {
    const { app, queryMock } = buildApp({ papel: 'financeiro_readonly' })
    await app.register(financeiroRoutes)
    const res = await app.inject({ method: 'POST', url: '/v1/financeiro/receitas/gerar?mes=2026-03' })
    expect(res.statusCode).toBe(403)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })
})
