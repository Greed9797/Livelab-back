// Ciclo de vida de perda (receitas) e cancelamento (custos) — frente B1 (migration 173).
// Status derivado, perder/desperder títulos do comercial (uuid e calc:), receitas avulsas,
// cancelar/reativar custos (uuid e rec:), 409s, perda parcial, gerar preservando perdido.
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import {
  MOTIVO_MAX, STATUS_LANCAMENTO, lancamentoEncerrado, normalizarMotivo, saldoEncerrado, statusLancamento,
} from '../src/lib/lancamento-status.js'
import { financeiroReceitasRoutes } from '../src/routes/financeiro_receitas.js'
import { financeiroReceitasAvulsasRoutes } from '../src/routes/financeiro_receitas_avulsas.js'
import { financeiroCustosRoutes } from '../src/routes/financeiro_custos.js'
import { gerarCustosDoMes, idVirtual as idVirtualCusto, listarCustos } from '../src/services/custos-plano.js'
import { gerarTitulosReceita, montarReceitaMensal, perderTitulo, totalizarTitulos } from '../src/services/receitas-comercial.js'
import { perderReceitaAvulsa } from '../src/services/receitas-avulsas.js'

const HOJE = '2026-09-15'
const tenantId = '00000000-0000-4000-8000-000000000001'
const marcaId = '00000000-0000-4000-8000-000000000002'
const userId = '00000000-0000-4000-8000-000000000003'
const clienteId = '00000000-0000-4000-8000-000000000004'
const tituloId = '00000000-0000-4000-8000-0000000000a1'
const avulsaId = '00000000-0000-4000-8000-0000000000b1'
const custoId = '00000000-0000-4000-8000-0000000000c1'
const recId = '00000000-0000-4000-8000-0000000000d1'
const matRecId = '00000000-0000-4000-8000-0000000000d2'

// ─── status derivado ──────────────────────────────────────────────────────

describe('statusLancamento — precedência pago > perdido/cancelado > atrasado > parcial > pendente > previsto', () => {
  const base = { valor_previsto: 100, valor_pago: 0, data_vencimento: '2026-09-20' }
  it('estados sem encerramento continuam iguais', () => {
    expect(statusLancamento(base, HOJE)).toBe('pendente')
    expect(statusLancamento({ ...base, data_vencimento: '2026-10-05' }, HOJE)).toBe('previsto')
    expect(statusLancamento({ ...base, data_vencimento: '2026-09-10' }, HOJE)).toBe('atrasado')
    expect(statusLancamento({ ...base, valor_pago: 40 }, HOJE)).toBe('parcial')
    expect(statusLancamento({ ...base, valor_pago: 40, data_vencimento: '2026-09-10' }, HOJE)).toBe('atrasado')
    expect(statusLancamento({ ...base, valor_pago: 100 }, HOJE)).toBe('pago')
  })
  it('perdido/cancelado vencem atrasado, parcial, pendente e previsto', () => {
    const perdido_em = '2026-09-14T12:00:00.000Z'
    const cancelado_em = perdido_em
    expect(statusLancamento({ ...base, perdido_em }, HOJE)).toBe('perdido')
    expect(statusLancamento({ ...base, data_vencimento: '2026-09-10', perdido_em }, HOJE)).toBe('perdido')
    expect(statusLancamento({ ...base, valor_pago: 40, perdido_em }, HOJE)).toBe('perdido')
    expect(statusLancamento({ ...base, data_vencimento: '2026-12-01', perdido_em }, HOJE)).toBe('perdido')
    expect(statusLancamento({ ...base, cancelado_em }, HOJE)).toBe('cancelado')
    expect(statusLancamento({ ...base, valor_pago: 40, data_vencimento: '2026-09-01', cancelado_em }, HOJE)).toBe('cancelado')
  })
  it('pago tem precedência sobre perdido/cancelado', () => {
    expect(statusLancamento({ ...base, valor_pago: 100, perdido_em: '2026-09-01T00:00:00Z' }, HOJE)).toBe('pago')
    expect(statusLancamento({ ...base, valor_pago: 120, cancelado_em: '2026-09-01T00:00:00Z' }, HOJE)).toBe('pago')
  })
  it('enum, saldo encerrado e motivo', () => {
    expect(STATUS_LANCAMENTO).toEqual(expect.arrayContaining(['perdido', 'cancelado']))
    expect(lancamentoEncerrado({ status: 'perdido' })).toBe(true)
    expect(lancamentoEncerrado({ status: 'atrasado' })).toBe(false)
    expect(saldoEncerrado({ status: 'perdido', valor_previsto: 100, valor_pago: 40 })).toBe(60)
    expect(saldoEncerrado({ status: 'parcial', valor_previsto: 100, valor_pago: 40 })).toBe(0)
    expect(normalizarMotivo('  ')).toBeNull()
    expect(normalizarMotivo(' calote ')).toBe('calote')
    expect(() => normalizarMotivo('x'.repeat(MOTIVO_MAX + 1))).toThrow(/300/)
  })
})

