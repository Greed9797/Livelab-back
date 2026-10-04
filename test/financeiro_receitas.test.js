import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { _clearDashboardCache } from '../src/lib/dashboard-cache.js'
import {
  conditionPayloadHash,
  normalizarMarcaCondicao,
  normalizarVencimentoCondicao,
  resolverVencimentoCondicao,
  VENCIMENTO_PADRAO,
} from '../src/lib/marca-condicoes.js'
import { marcaFixoVigenciaSql, receitaMarcaMensalSql, vencimentoSql } from '../src/lib/receita-marca-sql.js'
import { financeiroReceitasRoutes } from '../src/routes/financeiro_receitas.js'
import { marcasRoutes } from '../src/routes/marcas.js'
import {
  calcularReceitasComerciais,
  calcularVencimento,
  comporReceitaMarca,
  listarTitulosReceita,
  parseIdTitulo,
  resolverPeriodoCompetencia,
  totalizarTitulos,
} from '../src/services/receitas-comercial.js'

const tenantId = '00000000-0000-4000-8000-000000000001'
const marcaId = '00000000-0000-4000-8000-000000000002'
const clienteId = '00000000-0000-4000-8000-000000000004'
const condicaoId = '00000000-0000-4000-8000-000000000005'

describe('calcularVencimento', () => {
  it('usa o dia do mês seguinte por padrão (dia 5, offset 1)', () => {
    expect(calcularVencimento('2026-09-01')).toBe('2026-10-05')
  })
  it('dia maior que o último dia do mês vira o último dia', () => {
    expect(calcularVencimento('2026-01-01', 31, 1)).toBe('2026-02-28')
    expect(calcularVencimento('2028-01', 30, 1)).toBe('2028-02-29')
    expect(calcularVencimento('2026-08-01', 31, 1)).toBe('2026-09-30')
    expect(calcularVencimento('2026-09-01', 31, 0)).toBe('2026-09-30')
  })
  it('offset 0 vence no próprio mês; offset 1 vira o ano em dezembro', () => {
    expect(calcularVencimento('2026-09-01', 10, 0)).toBe('2026-09-10')
    expect(calcularVencimento('2026-12-01', 5, 1)).toBe('2027-01-05')
    expect(calcularVencimento('2026-12-01', 31, 0)).toBe('2026-12-31')
  })
  it('SQL de vencimento usa o mesmo clamp de último dia', () => {
    const sql = vencimentoSql('rt.competencia', 'c.dia', 'c.offset')
    expect(sql).toContain('LEAST((c.dia)::int')
    expect(sql).toContain("interval '1 month' - interval '1 day'")
  })
})

describe('comporReceitaMarca (modalidades)', () => {
  it('GMV + % soma fixo e comissão', () => {
    expect(comporReceitaMarca({ fixo: 1000, comissao: 250.555, tipo_cobranca: 'fixo_mais_comissao' }))
      .toMatchObject({ fixo: 1000, comissao: 250.56, total: 1250.56 })
  })
  it('fixo OU comissão: fixo como piso + excedente (total = maior)', () => {
    expect(comporReceitaMarca({ fixo: 2000, comissao: 2500, tipo_cobranca: 'fixo_ou_comissao' }))
      .toMatchObject({ fixo: 2000, comissao: 500, total: 2500, criterio_comissao: 'excedente_sobre_fixo' })
    expect(comporReceitaMarca({ fixo: 2000, comissao: 800, tipo_cobranca: 'fixo_ou_comissao' }))
      .toMatchObject({ fixo: 2000, comissao: 0, total: 2000 })
  })
  it('só fixo e só %', () => {
    expect(comporReceitaMarca({ fixo: 700, comissao: 0 })).toMatchObject({ fixo: 700, comissao: 0, total: 700 })
    expect(comporReceitaMarca({ fixo: 0, comissao: 400 })).toMatchObject({ fixo: 0, comissao: 400, total: 400 })
  })
})

