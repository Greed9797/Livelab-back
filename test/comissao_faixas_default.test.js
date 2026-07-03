import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { comissoesRoutes } from '../src/routes/comissoes.js'

// Recálculo é fire-and-forget pós-resposta — mocka pra asserir quem foi
// recalculado sem depender do commission-engine real.
const { recalcMock } = vi.hoisted(() => ({
  recalcMock: vi.fn().mockResolvedValue({ updated: 1 }),
}))
vi.mock('../src/routes/vendas_atribuidas.js', () => ({
  recalcularVendasAtribuidasApresentadora: recalcMock,
}))

const TENANT = 'tenant-uuid-1'

function buildApp(queryMock) {
  const app = Fastify()
  const releaseMock = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: TENANT, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: TENANT, sub: 'user-1', papel: 'franqueado' }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('db', { query: queryMock })
  app.decorate('dbTenant', async () => ({ query: queryMock, release: releaseMock }))
  app.decorate('withTenant', async (tenantId, fn) => {
    const db = await app.dbTenant(tenantId)
    try { return await fn(db) } finally { db.release() }
  })

  return app
}

// Mock roteado por trecho de SQL — o CRUD + propagação executa várias queries
// distintas na mesma conexão (BEGIN, helper de tiers 2x, mutação, propagação).
function buildRoutedQueryMock({ tiersSets = [], afetadas = [], faixaRow = null }) {
  let tiersCall = 0
  return vi.fn(async (sql, params) => {
    const s = String(sql)
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s.trim())) return { rows: [] }
    // helper getTenantDefaultCommissionTiers (SELECT sem id)
    if (s.includes('FROM tenant_comissao_faixas_default') && s.includes('SELECT gmv_inicio')) {
      const rows = tiersSets[Math.min(tiersCall, tiersSets.length - 1)] ?? []
      tiersCall += 1
      return { rows }
    }
    if (s.includes('INSERT INTO tenant_comissao_faixas_default')) {
      return {
        rows: [{
          id: 'faixa-nova',
          gmv_inicio: String(params[1]),
          gmv_fim: params[2] === null ? null : String(params[2]),
          comissao_pct: String(params[3]),
          criado_em: '2026-07-03T00:00:00.000Z',
          atualizado_em: '2026-07-03T00:00:00.000Z',
        }],
      }
    }
    if (s.includes('WITH antigo')) {
      return { rows: afetadas.map((id) => ({ apresentadora_id: id })) }
    }
    if (s.includes('DELETE FROM tenant_comissao_faixas_default')) {
      return { rows: faixaRow ? [faixaRow] : [] }
    }
    if (s.includes('FROM tenant_comissao_faixas_default') && s.includes('SELECT id,')) {
      return { rows: faixaRow ? [faixaRow] : [] }
    }
    return { rows: [] }
  })
}