describe('totais com perdidos', () => {
  it('totalizarTitulos: em_aberto exclui o saldo perdido; valor_previsto não muda', () => {
    const t = totalizarTitulos([
      { valor_previsto: 100, valor_pago: 0, status: 'pendente' },
      { valor_previsto: 200, valor_pago: 50, status: 'perdido' },
      { valor_previsto: 80, valor_pago: 80, status: 'pago' },
    ])
    expect(t).toMatchObject({ valor_previsto: 380, valor_pago: 130, em_aberto: 100, perdido: 150 })
    expect(t.por_status).toMatchObject({ perdido: 200 })
  })

  it('montarReceitaMensal: previsto da competência inalterado; aberto/a_receber sem perdidos; total.perdido', () => {
    const t = (componente, valor, pago, status, extra = {}) => ({
      id: `calc:${marcaId}:2026-09:${componente}`, natureza: 'receita', origem: 'comercial', componente,
      descricao: componente, competencia: '2026-09-01', data_vencimento: '2026-09-20', valor_previsto: valor,
      valor_pago: pago, data_pagamento: null, marca_id: marcaId, marca_nome: 'Alfa', cliente_id: clienteId,
      cliente_nome: 'Cliente Alfa', tipo_cobranca: 'fixo_mais_comissao', materializado: true, memoria: { pct: 10 },
      status, perdido_em: null, perdido_motivo: null, ...extra,
    })
    const r = montarReceitaMensal({
      mes: '2026-09', hoje: HOJE,
      titulos: [
        t('fixo', 1000, 0, 'pendente'),
        { ...t('comissao', 300, 100, 'perdido', { perdido_em: '2026-09-14T10:00:00.000Z', perdido_motivo: 'calote' }), id: tituloId },
      ],
      avulsas: [{
        id: avulsaId, natureza: 'receita', origem: 'avulsa', grupo: 'servico', descricao: 'Serviço', competencia: '2026-09-01',
        data_vencimento: '2026-09-25', valor_previsto: 500, valor_pago: 0, aporte: false, status: 'perdido',
        perdido_em: '2026-09-14T10:00:00.000Z', perdido_motivo: null,
      }],
    })
    expect(r.competencia.total).toEqual({ previsto: 1800, pago: 100, aberto: 1000, perdido: 700 })
    expect(r.vencimento.total).toEqual({ previsto: 1800, pago: 100, aberto: 1000, perdido: 700 })
    expect(r.a_receber_mes).toBe(1000)
    const marca = r.competencia.clientes[0].marcas[0]
    expect(marca.comissao).toMatchObject({ status: 'perdido', perdido_motivo: 'calote' })
    expect(marca.total).toEqual({ previsto: 1300, pago: 100, perdido: 200 })
    expect(r.competencia.clientes[0].total).toEqual({ previsto: 1300, pago: 100, perdido: 200 })
  })
})

// ─── títulos do comercial (fake stateful) ─────────────────────────────────

function calcRow(extra = {}) {
  return {
    marca_id: marcaId, competencia: '2026-08-01', comissao: '250', gmv: '2500', fixo: '1600',
    fixo_cheio: '3100', fator_meses: '0.516129', marca_nome: 'Alfa', marca_tipo: 'cliente',
    cliente_id: clienteId, cliente_nome: 'Cliente Alfa', condicao_id: null,
    tipo_cobranca: 'fixo_mais_comissao', fixo_vencimento_dia: 31, fixo_vencimento_mes_offset: 1,
    comissao_vencimento_dia: 10, comissao_vencimento_mes_offset: 0, comissao_franquia_pct: 10, ...extra,
  }
}

