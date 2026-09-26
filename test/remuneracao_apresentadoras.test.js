import { PGlite } from '@electric-sql/pglite'
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
    expect(String(query.mock.calls[1][0])).toContain('ROUND(COALESCE(SUM')
  })

  it('arredonda comissão proporcional com escala maior que centavos em vez de estourar 500', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ apresentadora_id: presenterId, nome: 'Ana', valor: '2700.00' }] })
      .mockResolvedValueOnce({ rows: [{ apresentadora_id: presenterId, nome: 'Ana', valor: '15.921947831029052489' }] })
      .mockResolvedValueOnce({ rows: [] })
    const fechamento = await buscarFechamentoApresentadoras({ query }, { tenantId, mes: '2026-09' })
    expect(fechamento.apresentadoras[0]).toMatchObject({ fixo: 2700, comissao: 15.92, total: 2715.92 })
  })

  it('rejeita texto que não é valor monetário', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ apresentadora_id: presenterId, nome: 'Ana', valor: '2700.00' }] })
      .mockResolvedValueOnce({ rows: [{ apresentadora_id: presenterId, nome: 'Ana', valor: 'nao-e-dinheiro' }] })
      .mockResolvedValueOnce({ rows: [] })
    await expect(buscarFechamentoApresentadoras({ query }, { tenantId, mes: '2026-09' }))
      .rejects.toThrow('Valor monetário inválido retornado pelo banco')
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
        expect(sql).toContain('live_apresentadoras_v2 lav_credit')
        expect(sql).toContain('l.arquivada_em IS NULL')
        expect(sql).not.toContain('live_apresentadores la')
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

  it('fecha o mês com GMV oficial divergente sem reescrever a venda', async () => {
    const db = new PGlite()
    await db.exec(`
      CREATE TABLE apresentadoras (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        nome text NOT NULL,
        ativo boolean NOT NULL DEFAULT true,
        arquivada boolean,
        fixo numeric,
        data_inicio date,
        data_fim date
      );
      CREATE TABLE apresentadora_fixo_historico (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        apresentadora_id uuid NOT NULL,
        valor numeric,
        vigencia_inicio date NOT NULL
      );
      CREATE TABLE lives (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        ads_gmv numeric,
        manual_gmv numeric,
        fat_gerado numeric
      );
      CREATE TABLE vendas_atribuidas (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        origem text NOT NULL,
        origem_id uuid,
        apresentadora_id uuid,
        gmv numeric,
        comissao_apresentadora numeric,
        status_aprovacao text,
        data date
      );
      CREATE TABLE apresentadora_remuneracao_adicionais (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        apresentadora_id uuid NOT NULL,
        competencia date NOT NULL,
        tipo text NOT NULL,
        descricao text NOT NULL,
        data_referencia date,
        valor numeric NOT NULL,
        cancelado_em timestamptz,
        criado_em timestamptz NOT NULL DEFAULT NOW()
      );
    `)
    const zeroId = '33333333-3333-4333-8333-333333333333'
    const ausenteId = '44444444-4444-4444-8444-444444444444'
    const nulaId = '55555555-5555-4555-8555-555555555555'
    const liveOficial = '66666666-6666-4666-8666-666666666666'
    const liveZero = '77777777-7777-4777-8777-777777777777'
    const liveSemGmv = '88888888-8888-4888-8888-888888888888'
    const liveNula = '99999999-9999-4999-8999-999999999999'
    await db.exec(`
      INSERT INTO apresentadoras (id, tenant_id, nome, ativo, arquivada, fixo) VALUES
        ('${presenterId}', '${tenantId}', 'Ana', true, false, 2700),
        ('${zeroId}', '${tenantId}', 'Bia', true, false, 2700),
        ('${ausenteId}', '${tenantId}', 'Cia', true, false, 2700),
        ('${nulaId}', '${tenantId}', 'Dia', true, false, 2700);
      INSERT INTO lives (id, tenant_id, ads_gmv, manual_gmv, fat_gerado) VALUES
        ('${liveOficial}', '${tenantId}', NULL, 1592, 2533.69),
        ('${liveZero}', '${tenantId}', NULL, 500, NULL),
        ('${liveSemGmv}', '${tenantId}', NULL, NULL, NULL),
        ('${liveNula}', '${tenantId}', NULL, 800, NULL);
      INSERT INTO vendas_atribuidas
        (id, tenant_id, origem, origem_id, apresentadora_id, gmv, comissao_apresentadora, status_aprovacao, data)
      VALUES
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${tenantId}', 'live', '${liveOficial}', '${presenterId}', 2533.69, 25.34, 'aprovada', '2026-09-10'),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '${tenantId}', 'live', '${liveZero}', '${zeroId}', 0, 0, 'aprovada', '2026-09-11'),
        ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '${tenantId}', 'live', '${liveSemGmv}', '${ausenteId}', 100, 4, 'aprovada', '2026-09-12'),
        ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '${tenantId}', 'live', '${liveNula}', '${nulaId}', NULL, NULL, 'aprovada', '2026-09-13');
    `)
    let tail = Promise.resolve()
    const writes = []
    const client = {
      query(sql, params) {
        if (/^\s*(insert|update|delete)\b/i.test(sql)) writes.push(sql)
        const run = tail.then(() => db.query(sql, params))
        tail = run.then(() => {}, () => {})
        return run
      },
    }

    const fechamento = await buscarFechamentoApresentadoras(client, { tenantId, mes: '2026-09' })
    const porNome = Object.fromEntries(fechamento.apresentadoras.map((item) => [item.nome, item]))

    expect(porNome.Ana).toMatchObject({ comissao: 15.92, fixo: 2700 })
    expect(porNome.Bia.comissao).toBe(0)
    expect(porNome.Cia.comissao).toBe(4)
    expect(writes).toEqual([])

    const gravado = await db.query(`SELECT apresentadora_id, gmv::text AS gmv, comissao_apresentadora::text AS comissao FROM vendas_atribuidas ORDER BY data`)
    expect(gravado.rows).toEqual([
      { apresentadora_id: presenterId, gmv: '2533.69', comissao: '25.34' },
      { apresentadora_id: zeroId, gmv: '0', comissao: '0' },
      { apresentadora_id: ausenteId, gmv: '100', comissao: '4' },
      { apresentadora_id: nulaId, gmv: null, comissao: null },
    ])
    await db.close()
  })
})
