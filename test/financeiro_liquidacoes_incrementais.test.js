import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const command = vi.hoisted(() => ({ registrarBaixaIncremental: vi.fn() }))
vi.mock('../src/services/financeiro-liquidacoes-incrementais.js', () => command)

import { financeiroLiquidacoesIncrementaisRoutes } from '../src/routes/financeiro_liquidacoes_incrementais.js'
import { WRITE_FINANCEIRO } from '../src/config/role_groups.js'

const tenant = '10000000-0000-4000-8000-000000000001'
const titulo = '30000000-0000-4000-8000-000000000003'
const chave = '50000000-0000-4000-8000-000000000001'

describe('POST /v1/financeiro/liquidacoes/incrementais', () => {
  let app
  let requiredRoles
  let audit

  beforeEach(async () => {
    requiredRoles = []
    audit = vi.fn().mockResolvedValue(undefined)
    app = Fastify()
    app.decorateRequest('user', null)
    app.decorateRequest('viaApiKey', null)
    app.addHook('onRequest', async (request) => { request.user = { tenant_id: tenant, sub: 'user-1', papel: 'financeiro' } })
    app.decorate('authenticate', async () => {})
    app.decorate('requirePapel', (roles) => { requiredRoles.push(roles); return async () => {} })
    app.decorate('withTenant', async (_tenant, work) => work({ query: vi.fn() }))
    app.decorate('audit', { log: audit })
    await app.register(financeiroLiquidacoesIncrementaisRoutes)
    command.registrarBaixaIncremental.mockReset()
  })

  afterEach(async () => app.close())

  it('exige chave do caller e repassa valor da operação sem convertê-lo em acumulado', async () => {
    command.registrarBaixaIncremental.mockResolvedValue({ liquidacao_id: chave, valor_operacao: '300.00', valor_pago: '700.00' })
    const response = await app.inject({ method: 'POST', url: '/v1/financeiro/liquidacoes/incrementais', payload: {
      tipo: 'receita', id: titulo, valor_operacao: '300.00', data: '2026-10-09', chave_operacao: chave,
    } })
    expect(response.statusCode).toBe(200)
    expect(command.registrarBaixaIncremental).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tenantId: tenant, valorOperacao: '300.00', chaveOperacao: chave,
    }))
    expect(requiredRoles).toHaveLength(1)
    expect(requiredRoles[0]).toEqual(WRITE_FINANCEIRO)
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'financeiro.liquidacao_incremental' }))
  })

  it.each([
    [{ tipo: 'receita', id: titulo, valor_operacao: '1.00', data: '2026-10-09' }, 'chave_operacao'],
    [{ tipo: 'receita', id: titulo, valor_operacao: '0', data: '2026-10-09', chave_operacao: chave }, 'valor_operacao'],
    [{ tipo: 'receita', id: titulo, valor_operacao: '1.00', data: '09/10/2026', chave_operacao: chave }, 'data'],
  ])('retorna 400 para payload inválido (%s)', async (payload, campo) => {
    const response = await app.inject({ method: 'POST', url: '/v1/financeiro/liquidacoes/incrementais', payload })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain(campo)
    expect(command.registrarBaixaIncremental).not.toHaveBeenCalled()
  })

  it('propaga conflitos idempotentes e de saldo', async () => {
    command.registrarBaixaIncremental.mockRejectedValue(Object.assign(new Error('conflito'), {
      statusCode: 409, code: 'FINANCEIRO_IDEMPOTENCIA_CONFLITO',
    }))
    const response = await app.inject({ method: 'POST', url: '/v1/financeiro/liquidacoes/incrementais', payload: {
      tipo: 'custo', id: titulo, valor_operacao: '300.00', data: '2026-10-09', chave_operacao: chave,
    } })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'FINANCEIRO_IDEMPOTENCIA_CONFLITO' })
  })
})