/** Fake de receita_titulos: guarda as linhas e aplica os UPDATEs de perda/baixa. */
function titulosDb({ titulos = [], calc = [calcRow()] } = {}) {
  const rows = new Map(titulos.map((t) => [t.id, { ...t }]))
  let seq = 0
  const byKey = (marca, comp, componente) => [...rows.values()]
    .find((r) => r.marca_id === marca && r.competencia === comp && r.componente === componente)
  const sqls = []
  const query = vi.fn(async (sql, params = []) => {
    const text = String(sql)
    sqls.push(text)
    if (text.includes('WITH comissao_marca')) return { rows: calc }
    if (text.includes('INSERT INTO receita_titulos')) {
      const [tenant, marca, cliente, comp, componente, valor, venc] = params
      expect(tenant).toBe(tenantId)
      expect(text).toContain('WHERE receita_titulos.perdido_em IS NULL')
      const ex = byKey(marca, comp, componente)
      if (ex) {
        if (ex.perdido_em) return { rows: [] }
        ex.valor_previsto = String(valor)
        if (Number(ex.valor_pago) === 0) ex.data_vencimento = venc
        return { rows: [{ id: ex.id, inserido: false }] }
      }
      const id = `00000000-0000-4000-8000-0000000009${String(++seq).padStart(2, '0')}`
      rows.set(id, {
        id, tenant_id: tenant, marca_id: marca, cliente_id: cliente, competencia: comp, componente,
        valor_previsto: String(valor), valor_pago: '0', data_vencimento: venc, data_pagamento: null,
        perdido_em: null, perdido_motivo: null, perdido_por: null,
      })
      return { rows: [{ id, inserido: true }] }
    }
    if (/^SELECT id FROM receita_titulos/.test(text.trim())) {
      const ex = byKey(params[1], params[2], params[3])
      return { rows: ex ? [{ id: ex.id }] : [] }
    }
    if (text.includes('SELECT * FROM receita_titulos') || text.includes('SELECT id, perdido_em FROM receita_titulos')) {
      expect(params[0]).toBe(tenantId)
      const r = rows.get(params[1])
      return { rows: r ? [{ ...r }] : [] }
    }
    if (text.includes('UPDATE receita_titulos')) {
      expect(params[0]).toBe(tenantId)
      const r = rows.get(params[1])
      if (!r) return { rows: [], rowCount: 0 }
      if (text.includes('perdido_em = COALESCE(perdido_em, NOW())')) {
        if (!r.perdido_em) {
          r.perdido_em = new Date('2026-09-15T13:00:00.000Z')
          r.perdido_por = params[2]
          r.perdido_motivo = params[3]
        } else if (params[3] != null) r.perdido_motivo = params[3]
      } else if (text.includes('perdido_em = NULL')) {
        r.perdido_em = null; r.perdido_motivo = null; r.perdido_por = null
      } else if (text.includes('SET valor_pago = $3')) {
        r.valor_pago = String(params[2]); r.data_pagamento = params[3]
      } else if (text.includes('SET valor_pago = 0')) {
        r.valor_pago = '0'; r.data_pagamento = null
      }
      return { rows: [{ id: r.id }], rowCount: 1 }
    }
    if (text.includes('FROM receita_titulos rt')) {
      const id = params[5]
      return {
        rows: [...rows.values()].filter((r) => !id || r.id === id)
          .map((r) => ({ ...r, marca_nome: 'Alfa', cliente_nome: 'Cliente Alfa', tipo_cobranca: 'fixo_mais_comissao' })),
      }
    }
    if (text.includes('DELETE FROM receita_titulos')) {
      expect(text).toContain('perdido_em IS NULL')
      return { rows: [], rowCount: 0 }
    }
    return { rows: [], rowCount: 0 }
  })
  return { query, rows, sqls }
}

function buildReceitasApp(query, papel = 'franqueado') {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: userId, papel }
  })
  app.decorate('requirePapel', (roles) => async (request, reply) => {
    if (!roles.includes(request.user.papel)) return reply.code(403).send({ error: 'Acesso negado' })
  })
  app.decorate('withTenant', async (_tenant, fn) => fn({ query }))
  app.decorate('audit', { log: vi.fn(async () => {}) })
  return app
}

const tituloArmazenado = (extra = {}) => ({
  id: tituloId, tenant_id: tenantId, marca_id: marcaId, cliente_id: clienteId, competencia: '2026-08-01',
  componente: 'fixo', valor_previsto: '1600', valor_pago: '0', data_vencimento: '2026-09-30', data_pagamento: null,
  observacao: null, perdido_em: null, perdido_motivo: null, perdido_por: null, ...extra,
})

