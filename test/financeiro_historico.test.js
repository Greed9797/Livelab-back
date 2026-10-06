import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/services/financeiro-liquidacoes-legacy-comparison.js', () => ({ compararLiquidacoesLegado: vi.fn() }))
vi.mock('../src/services/financeiro-liquidacoes-read.js', () => ({ lerLiquidacoesOrigem: vi.fn() }))

import { compararLiquidacoesLegado } from '../src/services/financeiro-liquidacoes-legacy-comparison.js'
import { lerLiquidacoesOrigem } from '../src/services/financeiro-liquidacoes-read.js'
import { financeiroHistoricoRoutes } from '../src/routes/financeiro_historico.js'

const ID = '00000000-0000-4000-8000-000000000001'
const URL = `/v1/financeiro/consulta/marca_fixo/${ID}/historico`

async function appFor(role = 'financeiro_readonly', tenantId = '00000000-0000-4000-8000-000000000002') {
  const app = Fastify()
  const queries = []
  app.decorate('requirePapel', (roles) => async (request, reply) => {
    if (!roles.includes(role)) return reply.code(403).send({ error: 'forbidden' })
    request.user = { tenant_id: tenantId, papel: role }
  })
  app.decorate('withTenant', async (tenant, fn) => fn({
    tenantId: tenant, query: async (sql) => { queries.push(sql) },
  }))
  await app.register(financeiroHistoricoRoutes)
  return { app, queries }
}

beforeEach(() => {
  compararLiquidacoesLegado.mockReset().mockResolvedValue([{
    componente: 'fixo', origem_categoria: 'marca_fixo', classificacao: 'matching', valor_legado: '10.00',
    valor_canonico: '10.00', natureza_incorreta: 0,
  }])
  lerLiquidacoesOrigem.mockReset().mockResolvedValue({
    total_liquidado: '10.00', total_estornado: '2.00', total_liquido: '8.00',
    liquidacoes: [{ id: ID, valor: '10.00', total_estornado: '2.00', total_liquido: '8.00', estornos: [] }],
  })
})

describe('FIN-04 histórico do detalhe', () => {
  it('lê comparação e eventos no mesmo snapshot do tenant', async () => {
    const { app, queries } = await appFor()
    const response = await app.inject({ url: URL })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      origem_tipo: 'receita_titulo', componente: 'fixo', estado_comparacao: 'matching',
      historico_incompleto: false, total_liquido: '8.00',
    })
    expect(compararLiquidacoesLegado).toHaveBeenCalledWith(expect.objectContaining({ tenantId: '00000000-0000-4000-8000-000000000002' }),
      { tenantId: '00000000-0000-4000-8000-000000000002', origemTipo: 'receita_titulo', origemIds: [ID] })
    expect(lerLiquidacoesOrigem).toHaveBeenCalledWith(expect.anything(), {
      tenantId: '00000000-0000-4000-8000-000000000002', origemTipo: 'receita_titulo', origemId: ID, listarDatas: true,
    })
    expect(queries).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT'])
    await app.close()
  })

  it('sinaliza legado sem fatos, em vez de mostrar zero como histórico completo', async () => {
    compararLiquidacoesLegado.mockResolvedValue([{ componente: 'fixo', origem_categoria: 'marca_fixo', classificacao: 'legacy-only', valor_legado: '10.00', valor_canonico: null, natureza_incorreta: 0 }])
    lerLiquidacoesOrigem.mockResolvedValue({ total_liquidado: '0.00', total_estornado: '0.00', total_liquido: '0.00', liquidacoes: [] })
    const { app } = await appFor()
    expect((await app.inject({ url: URL })).json()).toMatchObject({
      estado_comparacao: 'legacy-only', historico_incompleto: true, valor_legado: '10.00', liquidacoes: [],
    })
    await app.close()
  })

  it('não consulta fatos de origem ausente nem aceita IDs virtuais/sem papel', async () => {
    compararLiquidacoesLegado.mockResolvedValue([])
    const { app } = await appFor()
    expect((await app.inject({ url: URL })).statusCode).toBe(404)
    expect(lerLiquidacoesOrigem).not.toHaveBeenCalled()
    expect((await app.inject({ url: URL.replace(ID, 'calc:2026-10') })).statusCode).toBe(400)
    await app.close()
    const denied = await appFor('apresentador')
    expect((await denied.app.inject({ url: URL })).statusCode).toBe(403)
    await denied.app.close()
  })

  it('não apresenta comissão de marca como componente fixo por URL manipulada', async () => {
    compararLiquidacoesLegado.mockResolvedValue([{ componente: 'comissao', origem_categoria: 'marca_comissao', classificacao: 'matching', valor_legado: '1.00', valor_canonico: '1.00', natureza_incorreta: 0 }])
    const { app } = await appFor()
    expect((await app.inject({ url: URL })).statusCode).toBe(404)
    expect(lerLiquidacoesOrigem).not.toHaveBeenCalled()
    await app.close()
  })

  it('faz rollback se a leitura de fatos falhar', async () => {
    lerLiquidacoesOrigem.mockRejectedValue(new Error('db failed'))
    const { app, queries } = await appFor()
    expect((await app.inject({ url: URL })).statusCode).toBe(500)
    expect(queries).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK'])
    await app.close()
  })
})