describe('período, ids e totais', () => {
  it('resolve competências e rejeita período inválido', () => {
    expect(resolverPeriodoCompetencia('2026-07', '2026-09')).toEqual({ startDate: '2026-07-01', endDate: '2026-09-30', meses: 3 })
    expect(resolverPeriodoCompetencia('2026-02-01')).toMatchObject({ endDate: '2026-02-28' })
    expect(() => resolverPeriodoCompetencia('2026-09', '2026-07')).toThrow(/fim/)
    expect(() => resolverPeriodoCompetencia('2026-13')).toThrow(/AAAA-MM/)
    expect(() => resolverPeriodoCompetencia('2020-01', '2026-01')).toThrow(/máximo/)
  })
  it('id virtual e materializado', () => {
    expect(parseIdTitulo(`calc:${marcaId}:2026-09:fixo`)).toEqual({ tipo: 'virtual', marca_id: marcaId, mes: '2026-09', componente: 'fixo' })
    expect(parseIdTitulo(condicaoId)).toEqual({ tipo: 'materializado', id: condicaoId })
    expect(parseIdTitulo('calc:x:2026-09:fixo')).toBeNull()
    expect(parseIdTitulo('1; DROP TABLE')).toBeNull()
  })
  it('totaliza por status', () => {
    expect(totalizarTitulos([
      { valor_previsto: 100, valor_pago: 100, status: 'pago' },
      { valor_previsto: 50, valor_pago: 20, status: 'parcial' },
    ])).toEqual({ valor_previsto: 150, valor_pago: 120, em_aberto: 30, perdido: 0, quantidade: 2, por_status: { pago: 100, parcial: 50 } })
  })
})

describe('SQL de receita por vigência', () => {
  it('fixo por vigência gera todos os meses do contrato e rateia pela data de início/fim', () => {
    const sql = marcaFixoVigenciaSql()
    expect(sql).toContain('generate_series')
    expect(sql).toContain('m.data_fim')
    expect(sql).toContain("DATE '1900-01-01'")
    expect(sql).not.toContain('gmv_atribuido > 0') // não depende de atividade
    expect(receitaMarcaMensalSql({ fixo: 'atividade' })).toContain('gmv_atribuido > 0')
  })
})

function row(extra = {}) {
  return {
    marca_id: marcaId, competencia: '2026-08-01', comissao: '250', gmv: '2500', fixo: '1600',
    fixo_cheio: '3100', fator_meses: '0.516129', marca_nome: 'Alfa', marca_tipo: 'cliente',
    cliente_id: clienteId, cliente_nome: 'Cliente Alfa', condicao_id: condicaoId,
    tipo_cobranca: 'fixo_mais_comissao', fixo_vencimento_dia: 31, fixo_vencimento_mes_offset: 1,
    comissao_vencimento_dia: 10, comissao_vencimento_mes_offset: 0, ...extra,
  }
}

function dbMock({ calc = [row()], stored = [] } = {}) {
  return vi.fn(async (sql) => {
    const text = String(sql)
    if (text.includes('FROM receita_titulos rt')) return { rows: stored }
    if (text.includes('WITH comissao_marca')) return { rows: calc }
    return { rows: [], rowCount: 0 }
  })
}

describe('calcularReceitasComerciais / listarTitulosReceita (db mock)', () => {
  it('passa tenant e datas explícitos e aplica vencimento do comercial', async () => {
    const query = dbMock()
    const itens = await calcularReceitasComerciais({ query }, { tenantId, inicio: '2026-08', fim: '2026-08' })
    expect(query.mock.calls[0][1]).toEqual(['2026-08-01', '2026-08-31', tenantId])
    expect(itens).toEqual([
      expect.objectContaining({ componente: 'fixo', valor: 1600, data_vencimento: '2026-09-30', cliente_id: clienteId }),
      expect.objectContaining({ componente: 'comissao', valor: 250, data_vencimento: '2026-08-10' }),
    ])
  })

  it('título materializado prevalece e sinaliza divergência do cálculo', async () => {
    const stored = [{
      id: condicaoId, marca_id: marcaId, cliente_id: clienteId, competencia: '2026-08-01', componente: 'fixo',
      valor_previsto: '1500', valor_pago: '1500', data_vencimento: '2026-09-30', data_pagamento: '2026-09-29',
      observacao: null, marca_nome: 'Alfa', cliente_nome: 'Cliente Alfa', tipo_cobranca: 'fixo_mais_comissao',
    }]
    const itens = await listarTitulosReceita({ query: dbMock({ stored }) }, { tenantId, inicio: '2026-08', hoje: '2026-09-30' })
    const fixo = itens.find((i) => i.componente === 'fixo')
    expect(fixo).toMatchObject({ id: condicaoId, materializado: true, valor_previsto: 1500, valor_calculado: 1600, divergente: true, status: 'pago' })
    const comissao = itens.find((i) => i.componente === 'comissao')
    expect(comissao).toMatchObject({ id: `calc:${marcaId}:2026-08:comissao`, status: 'atrasado', natureza: 'receita', origem: 'comercial' })
    for (const campo of ['id', 'natureza', 'origem', 'descricao', 'competencia', 'data_vencimento', 'valor_previsto', 'valor_pago', 'data_pagamento', 'status']) {
      expect(comissao).toHaveProperty(campo)
    }
  })
})