describe('PATCH /v1/financeiro/receitas/:id/perder | /desperder', () => {
  it('perde título materializado, é idempotente e desfaz; audita cada ação', async () => {
    const db = titulosDb({ titulos: [tituloArmazenado()] })
    const app = buildReceitasApp(db.query)
    await app.register(financeiroReceitasRoutes)
    const url = `/v1/financeiro/receitas/${tituloId}`

    const r1 = await app.inject({ method: 'PATCH', url: `${url}/perder`, payload: { motivo: ' Cliente fechou ' } })
    expect(r1.statusCode).toBe(200)
    expect(r1.json()).toMatchObject({
      id: tituloId, status: 'perdido', perdido_motivo: 'Cliente fechou', perdido_por: userId,
      perdido_em: '2026-09-15T13:00:00.000Z', valor_previsto: 1600, valor_pago: 0,
    })

    // idempotente: segunda chamada sem motivo mantém data/autor/motivo
    const r2 = await app.inject({ method: 'PATCH', url: `${url}/perder` })
    expect(r2.statusCode).toBe(200)
    expect(r2.json()).toMatchObject({ status: 'perdido', perdido_motivo: 'Cliente fechou', perdido_em: '2026-09-15T13:00:00.000Z' })

    const audit = app.audit.log.mock.calls.map(([, e]) => e)
    expect(audit[0]).toMatchObject({ action: 'receita_titulo.perder', entity_type: 'receita_titulo', entity_id: tituloId, metadata: { motivo: 'Cliente fechou', ja_perdido: false } })
    expect(audit[1]).toMatchObject({ action: 'receita_titulo.perder', metadata: { ja_perdido: true } })

    const d1 = await app.inject({ method: 'PATCH', url: `${url}/desperder` })
    expect(d1.statusCode).toBe(200)
    expect(d1.json()).toMatchObject({ status: 'atrasado', perdido_em: null, perdido_motivo: null, perdido_por: null })
    const d2 = await app.inject({ method: 'PATCH', url: `${url}/desperder` })
    expect(d2.statusCode).toBe(200)
    expect(app.audit.log.mock.calls.slice(2).map(([, e]) => [e.action, e.metadata.estava_perdido]))
      .toEqual([['receita_titulo.desperder', true], ['receita_titulo.desperder', false]])
    await app.close()
  })

  it('id virtual calc: materializa e marca perdido; desperder por calc: resolve a linha', async () => {
    const db = titulosDb()
    const app = buildReceitasApp(db.query)
    await app.register(financeiroReceitasRoutes)
    const vid = `calc:${marcaId}:2026-08:comissao`
    const r = await app.inject({ method: 'PATCH', url: `/v1/financeiro/receitas/${vid}/perder`, payload: { motivo: 'sem acordo' } })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ status: 'perdido', materializado: true, componente: 'comissao', valor_previsto: 250, perdido_motivo: 'sem acordo' })
    expect(r.json().id).not.toBe(vid)
    expect(db.rows.size).toBe(1)
    expect(db.sqls).toContain('BEGIN')
    expect(db.sqls).toContain('COMMIT')

    const d = await app.inject({ method: 'PATCH', url: `/v1/financeiro/receitas/${vid}/desperder` })
    expect(d.statusCode).toBe(200)
    expect(d.json()).toMatchObject({ id: r.json().id, perdido_em: null })

    // calc: nunca materializado → desperder devolve o título como está (sem criar linha)
    const db2 = titulosDb()
    const app2 = buildReceitasApp(db2.query)
    await app2.register(financeiroReceitasRoutes)
    const d2 = await app2.inject({ method: 'PATCH', url: `/v1/financeiro/receitas/calc:${marcaId}:2026-08:fixo/desperder` })
    expect(d2.statusCode).toBe(200)
    expect(d2.json()).toMatchObject({ id: `calc:${marcaId}:2026-08:fixo`, materializado: false })
    expect(db2.rows.size).toBe(0)
    await app.close()
    await app2.close()
  })

  it('perda parcial preserva valor_pago; título 100% pago → 409; motivo > 300 → 400; papel leitor → 403', async () => {
    const db = titulosDb({
      titulos: [tituloArmazenado({ valor_pago: '600', data_pagamento: '2026-09-02' })],
    })
    const app = buildReceitasApp(db.query)
    await app.register(financeiroReceitasRoutes)
    const url = `/v1/financeiro/receitas/${tituloId}/perder`
    const parcial = await app.inject({ method: 'PATCH', url, payload: { motivo: 'Saldo não será pago' } })
    expect(parcial.json()).toMatchObject({ status: 'perdido', valor_pago: 600, valor_previsto: 1600, data_pagamento: '2026-09-02' })
    expect(db.rows.get(tituloId).valor_pago).toBe('600')

    db.rows.get(tituloId).valor_pago = '1600'
    db.rows.get(tituloId).perdido_em = null
    const pago = await app.inject({ method: 'PATCH', url })
    expect(pago.statusCode).toBe(409)
    expect(pago.json()).toMatchObject({ code: 'RECEITA_PAGA' })
    expect(db.sqls).toContain('ROLLBACK')

    expect((await app.inject({ method: 'PATCH', url, payload: { motivo: 'x'.repeat(301) } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url, payload: { status: 'perdido' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: '/v1/financeiro/receitas/abc/perder' })).statusCode).toBe(404)
    await app.close()

    const leitor = buildReceitasApp(db.query, 'financeiro_readonly')
    await leitor.register(financeiroReceitasRoutes)
    expect((await leitor.inject({ method: 'PATCH', url })).statusCode).toBe(403)
    expect((await leitor.inject({ method: 'PATCH', url: `/v1/financeiro/receitas/${tituloId}/desperder` })).statusCode).toBe(403)
    await leitor.close()
  })

  it('exige motivo para perda nova via API e serviço; reverte título virtual inválido', async () => {
    const db = titulosDb({ titulos: [tituloArmazenado()] })
    const app = buildReceitasApp(db.query)
    await app.register(financeiroReceitasRoutes)
    const url = `/v1/financeiro/receitas/${tituloId}/perder`
    for (const payload of [undefined, { motivo: null }, { motivo: '' }, { motivo: '   ' }]) {
      const res = await app.inject({ method: 'PATCH', url, ...(payload === undefined ? {} : { payload }) })
      expect(res.statusCode).toBe(400)
      expect(db.rows.get(tituloId).perdido_em).toBeNull()
    }
    for (const motivo of [undefined, null, '   ', 123]) {
      await expect(perderTitulo({ query: db.query }, { tenantId, id: tituloId, motivo, hoje: HOJE }))
        .rejects.toMatchObject({ statusCode: 400, code: 'INVALID_MOTIVO' })
    }
    expect(db.sqls.filter((sql) => sql.includes('perdido_em = COALESCE(perdido_em, NOW())'))).toHaveLength(0)
    expect(db.sqls.filter((sql) => sql === 'ROLLBACK')).toHaveLength(8)

    const virtual = titulosDb()
    await expect(perderTitulo({ query: virtual.query }, {
      tenantId, id: `calc:${marcaId}:2026-08:fixo`, motivo: ' ', hoje: HOJE,
    })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_MOTIVO' })
    // O fake não desfaz INSERT no ROLLBACK; a transação real desfaz a materialização.
    expect(virtual.sqls).toContain('ROLLBACK')
    expect(virtual.sqls).not.toContain('COMMIT')
    await app.close()
  })

  it('receber título perdido → 409 e não grava baixa; após desperder, recebe', async () => {
    const db = titulosDb({ titulos: [tituloArmazenado({ perdido_em: new Date('2026-09-10T00:00:00Z'), perdido_motivo: 'x' })] })
    const app = buildReceitasApp(db.query)
    await app.register(financeiroReceitasRoutes)
    const res = await app.inject({ method: 'PATCH', url: `/v1/financeiro/receitas/${tituloId}/receber`, payload: {} })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'RECEITA_PERDIDA', error: expect.stringContaining('Desfaça a perda/cancelamento antes') })
    expect(db.rows.get(tituloId).valor_pago).toBe('0')
    await app.inject({ method: 'PATCH', url: `/v1/financeiro/receitas/${tituloId}/desperder` })
    const ok = await app.inject({ method: 'PATCH', url: `/v1/financeiro/receitas/${tituloId}/receber`, payload: { data_pagamento: '2026-09-15' } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ status: 'pago', valor_pago: 1600 })
    await app.close()
  })

  it('receber por calc: de título já perdido → 409 (não reabre)', async () => {
    const db = titulosDb({ titulos: [tituloArmazenado({ perdido_em: new Date('2026-09-10T00:00:00Z') })] })
    const app = buildReceitasApp(db.query)
    await app.register(financeiroReceitasRoutes)
    const res = await app.inject({ method: 'PATCH', url: `/v1/financeiro/receitas/calc:${marcaId}:2026-08:fixo/receber`, payload: {} })
    expect(res.statusCode).toBe(409)
    await app.close()
  })
})

