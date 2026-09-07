import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { remuneracaoApresentadorasRoutes } from '../src/routes/remuneracao_apresentadoras.js'
import { buscarFechamentoApresentadoras, buscarHistoricoLivesApresentadora, dataEhFimDeSemana, dinheiroEmCentavos } from '../src/services/remuneracao-apresentadoras.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const presenterId = '22222222-2222-4222-8222-222222222222'
const adicionalId = '33333333-3333-4333-8333-333333333333'

function buildApp(queryMock = vi.fn().mockResolvedValue({ rows: [] })) {
  const app = Fastify()
  app.decorate('requirePapel', () => async (request) => {
    request.user = { tenant_id: tenantId, sub: '44444444-4444-4444-8444-444444444444', papel: 'financeiro' }
  })
  app.decorate('withTenant', async (_tenant, fn) => fn({ query: queryMock }))
  app.decorate('audit', { log: vi.fn().mockResolvedValue(undefined) })
  app.register(remuneracaoApresentadorasRoutes)
  return { app, query: queryMock }
}

describe('remuneração de apresentadoras', () => {
  it('fecha fixo, comissão inclusive sem GMV, adicionais e bônus sem duplicar', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ apresentadora_id: presenterId, nome: 'Ana', valor: '2700.00' }] })
      .mockResolvedValueOnce({ rows: [{ apresentadora_id: presenterId, nome: 'Ana', valor: '35.50' }] })
      .mockResolvedValueOnce({ rows: [
        { id: adicionalId, apresentadora_id: presenterId, nome: 'Ana', tipo: 'fim_de_semana', descricao: 'Sábado', data_referencia: '2026-09-05', valor: '100.00' },
        { id: '55555555-5555-4555-8555-555555555555', apresentadora_id: presenterId, nome: 'Ana', tipo: 'bonificacao', descricao: 'Meta especial', data_referencia: null, valor: '25.25' },
      ] })
    const fechamento = await buscarFechamentoApresentadoras({ query }, { tenantId, mes: '2026-09' })
    expect(fechamento.apresentadoras).toEqual([expect.objectContaining({ fixo: 2700, comissao: 35.5, adicionais: 125.25, total: 2860.75 })])
    expect(fechamento.totais).toEqual({ fixo: 2700, comissao: 35.5, adicionais: 125.25, total: 2860.75 })
    expect(String(query.mock.calls[1][0])).toContain("COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'")
    expect(String(query.mock.calls[1][0])).not.toContain('HAVING')
  })

  it('usa o mesmo rateio de contrato do DRE para entrada ou saída no mês', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ apresentadora_id: presenterId, nome: 'Ana', valor: '1440.00' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    const fechamento = await buscarFechamentoApresentadoras({ query }, { tenantId, mes: '2026-09' })
    // 16 dias ativos em setembro (15 a 30) × R$2.700 / 30 = R$1.440.
    expect(fechamento.apresentadoras[0]).toMatchObject({ fixo: 1440, total: 1440 })
    const sql = String(query.mock.calls[0][0])
    expect(sql).toContain('a.data_inicio')
    expect(sql).toContain('a.data_fim')
    expect(sql).toContain('EXTRACT(DAY')
  })

  it('arredonda cada componente em centavos antes de fechar o total', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ apresentadora_id: presenterId, nome: 'Ana', valor: '2612.90' }] })
      .mockResolvedValueOnce({ rows: [{ apresentadora_id: presenterId, nome: 'Ana', valor: '0.10' }] })
      .mockResolvedValueOnce({ rows: [{ id: adicionalId, apresentadora_id: presenterId, nome: 'Ana', tipo: 'bonificacao', descricao: 'Extra', data_referencia: null, valor: '0.01' }] })
    const fechamento = await buscarFechamentoApresentadoras({ query }, { tenantId, mes: '2026-08' })
    expect(fechamento.apresentadoras[0]).toMatchObject({ fixo: 2612.9, comissao: 0.1, adicionais: 0.01, total: 2613.01 })
    expect(fechamento.totais.total).toBe(2613.01)
    expect(String(query.mock.calls[0][0])).toContain('ROUND(COALESCE')
  })

  it('aceita apenas sábado/domingo real no mesmo mês e fixa diária em R$100', async () => {
    const { app, query } = buildApp(vi.fn().mockResolvedValue({ rows: [{ id: adicionalId, valor: '100.00', criado: true }] }))
    const ok = await app.inject({ method: 'POST', url: '/v1/financeiro/adicionais-apresentadoras', payload: {
      mes: '2026-09', apresentadora_id: presenterId, tipo: 'fim_de_semana', descricao: 'Plantão', data_referencia: '2026-09-05', valor: '999.99',
    } })
    expect(ok.statusCode).toBe(201)
    expect(query.mock.calls[0][1][6]).toBe(100)
    const invalid = await app.inject({ method: 'POST', url: '/v1/financeiro/adicionais-apresentadoras', payload: {
      mes: '2026-09', apresentadora_id: presenterId, tipo: 'fim_de_semana', descricao: 'Segunda', data_referencia: '2026-09-07',
    } })
    expect(invalid.statusCode).toBe(400)
    await app.close()
  })

  it('rejeita bônus sem centavos estritos, zero e data fora da competência', async () => {
    const { app } = buildApp()
    for (const valor of ['1.999', 0, '-1']) {
      const res = await app.inject({ method: 'POST', url: '/v1/financeiro/adicionais-apresentadoras', payload: {
        mes: '2026-09', apresentadora_id: presenterId, tipo: 'bonificacao', descricao: 'Extra', valor,
      } })
      expect(res.statusCode).toBe(400)
    }
    const fora = await app.inject({ method: 'POST', url: '/v1/financeiro/adicionais-apresentadoras', payload: {
      mes: '2026-09', apresentadora_id: presenterId, tipo: 'bonificacao', descricao: 'Extra', valor: '20.00', data_referencia: '2026-10-01',
    } })
    expect(fora.statusCode).toBe(400)
    await app.close()
  })

  it('retorna o adicional original no retry com request_id, sem nova auditoria', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: adicionalId, apresentadora_id: presenterId, competencia: '2026-09-01', tipo: 'bonificacao', descricao: 'Meta', data_referencia: null, valor: '30.00', criado: false }] })
    const { app } = buildApp(query)
    const res = await app.inject({ method: 'POST', url: '/v1/financeiro/adicionais-apresentadoras', payload: {
      mes: '2026-09', apresentadora_id: presenterId, tipo: 'bonificacao', descricao: 'Meta', valor: '30.00', request_id: '66666666-6666-4666-8666-666666666666',
    } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: adicionalId, valor: 30 })
    expect(app.audit.log).not.toHaveBeenCalled()
    await app.close()
  })

  it('recusa request_id reaproveitado com dados diferentes', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: adicionalId, apresentadora_id: presenterId, competencia: '2026-09-01', tipo: 'bonificacao', descricao: 'Original', data_referencia: null, valor: '30.00', criado: false }] })
    const { app } = buildApp(query)
    const res = await app.inject({ method: 'POST', url: '/v1/financeiro/adicionais-apresentadoras', payload: {
      mes: '2026-09', apresentadora_id: presenterId, tipo: 'bonificacao', descricao: 'Mudou', valor: '30.00', request_id: '66666666-6666-4666-8666-666666666666',
    } })
    expect(res.statusCode).toBe(409)
    await app.close()
  })

  it('mantém utilitários de calendário e centavos determinísticos', () => {
    expect(dataEhFimDeSemana('2026-09-05')).toBe(true)
    expect(dataEhFimDeSemana('2026-09-06')).toBe(true)
    expect(dataEhFimDeSemana('2026-09-07')).toBe(false)
    expect(dataEhFimDeSemana('2026-02-31')).toBe(false)
    expect(dinheiroEmCentavos('10,25')).toBe(1025)
    expect(dinheiroEmCentavos('10.001')).toBeNull()
    expect(dinheiroEmCentavos('99999999999999.99')).toBeNull()
  })

  it('retorna histórico fechado sem fan-out e memória completa que reconcilia com a comissão', async () => {
    const query = vi.fn(async (sql) => {
      if (sql.startsWith('BEGIN') || sql === 'COMMIT') return { rows: [] }
      if (sql.includes('WITH lives_atendidas')) {
        expect(sql).toContain('UNION')
        expect(sql).toContain('live_apresentadores la')
        expect(sql).toContain('live_apresentadoras_v2 lav')
        expect(sql).toContain("l.status = 'encerrada'")
        expect(sql).toContain("AT TIME ZONE 'America/Sao_Paulo'")
        expect(sql).toContain("<> 'reprovada'")
        expect(sql).not.toMatch(/ORDER BY l\.iniciado_em ASC, l\.id ASC\s+LIMIT/i)
        return { rows: [
          { live_id: 'live-zero', data: '2026-09-05', marca_nome: 'Marca A', cabine_nome: 'Cabine 1', duracao_horas: '2', gmv: '0', gmv_atribuido: '0', horas_atribuidas: '2', pedidos: '0', comissao: '0' },
          { live_id: 'live-split', data: '2026-09-06', marca_nome: 'Marca A', cabine_nome: 'Cabine 1', duracao_horas: '4', gmv: '1000', gmv_atribuido: '500', horas_atribuidas: '2', pedidos: '10', comissao: '20.25' },
        ] }
      }
      expect(sql).toContain('FROM vendas_atribuidas va')
      expect(sql).not.toMatch(/LIMIT\s+500/i)
      expect(sql).toContain("<> 'reprovada'")
      return { rows: [
        { id: 'v-live', data: '2026-09-06', origem: 'live', marca_nome: 'Marca A', gmv: '500', comissao_apresentadora: '20.25', pct_aplicado: '4.05', base_gmv_mes: '550', faixa_gmv_inicio: '0', faixa_gmv_fim: null, faixa_pct: '4.05', fim_de_semana: true },
        { id: 'v-video', data: '2026-09-07', origem: 'video', marca_nome: 'Marca A', gmv: '50', comissao_apresentadora: '2.75', pct_aplicado: '5.5', base_gmv_mes: '550', faixa_gmv_inicio: null, faixa_gmv_fim: null, faixa_pct: null, fim_de_semana: false },
      ] }
    })

    const historico = await buscarHistoricoLivesApresentadora({ query }, { tenantId, apresentadoraId: presenterId, mes: '2026-09' })

    expect(historico.total_variavel).toBe(23)
    expect(historico.memoria_completa).toBe(true)
    expect(historico.lives).toHaveLength(2)
    expect(historico.lives[0]).toMatchObject({ live_id: 'live-zero', gmv: 0, comissao: 0 })
    expect(historico.performance).toEqual({ total_lives: 2, horas_live: 4, gmv_lives: 500, gmv_por_hora: 125 })
    expect(historico.memoria).toHaveLength(2)
    expect(historico.memoria[1]).toMatchObject({ origem: 'video', comissao_apresentadora: 2.75, faixa: null })
    expect(query.mock.calls.map(([sql]) => sql)).toContain('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect(query.mock.calls.map(([sql]) => sql)).toContain('COMMIT')
  })

  it('valida competência e apresentadora antes de consultar o histórico financeiro', async () => {
    const { app, query } = buildApp()
    const idInvalido = await app.inject({ method: 'GET', url: '/v1/financeiro/fechamento-apresentadoras/invalido/detalhes?mes=2026-09' })
    const mesInvalido = await app.inject({ method: 'GET', url: `/v1/financeiro/fechamento-apresentadoras/${presenterId}/detalhes?mes=2026-13` })
    expect(idInvalido.statusCode).toBe(400)
    expect(mesInvalido.statusCode).toBe(400)
    expect(query).not.toHaveBeenCalled()
    await app.close()
  })
})