function buildApp(query, papel = 'franqueado') {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: '00000000-0000-4000-8000-000000000003', papel }
  })
  app.decorate('requirePapel', (roles) => async (request, reply) => {
    if (!roles.includes(request.user.papel)) return reply.code(403).send({ error: 'Acesso negado' })
  })
  app.decorate('withTenant', async (_tenant, fn) => fn({ query }))
  app.decorate('audit', { log: vi.fn(async () => {}) })
  return app
}

describe('rotas /v1/financeiro/receitas', () => {
  it('lista com totais e valida filtros', async () => {
    const app = buildApp(dbMock())
    await app.register(financeiroReceitasRoutes)
    const ok = await app.inject({ method: 'GET', url: '/v1/financeiro/receitas?mes=2026-08' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ inicio: '2026-08', fim: '2026-08', totais: { valor_previsto: 1850, quantidade: 2 } })
    expect((await app.inject({ method: 'GET', url: '/v1/financeiro/receitas?status=vencido' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/v1/financeiro/receitas?inicio=2026-9' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/v1/financeiro/receitas?inicio=2026-09&fim=2026-07' })).statusCode).toBe(400)
    await app.close()
  })

  it('escrita exige WRITE_FINANCEIRO e valida payload', async () => {
    const leitor = buildApp(dbMock(), 'financeiro_readonly')
    await leitor.register(financeiroReceitasRoutes)
    expect((await leitor.inject({ method: 'GET', url: '/v1/financeiro/receitas' })).statusCode).toBe(200)
    expect((await leitor.inject({ method: 'POST', url: '/v1/financeiro/receitas/gerar?mes=2026-08' })).statusCode).toBe(403)
    await leitor.close()

    const app = buildApp(dbMock())
    await app.register(financeiroReceitasRoutes)
    expect((await app.inject({ method: 'POST', url: '/v1/financeiro/receitas/gerar' })).statusCode).toBe(400)
    const invalido = await app.inject({ method: 'PATCH', url: `/v1/financeiro/receitas/${condicaoId}/receber`, payload: { valor_pago: 0 } })
    expect(invalido.statusCode).toBe(400)
    const extra = await app.inject({ method: 'PATCH', url: `/v1/financeiro/receitas/${condicaoId}/receber`, payload: { status: 'pago' } })
    expect(extra.statusCode).toBe(400)
    const idRuim = await app.inject({ method: 'PATCH', url: '/v1/financeiro/receitas/abc/receber', payload: {} })
    expect(idRuim.statusCode).toBe(404)
    const desfazVirtual = await app.inject({ method: 'PATCH', url: `/v1/financeiro/receitas/calc:${marcaId}:2026-08:fixo/desfazer` })
    expect(desfazVirtual.statusCode).toBe(404)
    await app.close()
  })

  it('gerar materializa com upsert por (tenant, marca, competência, componente)', async () => {
    const calls = []
    const query = vi.fn(async (sql, params) => {
      const text = String(sql)
      calls.push([text, params])
      if (text.includes('WITH comissao_marca')) return { rows: [row()] }
      if (text.includes('INSERT INTO receita_titulos')) return { rows: [{ id: condicaoId, inserido: true }] }
      if (text.includes('DELETE FROM receita_titulos')) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 0 }
    })
    const app = buildApp(query)
    await app.register(financeiroReceitasRoutes)
    const res = await app.inject({ method: 'POST', url: '/v1/financeiro/receitas/gerar?mes=2026-08' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ mes: '2026-08', criados: 2, atualizados: 0, removidos: 0 })
    const inserts = calls.filter(([t]) => t.includes('INSERT INTO receita_titulos'))
    expect(inserts).toHaveLength(2)
    expect(inserts[0][0]).toContain('ON CONFLICT (tenant_id, marca_id, competencia, componente)')
    expect(inserts[0][1][0]).toBe(tenantId)
    expect(calls.map(([t]) => t)).toContain('COMMIT')
    await app.close()
  })
})