describe('gerarTitulosReceita preserva perdido', () => {
  it('não atualiza valor/vencimento nem apaga título perdido; conta perdidos_preservados', async () => {
    const db = titulosDb({
      titulos: [tituloArmazenado({ valor_previsto: '1000', data_vencimento: '2026-09-05', perdido_em: new Date('2026-09-01T00:00:00Z') })],
    })
    const res = await gerarTitulosReceita({ query: db.query }, { tenantId, mes: '2026-08', hoje: HOJE })
    expect(res).toMatchObject({ criados: 1, atualizados: 0, perdidos_preservados: 1 })
    expect(db.rows.get(tituloId)).toMatchObject({ valor_previsto: '1000', data_vencimento: '2026-09-05' })
    expect(res.itens.find((i) => i.id === tituloId)).toMatchObject({ status: 'perdido', valor_previsto: 1000 })
  })
})

// ─── receitas avulsas ─────────────────────────────────────────────────────

function avulsasDb(row) {
  const state = { row: row ? { ...row } : null }
  const query = vi.fn(async (sql, params = []) => {
    const text = String(sql)
    const r = state.row
    if (/^\s*SELECT/.test(text) && text.includes('FROM receitas_avulsas')) {
      expect(params[1]).toBe(tenantId)
      return { rows: r && r.id === params[0] ? [{ ...r }] : [] }
    }
    if (text.includes('UPDATE receitas_avulsas')) {
      expect(params[1]).toBe(tenantId)
      if (!r || r.id !== params[0]) return { rows: [] }
      if (text.includes('perdido_em = COALESCE(perdido_em, NOW())')) {
        if (Number(r.valor_pago) > 0 && Number(r.valor_pago) >= Number(r.valor_previsto)) return { rows: [] }
        if (!r.perdido_em) { r.perdido_em = new Date('2026-09-15T13:00:00.000Z'); r.perdido_por = params[2]; r.perdido_motivo = params[3] }
        else if (params[3] != null) r.perdido_motivo = params[3]
      } else if (text.includes('perdido_em = NULL')) {
        r.perdido_em = null; r.perdido_motivo = null; r.perdido_por = null
      } else if (text.includes('COALESCE($3::numeric, valor_previsto)')) {
        expect(text).toContain('perdido_em IS NULL')
        if (r.perdido_em) return { rows: [] }
        r.valor_pago = String(params[2] ?? r.valor_previsto); r.data_pagamento = params[3] ?? params[4]
      }
      return { rows: [{ ...r }] }
    }
    return { rows: [] }
  })
  return { query, state }
}

function buildApp(query, papel = 'franqueado') {
  const app = Fastify()
  app.decorate('requirePapel', (roles) => async (request, reply) => {
    request.user = { tenant_id: tenantId, sub: userId, papel }
    if (!roles.includes(papel)) return reply.code(403).send({ error: 'Acesso negado' })
  })
  app.decorate('withTenant', async (_t, fn) => fn({ query }))
  app.decorate('audit', { log: vi.fn(async () => {}) })
  return app
}

const avulsaRow = (extra = {}) => ({
  id: avulsaId, descricao: 'Consultoria', grupo: 'servico', valor_previsto: '500.00', valor_pago: '0.00',
  observacao: null, data_vencimento: '2026-09-10', data_pagamento: null, competencia: '2026-09-01',
  perdido_em: null, perdido_motivo: null, perdido_por: null, ...extra,
})

