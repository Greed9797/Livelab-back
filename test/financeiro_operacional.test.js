// GET /v1/financeiro/operacional — resultado operacional automático:
// entradas (comissão de franquia por marca + fixo mensal de marca) −
// saídas (fixo/comissão de apresentadoras + custos manuais), com memória
// de cálculo por lançamento e vendas reprovadas SEMPRE fora das somas.

import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { financeiroRoutes } from '../src/routes/financeiro.js'

const tenantId = '11111111-1111-4111-8111-111111111111'

function buildApp({ queryMock } = {}) {
  const app = Fastify()
  const query = queryMock ?? vi.fn().mockResolvedValue({ rows: [] })

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

// Mock que despacha pelo shape do SQL de cada uma das 5 queries do endpoint.
function operacionalQueryMock() {
  return vi.fn().mockImplementation(async (sql) => {
    const s = String(sql)
    if (s.includes('SUM(va.comissao_franquia)')) {
      return { rows: [{ marca_id: 'm1', marca_nome: 'Marca A', valor: '250.00', gmv: '10000.00', lives: 4 }] }
    }
    if (s.includes('SUM(va.comissao_apresentadora)')) {
      return { rows: [{ apresentadora_id: 'ap1', nome: 'Ana', valor: '100.00', gmv: '10000.00' }] }
    }
    if (s.includes('valor_fixo_minimo > 0')) {
      return { rows: [{ marca_id: 'm1', marca_nome: 'Marca A', valor_fixo_minimo: '300.00', meses_ativos: 1 }] }
    }
    if (s.includes('FROM apresentadoras a')) {
      return { rows: [{ apresentadora_id: 'ap1', nome: 'Ana', valor: '2700.00' }] }
    }
    if (s.includes('FROM custos')) {
      return { rows: [
        { id: 'c1', descricao: 'Aluguel galpão', valor: '1000.00', tipo: 'aluguel', competencia: '2026-06-01' },
        { id: 'c2', descricao: 'Material descartável', valor: '50.00', tipo: 'outros', competencia: '2026-06-10' },
      ] }
    }
    return { rows: [] }
  })
}

describe('GET /v1/financeiro/operacional', () => {
  it('matemática dos totais: fixa × variável e resultado = entradas − (fixas + variáveis)', async () => {
    const query = operacionalQueryMock()
    const { app } = buildApp({ queryMock: query })
    await app.register(financeiroRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/financeiro/operacional?inicio=2026-06&fim=2026-06' })
    expect(res.statusCode).toBe(200)
    const body = res.json()

    // Entradas = comissão franquia 250 + fixo marca 300×1 mês = 550
    expect(body.totais.entradas).toBe(550)
    // Fixas = fixo apresentadora 2700 + custo aluguel 1000 = 3700
    expect(body.totais.despesas_fixas).toBe(3700)
    // Variáveis = comissão apresentadora 100 + custo 'outros' 50 = 150
    expect(body.totais.despesas_variaveis).toBe(150)
    expect(body.totais.resultado).toBe(550 - 3700 - 150)

    // resultado bate com a soma dos próprios lançamentos retornados
    const somaEntradas = body.entradas.reduce((s, l) => s + l.valor, 0)
    const somaSaidas = body.saidas.reduce((s, l) => s + l.valor, 0)
    expect(body.totais.resultado).toBe(somaEntradas - somaSaidas)
    expect(body.periodo).toEqual({ inicio: '2026-06-01', fim: '2026-06-30' })
    await app.close()
  })

  it('memória de cálculo por lançamento (pct_medio, gmv, lives, critérios)', async () => {
    const { app } = buildApp({ queryMock: operacionalQueryMock() })
    await app.register(financeiroRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/financeiro/operacional?inicio=2026-06&fim=2026-06' })
    const body = res.json()

    const franquia = body.entradas.find((l) => l.categoria === 'comissao_franquia')
    expect(franquia.memoria).toEqual({ marca_id: 'm1', marca_nome: 'Marca A', gmv: 10000, lives: 4, pct_medio: 2.5 })

    const fixoMarca = body.entradas.find((l) => l.categoria === 'fixo_marca')
    expect(fixoMarca.memoria.criterio).toBe('mes_com_atividade')

    const comissaoAp = body.saidas.find((l) => l.categoria === 'comissao_apresentadora')
    expect(comissaoAp.memoria).toEqual({ apresentadora_id: 'ap1', nome: 'Ana', gmv_atribuido: 10000, pct_medio: 1 })

    const fixoAp = body.saidas.find((l) => l.categoria === 'fixo_apresentadora')
    expect(fixoAp.memoria.criterio).toBe('fixo_mensal')

    const custo = body.saidas.find((l) => l.categoria === 'custo_manual' && l.memoria.custo_id === 'c1')
    expect(custo.memoria.tipo).toBe('aluguel')
    await app.close()
  })

  it('vendas reprovadas ficam FORA das somas (predicado no SQL das duas queries de vendas)', async () => {
    const { app, query } = buildApp({ queryMock: operacionalQueryMock() })
    await app.register(financeiroRoutes)

    await app.inject({ method: 'GET', url: '/v1/financeiro/operacional?inicio=2026-06&fim=2026-06' })

    const vendaCalls = query.mock.calls.filter(([sql]) =>
      String(sql).includes('SUM(va.comissao_franquia)') || String(sql).includes('SUM(va.comissao_apresentadora)'))
    expect(vendaCalls).toHaveLength(2)
    for (const [sql] of vendaCalls) {
      expect(String(sql)).toContain(`COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'`)
    }
    await app.close()
  })

  it('fixo de marca do /operacional usa a MESMA fonte do /resumo (marcaFixoMensalSql compartilhada)', async () => {
    const { app, query } = buildApp({ queryMock: operacionalQueryMock() })
    await app.register(financeiroRoutes)

    // Período distinto do resto da suíte: /resumo tem cache in-memory por tenant+período.
    await app.inject({ method: 'GET', url: '/v1/financeiro/operacional?inicio=2026-07&fim=2026-07' })
    await app.inject({ method: 'GET', url: '/v1/financeiro/resumo?inicio=2026-07&fim=2026-07' })

    const marker = `m.tipo = 'cliente'` // WHERE da fonte compartilhada
    const calls = query.mock.calls.filter(([sql]) => String(sql).includes(marker) && String(sql).includes('meses_ativos'))
    expect(calls.length).toBeGreaterThanOrEqual(2) // uma no /operacional, uma no /resumo
    await app.close()
  })
})