describe('GET /v1/comissoes/faixas-default', () => {
  it('devolve as faixas ordenadas por gmv_inicio com números serializados', async () => {
    const queryMock = vi.fn().mockResolvedValue({
      rows: [
        { id: 'f1', gmv_inicio: '0', gmv_fim: '70000', comissao_pct: '1', criado_em: 'c1', atualizado_em: 'a1' },
        { id: 'f2', gmv_inicio: '70000.01', gmv_fim: null, comissao_pct: '1.5', criado_em: 'c2', atualizado_em: 'a2' },
      ],
    })
    const app = buildApp(queryMock)
    await app.register(comissoesRoutes)

    const response = await app.inject({ method: 'GET', url: '/v1/comissoes/faixas-default' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([
      { id: 'f1', gmv_inicio: 0, gmv_fim: 70000, comissao_pct: 1, criado_em: 'c1', atualizado_em: 'a1' },
      { id: 'f2', gmv_inicio: 70000.01, gmv_fim: null, comissao_pct: 1.5, criado_em: 'c2', atualizado_em: 'a2' },
    ])

    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toContain('FROM tenant_comissao_faixas_default')
    expect(sql).toContain('ORDER BY gmv_inicio ASC')
    expect(params).toEqual([TENANT])
  })
})

describe('POST /v1/comissoes/faixas-default — validação', () => {
  it.each([
    ['gmv_inicio negativo', { gmv_inicio: -1, gmv_fim: null, comissao_pct: 1 }],
    ['gmv_fim <= gmv_inicio', { gmv_inicio: 70000, gmv_fim: 70000, comissao_pct: 1 }],
    ['comissao_pct > 100', { gmv_inicio: 0, gmv_fim: null, comissao_pct: 150 }],
    ['comissao_pct ausente', { gmv_inicio: 0, gmv_fim: null }],
  ])('rejeita %s com 400 sem tocar o banco', async (_label, body) => {
    const queryMock = vi.fn()
    const app = buildApp(queryMock)
    await app.register(comissoesRoutes)

    const response = await app.inject({ method: 'POST', url: '/v1/comissoes/faixas-default', payload: body })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toHaveProperty('error')
    expect(queryMock).not.toHaveBeenCalled()
  })
})

describe('POST /v1/comissoes/faixas-default — propagação', () => {
  const antigos = [
    { gmv_inicio: '0', gmv_fim: '70000', comissao_pct: '1' },
    { gmv_inicio: '70000.01', gmv_fim: '150000', comissao_pct: '1.5' },
  ]
  const novos = [
    ...antigos,
    { gmv_inicio: '150000.01', gmv_fim: null, comissao_pct: '2' },
  ]

  it('substitui apresentadora não personalizada e preserva a personalizada', async () => {
    recalcMock.mockClear()
    // O SELECT de afetadas (comparação exata de conjunto em SQL) devolve só a
    // apresentadora cujo conjunto ativo == padrão antigo; a personalizada
    // ('apres-custom') não vem — e o código só pode tocar quem veio.
    const queryMock = buildRoutedQueryMock({
      tiersSets: [antigos, novos],
      afetadas: ['apres-padrao'],
    })
    const app = buildApp(queryMock)
    await app.register(comissoesRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/comissoes/faixas-default',
      payload: { gmv_inicio: 150000.01, gmv_fim: null, comissao_pct: 2 },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      id: 'faixa-nova',
      gmv_inicio: 150000.01,
      gmv_fim: null,
      comissao_pct: 2,
    })

    const calls = queryMock.mock.calls.map(([sql, params]) => [String(sql), params])

    // 1) Seleção das afetadas compara o conjunto ATIVO com o padrão ANTIGO
    //    (capturado antes da mutação), tratando gmv_fim NULL com IS NOT DISTINCT FROM.
    const afetadasCall = calls.find(([sql]) => sql.includes('WITH antigo'))
    expect(afetadasCall).toBeDefined()
    expect(afetadasCall[0]).toContain('IS NOT DISTINCT FROM')
    expect(afetadasCall[0]).toContain('ativo = true')
    expect(afetadasCall[0]).toContain('HAVING COUNT(*)')
    expect(afetadasCall[1]).toEqual([TENANT, [0, 70000.01], [70000, 150000], [1, 1.5]])

    // 2) DELETE só das faixas ativas das apresentadoras afetadas.
    const deleteCall = calls.find(([sql]) => sql.includes('DELETE FROM apresentadora_comissao_faixas'))
    expect(deleteCall).toBeDefined()
    expect(deleteCall[0]).toContain('ativo = true')
    expect(deleteCall[1]).toEqual([TENANT, ['apres-padrao']])

    // 3) INSERT set-based do conjunto NOVO só para as afetadas (personalizada preservada).
    const insertCall = calls.find(([sql]) => sql.includes('INSERT INTO apresentadora_comissao_faixas'))
    expect(insertCall).toBeDefined()
    expect(insertCall[1]).toEqual([
      TENANT,
      ['apres-padrao'],
      [0, 70000.01, 150000.01],
      [70000, 150000, null],
      [1, 1.5, 2],
    ])

    // 4) Mutação + propagação dentro da mesma transação.
    const flat = calls.map(([sql]) => sql.trim().split(/\s/)[0])
    expect(flat).toContain('BEGIN')
    expect(flat).toContain('COMMIT')

    // 5) Fire-and-forget pós-resposta: recalcula SÓ a afetada.
    await vi.waitFor(() => {
      expect(recalcMock).toHaveBeenCalledTimes(1)
    })
    expect(recalcMock).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT,
      apresentadoraId: 'apres-padrao',
    })
  })

  it('sem apresentadora no padrão antigo, não deleta/insere nem recalcula', async () => {
    recalcMock.mockClear()
    const queryMock = buildRoutedQueryMock({
      tiersSets: [antigos, novos],
      afetadas: [], // todas personalizadas → SQL não devolve ninguém
    })
    const app = buildApp(queryMock)
    await app.register(comissoesRoutes)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/comissoes/faixas-default',
      payload: { gmv_inicio: 150000.01, gmv_fim: null, comissao_pct: 2 },
    })

    expect(response.statusCode).toBe(201)
    const sqls = queryMock.mock.calls.map(([sql]) => String(sql))
    expect(sqls.some((s) => s.includes('DELETE FROM apresentadora_comissao_faixas'))).toBe(false)
    expect(sqls.some((s) => s.includes('INSERT INTO apresentadora_comissao_faixas'))).toBe(false)
    await new Promise((resolve) => setImmediate(resolve))
    expect(recalcMock).not.toHaveBeenCalled()
  })
})

describe('DELETE /v1/comissoes/faixas-default/:faixaId', () => {
  it('faixa inexistente devolve 404 com rollback', async () => {
    const queryMock = buildRoutedQueryMock({
      tiersSets: [[{ gmv_inicio: '0', gmv_fim: null, comissao_pct: '1' }]],
      faixaRow: null,
    })
    const app = buildApp(queryMock)
    await app.register(comissoesRoutes)

    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/comissoes/faixas-default/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })

    expect(response.statusCode).toBe(404)
    const flat = queryMock.mock.calls.map(([sql]) => String(sql).trim().split(/\s/)[0])
    expect(flat).toContain('ROLLBACK')
    expect(flat).not.toContain('COMMIT')
  })
})