describe('PATCH /v1/financeiro/receitas-avulsas/:id/perder | /desperder', () => {
  it('perde (idempotente), bloqueia receber com 409, desfaz e recebe', async () => {
    const db = avulsasDb(avulsaRow())
    const app = buildApp(db.query)
    await app.register(financeiroReceitasAvulsasRoutes)
    const base = `/v1/financeiro/receitas-avulsas/${avulsaId}`
    const p1 = await app.inject({ method: 'PATCH', url: `${base}/perder`, payload: { motivo: 'cliente sumiu' } })
    expect(p1.statusCode).toBe(200)
    expect(p1.json()).toMatchObject({ status: 'perdido', perdido_motivo: 'cliente sumiu', perdido_por: userId, origem: 'avulsa' })
    const p2 = await app.inject({ method: 'PATCH', url: `${base}/perder`, payload: { motivo: 'novo motivo' } })
    expect(p2.json()).toMatchObject({ status: 'perdido', perdido_motivo: 'novo motivo', perdido_em: '2026-09-15T13:00:00.000Z' })

    const rec = await app.inject({ method: 'PATCH', url: `${base}/receber`, payload: {} })
    expect(rec.statusCode).toBe(409)
    expect(rec.json()).toMatchObject({ code: 'RECEITA_PERDIDA' })
    expect(db.state.row.valor_pago).toBe('0.00')

    const d = await app.inject({ method: 'PATCH', url: `${base}/desperder` })
    expect(d.statusCode).toBe(200)
    expect(d.json()).toMatchObject({ status: 'atrasado', perdido_em: null })
    const ok = await app.inject({ method: 'PATCH', url: `${base}/receber`, payload: {} })
    expect(ok.json()).toMatchObject({ status: 'pago', valor_pago: 500 })

    const acoes = app.audit.log.mock.calls.map(([, e]) => e.action)
    expect(acoes).toEqual(['receita_avulsa.perder', 'receita_avulsa.perder', 'receita_avulsa.desperder', 'receita_avulsa.receber'])
    await app.close()
  })

  it('perda parcial preserva valor_pago; 100% recebida → 409; 404/400; leitor → 403', async () => {
    const db = avulsasDb(avulsaRow({ valor_pago: '200.00', data_pagamento: '2026-09-05' }))
    const app = buildApp(db.query)
    await app.register(financeiroReceitasAvulsasRoutes)
    const base = `/v1/financeiro/receitas-avulsas/${avulsaId}`
    const p = await app.inject({ method: 'PATCH', url: `${base}/perder`, payload: { motivo: 'Saldo não será pago' } })
    expect(p.json()).toMatchObject({ status: 'perdido', valor_pago: 200, valor_previsto: 500 })

    db.state.row.perdido_em = null
    db.state.row.valor_pago = '500.00'
    const pago = await app.inject({ method: 'PATCH', url: `${base}/perder` })
    expect(pago.statusCode).toBe(409)
    expect(pago.json()).toMatchObject({ code: 'RECEITA_PAGA' })

    const outro = '00000000-0000-4000-8000-0000000000b9'
    expect((await app.inject({ method: 'PATCH', url: `/v1/financeiro/receitas-avulsas/${outro}/perder` })).statusCode).toBe(404)
    expect((await app.inject({ method: 'PATCH', url: `/v1/financeiro/receitas-avulsas/${outro}/desperder` })).statusCode).toBe(404)
    expect((await app.inject({ method: 'PATCH', url: '/v1/financeiro/receitas-avulsas/xyz/perder' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: `${base}/perder`, payload: { motivo: 'x'.repeat(301) } })).statusCode).toBe(400)
    await app.close()

    const leitor = buildApp(db.query, 'financeiro_readonly')
    await leitor.register(financeiroReceitasAvulsasRoutes)
    expect((await leitor.inject({ method: 'PATCH', url: `${base}/perder` })).statusCode).toBe(403)
    await leitor.close()
  })

  it('exige motivo para perda avulsa nova via API e serviço; retry sem motivo preserva o antigo', async () => {
    const db = avulsasDb(avulsaRow())
    const app = buildApp(db.query)
    await app.register(financeiroReceitasAvulsasRoutes)
    const url = `/v1/financeiro/receitas-avulsas/${avulsaId}/perder`
    for (const payload of [undefined, { motivo: null }, { motivo: '' }, { motivo: '   ' }]) {
      const res = await app.inject({ method: 'PATCH', url, ...(payload === undefined ? {} : { payload }) })
      expect(res.statusCode).toBe(400)
      expect(db.state.row.perdido_em).toBeNull()
    }
    for (const motivo of [undefined, null, '   ', 123]) {
      await expect(perderReceitaAvulsa({ query: db.query }, { tenantId, id: avulsaId, motivo, hoje: HOJE }))
        .rejects.toMatchObject({ statusCode: 400, code: 'INVALID_MOTIVO' })
    }
    const first = await app.inject({ method: 'PATCH', url, payload: { motivo: '  ' + 'x'.repeat(300) + '  ' } })
    expect(first.statusCode).toBe(200)
    expect(db.state.row.perdido_motivo).toBe('x'.repeat(300))
    const retry = await app.inject({ method: 'PATCH', url })
    expect(retry.statusCode).toBe(200)
    expect(retry.json().perdido_motivo).toBe('x'.repeat(300))
    await app.close()
  })
})