describe('vencimento na condição comercial', () => {
  it('valida dia 1-31 e offset 0|1', () => {
    expect(normalizarVencimentoCondicao({ fixo_vencimento_dia: 31, comissao_vencimento_mes_offset: 0 }))
      .toEqual({ fixo_vencimento_dia: 31, comissao_vencimento_mes_offset: 0 })
    expect(() => normalizarVencimentoCondicao({ fixo_vencimento_dia: 0 })).toThrow(/entre 1 e 31/)
    expect(() => normalizarVencimentoCondicao({ comissao_vencimento_dia: 32 })).toThrow(/entre 1 e 31/)
    expect(() => normalizarVencimentoCondicao({ fixo_vencimento_mes_offset: 2 })).toThrow(/0 \(mesmo mês\) ou 1/)
  })

  it('herda da versão anterior e cai no padrão dia 5 / mês seguinte', () => {
    expect(resolverVencimentoCondicao({}, null)).toEqual(VENCIMENTO_PADRAO)
    expect(resolverVencimentoCondicao({ fixo_vencimento_dia: 10 }, { comissao_vencimento_dia: 20, comissao_vencimento_mes_offset: 0 }))
      .toEqual({ fixo_vencimento_dia: 10, fixo_vencimento_mes_offset: 1, comissao_vencimento_dia: 20, comissao_vencimento_mes_offset: 0, comissao_janela_inicio_dia: 1 })
  })

  it('payload sem vencimento mantém o mesmo hash de idempotência de antes', () => {
    const base = { inicio_vigencia: '2026-09', fixo_mensal: 100, comissao_franquia_pct: 5 }
    expect(Object.keys(normalizarMarcaCondicao(base))).not.toContain('fixo_vencimento_dia')
    expect(conditionPayloadHash(base)).not.toContain('vencimento')
    expect(conditionPayloadHash({ ...base, fixo_vencimento_dia: 10 })).toContain('"fixo_vencimento_dia":10')
    expect(() => normalizarMarcaCondicao({ ...base, comissao_vencimento_dia: 40 })).toThrow(/entre 1 e 31/)
  })
})

describe('rota PATCH /v1/marcas/:id/condicoes/:condicaoId/vencimento', () => {
  beforeEach(() => _clearDashboardCache())

  function marcasApp(query) {
    const app = buildApp(query)
    app.decorate('db', { query })
    return app
  }

  it('valida e atualiza só o vencimento, movendo títulos em aberto', async () => {
    const query = vi.fn(async (sql, params) => {
      const text = String(sql)
      if (text.startsWith('UPDATE marca_condicoes_comerciais')) {
        expect(params.slice(0, 3)).toEqual([tenantId, marcaId, condicaoId])
        return { rows: [{ id: condicaoId, inicio_vigencia: '2026-09-01', fixo_mensal: '100', fixo_vencimento_dia: params[3], fixo_vencimento_mes_offset: 1, comissao_vencimento_dia: 5, comissao_vencimento_mes_offset: params[6] }] }
      }
      return { rows: [], rowCount: 0 }
    })
    const app = marcasApp(query)
    await app.register(marcasRoutes)
    const url = `/v1/marcas/${marcaId}/condicoes/${condicaoId}/vencimento`
    expect((await app.inject({ method: 'PATCH', url, payload: { fixo_vencimento_dia: 32 } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url, payload: { comissao_vencimento_mes_offset: 2 } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url, payload: { fixo_mensal: 10 } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url, payload: {} })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: `/v1/marcas/${marcaId}/condicoes/xyz/vencimento`, payload: { fixo_vencimento_dia: 5 } })).statusCode).toBe(404)

    const ok = await app.inject({ method: 'PATCH', url, payload: { fixo_vencimento_dia: 31, comissao_vencimento_mes_offset: 0 } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ fixo_vencimento_dia: 31, fixo_vencimento_mes_offset: 1, comissao_vencimento_dia: 5, comissao_vencimento_mes_offset: 0 })
    const moveu = query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE receita_titulos'))
    expect(String(moveu[0])).toContain('rt.valor_pago = 0')
    expect(moveu[1]).toEqual([tenantId, marcaId, condicaoId])
    expect(query.mock.calls.map(([sql]) => String(sql))).toContain('COMMIT')
    await app.close()
  })

  it('condição inexistente → 404', async () => {
    const app = marcasApp(vi.fn(async () => ({ rows: [], rowCount: 0 })))
    await app.register(marcasRoutes)
    const res = await app.inject({ method: 'PATCH', url: `/v1/marcas/${marcaId}/condicoes/${condicaoId}/vencimento`, payload: { fixo_vencimento_dia: 10 } })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: 'CONDITION_NOT_FOUND' })
    await app.close()
  })

  it('histórico de condições devolve os 4 campos de vencimento (padrão quando ausentes)', async () => {
    const query = vi.fn(async (sql) => {
      const text = String(sql)
      if (text.includes('SELECT id FROM marcas')) return { rows: [{ id: marcaId }] }
      if (text.includes('FROM marca_condicoes_comerciais')) {
        return { rows: [{ id: 'c1', inicio_vigencia: '2026-08-01', fixo_mensal: '1', revision: 1, fixo_vencimento_dia: 20, fixo_vencimento_mes_offset: 0 }] }
      }
      return { rows: [] }
    })
    const app = marcasApp(query)
    await app.register(marcasRoutes)
    const res = await app.inject({ method: 'GET', url: `/v1/marcas/${marcaId}/condicoes` })
    expect(res.json()[0]).toMatchObject({ fixo_vencimento_dia: 20, fixo_vencimento_mes_offset: 0, comissao_vencimento_dia: 5, comissao_vencimento_mes_offset: 1 })
    await app.close()
  })
})