// ─── custos ───────────────────────────────────────────────────────────────

const recorrente = {
  id: recId, nome: 'Aluguel', descricao: null, grupo: 'estrutural', valor: '3000.00',
  dia_vencimento: 10, mes_offset: 0, inicio: '2026-01-01', fim: null, ativo: true, classe_custo: null,
}

function custosDb(custos = []) {
  const rows = new Map(custos.map((c) => [c.id, { ...c }]))
  const query = vi.fn(async (sql, params = []) => {
    const text = String(sql)
    if (text.includes('FROM custos_recorrentes')) return { rows: [recorrente] }
    if (/^\s*INSERT INTO custos/.test(text)) {
      expect(params[0]).toBe(tenantId)
      const ja = [...rows.values()].some((r) => r.recorrente_id === params[6] && r.competencia === params[4])
      if (ja) return { rows: [], rowCount: 0 }
      rows.set(matRecId, {
        id: matRecId, descricao: params[1], valor: String(params[2]), tipo: 'recorrente', grupo: params[3],
        competencia: params[4], data_vencimento: params[5], valor_pago: null, data_pagamento: null,
        recorrente_id: params[6], parcela_grupo_id: null, cancelado_em: null, cancelado_motivo: null, cancelado_por: null,
      })
      return { rows: [{ id: matRecId }], rowCount: 1 }
    }
    if (/SELECT id FROM custos WHERE tenant_id = \$1::uuid AND recorrente_id/.test(text)) {
      const r = [...rows.values()].find((x) => x.recorrente_id === params[1] && x.competencia === params[2])
      return { rows: r ? [{ id: r.id }] : [] }
    }
    if (/recorrente_id, to_char\(competencia/.test(text)) {
      return { rows: [...rows.values()].filter((r) => r.recorrente_id && r.competencia === params[1]) }
    }
    if (/FROM custos\s+WHERE tenant_id = \$1::uuid\s+AND competencia >=/.test(text)) return { rows: [...rows.values()] }
    if (/^\s*SELECT/.test(text) && text.includes('FROM custos WHERE id = $1::uuid AND tenant_id = $2::uuid')) {
      expect(params[1]).toBe(tenantId)
      const r = rows.get(params[0])
      return { rows: r ? [{ ...r }] : [] }
    }
    if (text.includes('UPDATE custos')) {
      expect(params[1]).toBe(tenantId)
      const r = rows.get(params[0])
      if (!r) return { rows: [] }
      if (text.includes('cancelado_em = COALESCE(cancelado_em, NOW())')) {
        if (!r.cancelado_em) { r.cancelado_em = new Date('2026-09-15T13:00:00.000Z'); r.cancelado_por = params[2]; r.cancelado_motivo = params[3] }
        else if (params[3] != null) r.cancelado_motivo = params[3]
      } else if (text.includes('cancelado_em = NULL')) {
        r.cancelado_em = null; r.cancelado_motivo = null; r.cancelado_por = null
      } else if (text.includes('COALESCE($3::numeric, valor)')) {
        expect(text).toContain('cancelado_em IS NULL')
        if (r.cancelado_em) return { rows: [] }
        r.valor_pago = String(params[2] ?? r.valor); r.data_pagamento = params[3] ?? params[4]
      }
      return { rows: [{ ...r }] }
    }
    return { rows: [] }
  })
  return { query, rows }
}

const custoRow = (extra = {}) => ({
  id: custoId, descricao: 'Software X', valor: '200.00', tipo: 'outros', grupo: 'ferramentas',
  competencia: '2026-09-01', data_vencimento: '2026-09-20', valor_pago: null, data_pagamento: null,
  parcela_grupo_id: null, parcela_num: null, parcelas_total: null, recorrente_id: null, observacao: null,
  classe_custo: null, cancelado_em: null, cancelado_motivo: null, cancelado_por: null, ...extra,
})

describe('PATCH /v1/financeiro/custos/:id/cancelar | /reativar', () => {
  it('cancela (idempotente), pagar → 409, reativa e paga; audita', async () => {
    const db = custosDb([custoRow()])
    const app = buildApp(db.query)
    await app.register(financeiroCustosRoutes)
    const base = `/v1/financeiro/custos/${custoId}`
    const c1 = await app.inject({ method: 'PATCH', url: `${base}/cancelar`, payload: { motivo: 'duplicado' } })
    expect(c1.statusCode).toBe(200)
    expect(c1.json()).toMatchObject({
      id: custoId, status: 'cancelado', cancelado_motivo: 'duplicado', cancelado_por: userId,
      cancelado_em: '2026-09-15T13:00:00.000Z', valor_previsto: 200,
    })
    const c2 = await app.inject({ method: 'PATCH', url: `${base}/cancelar` })
    expect(c2.json()).toMatchObject({ status: 'cancelado', cancelado_motivo: 'duplicado' })

    const pagar = await app.inject({ method: 'PATCH', url: `${base}/pagar`, payload: {} })
    expect(pagar.statusCode).toBe(409)
    expect(pagar.json()).toMatchObject({ code: 'CUSTO_CANCELADO', error: expect.stringContaining('Desfaça a perda/cancelamento antes') })

    const r = await app.inject({ method: 'PATCH', url: `${base}/reativar` })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ cancelado_em: null, cancelado_motivo: null })
    expect(['pendente', 'atrasado']).toContain(r.json().status)
    const ok = await app.inject({ method: 'PATCH', url: `${base}/pagar`, payload: { data_pagamento: '2026-09-15' } })
    expect(ok.json()).toMatchObject({ status: 'pago', valor_pago: 200 })

    const audit = app.audit.log.mock.calls.map(([, e]) => [e.action, e.entity_id])
    expect(audit).toEqual([
      ['financeiro.custo_cancelar', custoId], ['financeiro.custo_cancelar', custoId],
      ['financeiro.custo_reativar', custoId], ['financeiro.custo_pagar', custoId],
    ])
    expect(app.audit.log.mock.calls[0][1].metadata).toMatchObject({ motivo: 'duplicado', ja_cancelado: false })
    await app.close()
  })

  it('rec:<uuid>:<mês> materializa só aquele mês e cancela; gerar não recria; listagem sem virtual', async () => {
    const db = custosDb()
    const app = buildApp(db.query)
    await app.register(financeiroCustosRoutes)
    const vid = idVirtualCusto(recId, '2026-09')
    const c = await app.inject({ method: 'PATCH', url: `/v1/financeiro/custos/${vid}/cancelar`, payload: { motivo: 'renegociado' } })
    expect(c.statusCode).toBe(200)
    expect(c.json()).toMatchObject({ id: matRecId, origem: 'recorrente', status: 'cancelado', competencia: '2026-09-01', virtual: false })
    expect(db.rows.size).toBe(1)

    const g = await gerarCustosDoMes({ query: db.query }, { tenantId, mes: '2026-09' })
    expect(g.criados).toBe(0)
    expect(db.rows.size).toBe(1)

    const itens = await listarCustos({ query: db.query }, { tenantId, inicio: '2026-09', fim: '2026-10', hoje: HOJE })
    expect(itens.map((i) => [i.id, i.status])).toEqual([[matRecId, 'cancelado'], [idVirtualCusto(recId, '2026-10'), 'previsto']])

    // reativar por rec: usa a linha existente; rec: nunca gerado volta virtual (sem materializar)
    const r = await app.inject({ method: 'PATCH', url: `/v1/financeiro/custos/${vid}/reativar` })
    expect(r.json()).toMatchObject({ id: matRecId, cancelado_em: null })
    expect(['pendente', 'atrasado']).toContain(r.json().status)
    const rv = await app.inject({ method: 'PATCH', url: `/v1/financeiro/custos/${idVirtualCusto(recId, '2026-10')}/reativar` })
    expect(rv.statusCode).toBe(200)
    expect(rv.json()).toMatchObject({ id: idVirtualCusto(recId, '2026-10'), virtual: true })
    expect(db.rows.size).toBe(1)
    await app.close()
  })

  it('pagamento parcial preservado; 100% pago → 409; 404; motivo > 300 → 400; leitor → 403', async () => {
    const db = custosDb([custoRow({ valor_pago: '50.00', data_pagamento: '2026-09-05' })])
    const app = buildApp(db.query)
    await app.register(financeiroCustosRoutes)
    const base = `/v1/financeiro/custos/${custoId}`
    const c = await app.inject({ method: 'PATCH', url: `${base}/cancelar` })
    expect(c.json()).toMatchObject({ status: 'cancelado', valor_pago: 50 })

    db.rows.get(custoId).cancelado_em = null
    db.rows.get(custoId).valor_pago = '200.00'
    const pago = await app.inject({ method: 'PATCH', url: `${base}/cancelar` })
    expect(pago.statusCode).toBe(409)
    expect(pago.json()).toMatchObject({ code: 'CUSTO_PAGO' })

    const outro = '00000000-0000-4000-8000-0000000000c9'
    expect((await app.inject({ method: 'PATCH', url: `/v1/financeiro/custos/${outro}/cancelar` })).statusCode).toBe(404)
    expect((await app.inject({ method: 'PATCH', url: `/v1/financeiro/custos/${outro}/reativar` })).statusCode).toBe(404)
    expect((await app.inject({ method: 'PATCH', url: '/v1/financeiro/custos/xyz/cancelar' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'PATCH', url: `${base}/cancelar`, payload: { motivo: 'x'.repeat(301) } })).statusCode).toBe(400)
    await app.close()

    const leitor = buildApp(db.query, 'financeiro_readonly')
    await leitor.register(financeiroCustosRoutes)
    expect((await leitor.inject({ method: 'PATCH', url: `${base}/cancelar` })).statusCode).toBe(403)
    expect((await leitor.inject({ method: 'PATCH', url: `${base}/reativar` })).statusCode).toBe(403)
    await leitor.close()
  })
})
