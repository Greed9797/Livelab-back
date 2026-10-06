import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// O fluxo de eventos possui sua própria cobertura SQL em
// financeiro_liquidacoes_apresentadoras.pglite.mjs. Aqui isolamos as regras
// de pagamento, rota e cancelamento, fazendo o comando aplicar a projeção.
const comando = vi.hoisted(() => ({
  registrarLiquidacao: vi.fn(),
  registrarEstorno: vi.fn(),
}))
vi.mock('../src/services/financeiro-liquidacoes-command.js', () => ({
  registrarLiquidacao: comando.registrarLiquidacao.mockImplementation(async (db, args) => {
    await args.aplicarProjecao(db, { valor: args.valor })
    return { id: 'liq', ...args }
  }),
  registrarEstorno: comando.registrarEstorno.mockImplementation(async (db, args) => {
    await args.aplicarProjecao(db, {
      valor: args.valor,
      natureza: 'custo', origemTipo: 'apresentadora_pagamento', origemId: 'x',
    })
    return { id: 'est', ...args }
  }),
}))

beforeEach(() => {
  comando.registrarLiquidacao.mockClear()
  comando.registrarEstorno.mockClear()
})

import { financeiroApresentadorasPagamentosRoutes } from '../src/routes/financeiro_apresentadoras_pagamentos.js'
import {
  buscarConfigVencimento, cancelarPagamentoApresentadora, desfazerPagamentoApresentadora, listarPagamentosApresentadoras, mesesDoPeriodo,
  reativarPagamentoApresentadora, registrarPagamentoApresentadora, vencimentoApresentadora,
} from '../src/services/apresentadoras-pagamentos.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const apId = '22222222-2222-4222-8222-222222222222'

const CFG = { fixo_dia: 10, fixo_offset: 0, variavel_dia: 15, variavel_offset: 1 }

// Roteia as queries do serviço por trecho de SQL.
function fakeDb({ pagos = [], config = CFG, fixo = '2700.00', comissao = '160.00', adicionais = [] } = {}) {
  const calls = []
  const pagamentosAtuais = [...pagos]
  const query = vi.fn(async (sql, params) => {
    calls.push({ sql: String(sql), params })
    const s = String(sql)
    if (s.includes('UPDATE apresentadora_pagamentos SET valor_pago = valor_pago +')) {
      pagamentosAtuais.splice(0, pagamentosAtuais.length, {
        id: 'x', apresentadora_id: apId, competencia: '2026-09-01', componente: 'fixo',
        valor_pago: params[2], data_pagamento: params[3], cancelado_em: null,
      })
      return { rows: [{ id: 'x' }] }
    }
    if (s.includes('UPDATE apresentadora_pagamentos SET valor_pago = valor_pago -')) return { rows: [{ id: 'x' }] }
    if (s.includes('FROM financeiro_liquidacoes l LEFT JOIN financeiro_estornos')) return { rows: [{ id: 'x', saldo: '10.00' }] }
    if (s.includes('FROM financeiro_estornos WHERE tenant_id')) return { rows: [] }
    if (s.includes('DELETE FROM apresentadora_pagamentos')) return { rowCount: 1, rows: [{ id: 'x' }] }
    if (s.includes('FROM tenants')) return { rows: [config] }
    if (s.includes('FROM apresentadora_pagamentos')) {
      if (s.startsWith('SELECT id, apresentadora_id')) return { rows: pagamentosAtuais }
      return { rows: pagos }
    }
    if (s.includes('apresentadora_remuneracao_adicionais')) return { rows: adicionais }
    if (s.includes('FROM vendas_atribuidas')) return { rows: [{ apresentadora_id: apId, nome: 'Ana', valor: comissao }] }
    if (s.includes('FROM apresentadoras a') && s.includes('prorate') === false && s.includes('a.ativo')) return { rows: [{ apresentadora_id: apId, nome: 'Ana', valor: fixo }] }
    if (s.includes('SELECT id FROM apresentadoras')) return { rows: [{ id: apId }] }
    if (s.includes('INSERT INTO apresentadora_pagamentos')) return { rows: [{ apresentadora_id: apId, componente: params[3], valor_pago: params[4] }] }
    if (s.startsWith('UPDATE tenants')) return { rows: [] }
    return { rows: [] }
  })
  return { query, calls }
}

describe('vencimento', () => {
  it('usa o dia configurado no mês seguinte e vira o ano', () => {
    expect(vencimentoApresentadora('2026-09', 10, 1)).toBe('2026-10-10')
    expect(vencimentoApresentadora('2026-12', 10, 1)).toBe('2027-01-10')
    expect(vencimentoApresentadora('2026-09', 5, 0)).toBe('2026-09-05')
  })
  it('dia maior que o fim do mês cai no último dia', () => {
    expect(vencimentoApresentadora('2026-01', 31, 1)).toBe('2026-02-28')
    expect(vencimentoApresentadora('2027-12', 31, 2 - 1)).toBe('2028-01-31')
    expect(vencimentoApresentadora('2027-01', 30, 1)).toBe('2027-02-28')
    expect(vencimentoApresentadora('2028-01', 30, 1)).toBe('2028-02-29')
  })
  it('lista meses do período', () => {
    expect(mesesDoPeriodo('2026-11-15', '2027-01-02')).toEqual(['2026-11', '2026-12', '2027-01'])
  })
})

describe('listarPagamentosApresentadoras', () => {
  const base = { tenantId, inicio: '2026-09-01', fim: '2026-09-30' }
  const pg = (componente, valor, data = '2026-10-05') => ({ apresentadora_id: apId, competencia: '2026-09-01', componente, valor_pago: valor, data_pagamento: data })
  const por = (itens, c) => itens.find((i) => i.componente === c)

  it('devolve DOIS itens por pessoa/mês: fixo e variável (comissão + adicionais)', async () => {
    const db = fakeDb({ adicionais: [{ id: 'e1', apresentadora_id: apId, nome: 'Ana', tipo: 'bonus', descricao: 'b', data_referencia: '2026-09-10', valor: '40.00' }] })
    const itens = await listarPagamentosApresentadoras(db, { ...base, hoje: '2026-09-05' })
    expect(itens).toHaveLength(2)
    expect(por(itens, 'fixo')).toMatchObject({
      id: `apresentadora:${apId}:2026-09:fixo`, natureza: 'custo', origem: 'apresentadora', componente: 'fixo',
      competencia: '2026-09-01', data_vencimento: '2026-09-10', valor_previsto: 2700, valor_pago: 0,
      data_pagamento: null, status: 'pendente', fixo: 2700, comissao: 160, adicionais: 40,
    })
    expect(por(itens, 'variavel')).toMatchObject({
      id: `apresentadora:${apId}:2026-09:variavel`, origem: 'apresentadora', componente: 'variavel',
      data_vencimento: '2026-10-15', valor_previsto: 200, status: 'previsto', fixo: 2700, comissao: 160, adicionais: 40,
    })
  })

  it('omite componente sem valor e sem baixa', async () => {
    const itens = await listarPagamentosApresentadoras(fakeDb({ comissao: '0.00' }), { ...base, hoje: '2026-09-05' })
    expect(itens.map((i) => i.componente)).toEqual(['fixo'])
    const soVar = await listarPagamentosApresentadoras(fakeDb({ fixo: '0.00' }), { ...base, hoje: '2026-09-05' })
    expect(soVar.map((i) => i.componente)).toEqual(['variavel'])
  })

  it('deriva status por componente, com baixa independente', async () => {
    const atrasado = await listarPagamentosApresentadoras(fakeDb(), { ...base, hoje: '2026-10-11' })
    expect(por(atrasado, 'fixo').status).toBe('atrasado')
    expect(por(atrasado, 'variavel').status).toBe('pendente')
    const tarde = await listarPagamentosApresentadoras(fakeDb(), { ...base, hoje: '2026-10-16' })
    expect(por(tarde, 'variavel').status).toBe('atrasado')

    const itens = await listarPagamentosApresentadoras(
      fakeDb({ pagos: [pg('fixo', '2700.00', '2026-09-09'), pg('variavel', '50.00')] }), { ...base, hoje: '2026-10-06' })
    expect(por(itens, 'fixo')).toMatchObject({ status: 'pago', valor_pago: 2700, data_pagamento: '2026-09-09' })
    expect(por(itens, 'variavel')).toMatchObject({ status: 'parcial', valor_pago: 50, data_pagamento: '2026-10-05' })
  })

  it('baixa legada (pré-172, total no fixo) fica como fixo e é sinalizada como divergente', async () => {
    const itens = await listarPagamentosApresentadoras(fakeDb({ pagos: [pg('fixo', '2860.00')] }), { ...base, hoje: '2026-10-20' })
    expect(por(itens, 'fixo')).toMatchObject({ status: 'pago', valor_pago: 2860, divergente: true })
    expect(por(itens, 'variavel')).toMatchObject({ valor_pago: 0, divergente: false })
  })

  it('apresentadora fora do fechamento com baixa mantém só o componente baixado', async () => {
    const outra = '33333333-3333-4333-8333-333333333333'
    const db = fakeDb({ pagos: [{ apresentadora_id: outra, competencia: '2026-09-01', componente: 'variavel', valor_pago: '10.00', data_pagamento: '2026-10-01' }] })
    const itens = (await listarPagamentosApresentadoras(db, { ...base, hoje: '2026-10-06' })).filter((i) => i.apresentadora_id === outra)
    expect(itens.map((i) => i.componente)).toEqual(['variavel'])
  })

  it('respeita config do tenant por componente (e virada de ano)', async () => {
    const db = fakeDb({ config: { fixo_dia: 31, fixo_offset: 1, variavel_dia: 5, variavel_offset: 0 } })
    const itens = await listarPagamentosApresentadoras(db, { tenantId, inicio: '2026-12-01', fim: '2026-12-31', hoje: '2026-09-30' })
    expect(por(itens, 'fixo')).toMatchObject({ status: 'previsto', data_vencimento: '2027-01-31' })
    expect(por(itens, 'variavel').data_vencimento).toBe('2026-12-05')
  })

  it('config ausente cai nos defaults (fixo 10/0, variável 15/1)', async () => {
    const cfg = await buscarConfigVencimento(fakeDb({ config: {} }), tenantId)
    expect(cfg).toEqual({ fixo: { dia: 10, mes_offset: 0 }, variavel: { dia: 15, mes_offset: 1 } })
  })

  it('passa tenant_id explícito em todas as queries', async () => {
    const db = fakeDb()
    await listarPagamentosApresentadoras(db, { ...base, hoje: '2026-09-30' })
    for (const c of db.calls) expect(c.params[0]).toBe(tenantId)
    for (const c of db.calls) expect(c.sql).toMatch(/tenant_id|id = \$1/)
  })
})

describe('registrar/desfazer por componente', () => {
  it('default = previsto do componente (variável = comissão + adicionais)', async () => {
    await registrarPagamentoApresentadora(fakeDb(), { tenantId, apresentadoraId: apId, mes: '2026-09', componente: 'variavel' })
    await registrarPagamentoApresentadora(fakeDb(), { tenantId, apresentadoraId: apId, mes: '2026-09', componente: 'fixo' })
    expect(comando.registrarLiquidacao.mock.calls.map(([, args]) => args.valor)).toEqual(['160.00', '2700.00'])
    expect(comando.registrarLiquidacao).toHaveBeenCalledTimes(2)
  })
  it('componente inválido lança TypeError; desfazer filtra por componente', async () => {
    await expect(registrarPagamentoApresentadora(fakeDb(), { tenantId, apresentadoraId: apId, mes: '2026-09', componente: 'x' })).rejects.toThrow(TypeError)
    const db = fakeDb()
    await desfazerPagamentoApresentadora(db, { tenantId, apresentadoraId: apId, mes: '2026-09', componente: 'variavel' })
    expect(db.calls[0].params).toEqual([tenantId, apId, '2026-09-01', 'variavel'])
  })
})

describe('rotas', () => {
  function buildApp(db) {
    const app = Fastify()
    app.decorate('requirePapel', () => async (request) => {
      request.user = { tenant_id: tenantId, sub: '44444444-4444-4444-8444-444444444444', papel: 'financeiro' }
    })
    app.decorate('withTenant', async (t, fn) => { expect(t).toBe(tenantId); return fn(db) })
    app.register(financeiroApresentadorasPagamentosRoutes)
    return app
  }
  const B = `/v1/financeiro/apresentadoras-pagamentos/${apId}/2026-09`
  it('pagar fixo sem corpo paga o previsto do fixo', async () => {
    const db = fakeDb()
    const res = await buildApp(db).inject({ method: 'PATCH', url: `${B}/fixo/pagar`, payload: {} })
    expect(res.statusCode).toBe(200)
    expect(comando.registrarLiquidacao.mock.calls[0][1].valor).toBe('2700.00')
    expect(res.headers.deprecation).toBeUndefined()
  })

  it('pagar variável sem corpo paga comissão + adicionais; parcial grava o informado', async () => {
    const db = fakeDb()
    expect((await buildApp(db).inject({ method: 'PATCH', url: `${B}/variavel/pagar`, payload: {} })).statusCode).toBe(200)
    expect(comando.registrarLiquidacao.mock.calls[0][1].valor).toBe('160.00')
    const db2 = fakeDb()
    await buildApp(db2).inject({ method: 'PATCH', url: `${B}/variavel/pagar`, payload: { valor_pago: '100,50', data_pagamento: '2026-10-15' } })
    expect(comando.registrarLiquidacao.mock.calls[1][1]).toMatchObject({ valor: '100.50', data: '2026-10-15' })
  })

  it('rota legada (sem componente) = fixo com valor do FIXO (não o total) + header Deprecation', async () => {
    const db = fakeDb()
    const res = await buildApp(db).inject({ method: 'PATCH', url: `${B}/pagar`, payload: {} })
    expect(res.statusCode).toBe(200)
    expect(comando.registrarLiquidacao.mock.calls[0][1].valor).toBe('2700.00')
    expect(res.headers.deprecation).toBe('true')
  })

  it('rejeita valor inválido, mês inválido, componente inválido e data inexistente', async () => {
    const app = buildApp(fakeDb())
    expect((await app.inject({ method: 'PATCH', url: `${B}/fixo/pagar`, payload: { valor_pago: '-5' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: `${B}/fixo/pagar`, payload: { data_pagamento: '2026-02-31' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: `/v1/financeiro/apresentadoras-pagamentos/${apId}/2026-13/fixo/pagar`, payload: {} })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: `${B}/total/pagar`, payload: {} })).statusCode).toBe(400)
  })

  it('desfazer remove só o componente pedido (e a legada desfaz o fixo)', async () => {
    const db = fakeDb({ pagos: [{ id: 'x', apresentadora_id: apId, competencia: '2026-09-01', componente: 'fixo', valor_pago: '10.00', data_pagamento: '2026-09-05' }] })
    const app = buildApp(db)
    expect((await app.inject({ method: 'PATCH', url: `${B}/variavel/desfazer` })).statusCode).toBe(200)
    expect((await app.inject({ method: 'PATCH', url: `${B}/desfazer` })).statusCode).toBe(200)
    expect(comando.registrarEstorno).toHaveBeenCalledTimes(2)
  })

  it('GET/PATCH config devolvem {fixo, variavel}; valida limites; plano legado vai para o fixo', async () => {
    const db = fakeDb()
    const app = buildApp(db)
    const C = '/v1/financeiro/apresentadoras-pagamentos/config'
    const get = await app.inject({ method: 'GET', url: C })
    expect(get.json()).toEqual({ fixo: { dia: 10, mes_offset: 0 }, variavel: { dia: 15, mes_offset: 1 } })
    expect((await app.inject({ method: 'PATCH', url: C, payload: { variavel: { dia: 32 } } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: C, payload: { fixo: { mes_offset: 2 } } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: C, payload: {} })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: C, payload: { variavel: { dia: 20, mes_offset: 0 } } })).statusCode).toBe(200)
    const up = db.calls.filter((c) => c.sql.startsWith('UPDATE tenants'))
    expect(up[0].params).toEqual([tenantId, null, null, 20, 0])
    await app.inject({ method: 'PATCH', url: C, payload: { dia: 7 } })
    expect(up.length + 1).toBe(db.calls.filter((c) => c.sql.startsWith('UPDATE tenants')).length)
    expect(db.calls.filter((c) => c.sql.startsWith('UPDATE tenants')).at(-1).params).toEqual([tenantId, 7, null, null, null])
  })
})

describe('cancelamento (migration 177)', () => {
  const mes = '2026-09'
  const arg = { tenantId, apresentadoraId: apId, mes, componente: 'fixo' }
  const cancelado = { apresentadora_id: apId, competencia: '2026-09-01', componente: 'fixo', valor_pago: '0', data_pagamento: null, cancelado_em: '2026-09-20T10:00:00.000Z', cancelado_motivo: 'saiu' }
  // fakeDb + SELECT valor_pago/cancelado_em da linha única (as consultas pontuais não passam pela listagem em lote).
  function dbCancel({ linha = null, ...opts } = {}) {
    const base = fakeDb(opts)
    const query = vi.fn(async (sql, params) => {
      const s = String(sql)
      if (s.startsWith('SELECT valor_pago') || s.startsWith('SELECT cancelado_em') || s.startsWith('SELECT id, apresentadora_id')) { base.calls.push({ sql: s, params }); return { rows: linha ? [{ id: 'x', apresentadora_id: apId, competencia: `${mes}-01`, componente: 'fixo', valor_pago: linha.valor_pago ?? '0', data_pagamento: null, ...linha }] : [] } }
      return base.query(sql, params)
    })
    return { query, calls: base.calls }
  }

  it('lista item cancelado: status cancelado, cancelado_* no item, divergente false', async () => {
    const itens = await listarPagamentosApresentadoras(fakeDb({ pagos: [cancelado] }), { tenantId, inicio: '2026-09-01', fim: '2026-09-30', hoje: '2026-10-20' })
    expect(itens.find((i) => i.componente === 'fixo')).toMatchObject({
      status: 'cancelado', valor_pago: 0, data_pagamento: null, cancelado_em: '2026-09-20T10:00:00.000Z', cancelado_motivo: 'saiu', divergente: false,
    })
    expect(itens.find((i) => i.componente === 'variavel').cancelado_em).toBeNull()
  })

  it('cancelar componente virtual faz upsert com valor_pago 0, data NULL e motivo normalizado', async () => {
    const db = dbCancel()
    await cancelarPagamentoApresentadora(db, { ...arg, motivo: '  duplicado  ', actorUserId: 'u1' })
    const up = db.calls.find((c) => c.sql.includes('INSERT INTO apresentadora_pagamentos'))
    expect(up.sql).toContain('ON CONFLICT (tenant_id, apresentadora_id, competencia, componente)')
    expect(up.params).toEqual([tenantId, apId, '2026-09-01', 'fixo', 'duplicado', 'u1'])
    expect(up.sql).toMatch(/VALUES \(\$1::uuid, \$2::uuid, \$3::date, \$4::text, 0, NULL, NOW\(\)/)
  })

  it('cancelar parcial preserva a baixa; pago integral e previsto zero => 409 CANCELAMENTO_INVALIDO', async () => {
    const parcial = dbCancel({ linha: { valor_pago: '100.00' } })
    await cancelarPagamentoApresentadora(parcial, arg)
    expect(parcial.calls.find((c) => c.sql.includes('INSERT INTO apresentadora_pagamentos')).sql).not.toMatch(/valor_pago = EXCLUDED/)
    await expect(cancelarPagamentoApresentadora(dbCancel({ linha: { valor_pago: '2700.00' } }), arg))
      .rejects.toMatchObject({ code: 'CANCELAMENTO_INVALIDO', statusCode: 409 })
    await expect(cancelarPagamentoApresentadora(dbCancel({ fixo: '0.00' }), arg))
      .rejects.toMatchObject({ code: 'CANCELAMENTO_INVALIDO' })
  })

  it('cancelar rejeita motivo > 300 e apresentadora inexistente devolve null', async () => {
    await expect(cancelarPagamentoApresentadora(dbCancel(), { ...arg, motivo: 'x'.repeat(301) })).rejects.toMatchObject({ code: 'INVALID_MOTIVO' })
    const sem = fakeDb()
    const q = sem.query
    sem.query = vi.fn(async (sql, p) => (String(sql).includes('SELECT id FROM apresentadoras') ? { rows: [] } : q(sql, p)))
    expect(await cancelarPagamentoApresentadora(sem, arg)).toBeNull()
  })

  it('reativar: sem baixa apaga a linha; com baixa só limpa cancelado_*; nunca cancelado => null', async () => {
    const apaga = fakeDb()
    await reativarPagamentoApresentadora(apaga, arg)
    expect(apaga.calls[0].sql).toMatch(/DELETE FROM apresentadora_pagamentos[\s\S]*cancelado_em IS NOT NULL AND COALESCE\(valor_pago, 0\) = 0/)

    const limpa = fakeDb()
    const q = limpa.query
    limpa.query = vi.fn(async (sql, p) => (String(sql).includes('DELETE FROM') ? { rowCount: 0, rows: [] }
      : String(sql).startsWith('UPDATE apresentadora_pagamentos') ? (limpa.calls.push({ sql: String(sql), params: p }), { rowCount: 1, rows: [{ id: 'x' }] }) : q(sql, p)))
    await reativarPagamentoApresentadora(limpa, arg)
    expect(limpa.calls.find((c) => c.sql.startsWith('UPDATE apresentadora_pagamentos')).sql).toMatch(/cancelado_em = NULL, cancelado_motivo = NULL, cancelado_por = NULL/)
    const nunca = fakeDb()
    nunca.query = vi.fn(async () => ({ rowCount: 0, rows: [] }))
    expect(await reativarPagamentoApresentadora(nunca, arg)).toBeNull()
  })

  it('pagar item cancelado => 409 CUSTO_CANCELADO sem INSERT', async () => {
    const db = dbCancel({ linha: { cancelado_em: '2026-09-20T10:00:00.000Z' } })
    await expect(registrarPagamentoApresentadora(db, { tenantId, apresentadoraId: apId, mes, componente: 'fixo' }))
      .rejects.toMatchObject({ code: 'CUSTO_CANCELADO', statusCode: 409 })
    expect(db.calls.some((c) => c.sql.includes('INSERT INTO apresentadora_pagamentos'))).toBe(false)
  })

  it('desfazer em linha cancelada zera a baixa e mantém o cancelamento (sem DELETE)', async () => {
    const db = fakeDb({ pagos: [{ id: 'x', apresentadora_id: apId, competencia: '2026-09-01', componente: 'fixo', valor_pago: '10.00', data_pagamento: '2026-09-05', cancelado_em: '2026-09-20T10:00:00.000Z' }] })
    const q = db.query
    db.query = vi.fn(async (sql, p) => (String(sql).startsWith('UPDATE apresentadora_pagamentos') ? (db.calls.push({ sql: String(sql), params: p }), { rowCount: 1, rows: [{ id: 'x' }] }) : q(sql, p)))
    expect(await desfazerPagamentoApresentadora(db, arg)).toBe(true)
    expect(comando.registrarEstorno).toHaveBeenCalledTimes(1)
    expect(db.calls.some((c) => c.sql.includes('DELETE'))).toBe(false)
  })

  describe('rotas', () => {
    const B = `/v1/financeiro/apresentadoras-pagamentos/${apId}/2026-09/fixo`
    function buildApp(db) {
      const app = Fastify()
      app.decorate('requirePapel', () => async (request) => { request.user = { tenant_id: tenantId, sub: '44444444-4444-4444-8444-444444444444', papel: 'financeiro' } })
      app.decorate('withTenant', async (t, fn) => fn(db))
      app.register(financeiroApresentadorasPagamentosRoutes)
      return app
    }
    it('PATCH cancelar devolve o item com status cancelado; motivo > 300 => 400', async () => {
      const base = fakeDb()
      let gravou = false
      const db = { calls: base.calls, query: vi.fn(async (sql, p) => {
        const s = String(sql)
        if (s.startsWith('SELECT valor_pago')) return { rows: [] }
        if (s.includes('INSERT INTO apresentadora_pagamentos')) { gravou = true; return { rows: [] } }
        if (gravou && s.includes('FROM apresentadora_pagamentos')) return { rows: [{ apresentadora_id: apId, competencia: '2026-09-01', componente: 'fixo', valor_pago: '0', data_pagamento: null, cancelado_em: '2026-09-20T10:00:00.000Z' }] }
        return base.query(sql, p)
      }) }
      const app = buildApp(db)
      const res = await app.inject({ method: 'PATCH', url: `${B}/cancelar`, payload: { motivo: 'saiu' } })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ id: `apresentadora:${apId}:2026-09:fixo`, status: 'cancelado', cancelado_em: '2026-09-20T10:00:00.000Z' })
      expect((await app.inject({ method: 'PATCH', url: `${B}/cancelar`, payload: { motivo: 'x'.repeat(301) } })).statusCode).toBe(400)
    })
    it('auditoria de cancelar/reativar usa UUID em entity_id (chave virtual vai no metadata)', async () => {
      const audits = []
      const base = fakeDb()
      let gravou = false
      const db = { calls: base.calls, query: vi.fn(async (sql, p) => {
        const s = String(sql)
        if (s.startsWith('SELECT valor_pago')) return { rows: [] }
        if (s.includes('INSERT INTO apresentadora_pagamentos')) { gravou = true; return { rows: [] } }
        if (gravou && s.includes('FROM apresentadora_pagamentos')) return { rows: [{ apresentadora_id: apId, competencia: '2026-09-01', componente: 'fixo', valor_pago: '0', data_pagamento: null, cancelado_em: '2026-09-20T10:00:00.000Z' }] }
        return base.query(sql, p)
      }) }
      const app = buildApp(db)
      app.decorate('audit', { log: async (_req, e) => { audits.push(e) } })
      await app.inject({ method: 'PATCH', url: `${B}/cancelar`, payload: { motivo: 'saiu' } })
      expect(audits[0].action).toBe('financeiro.apresentadora_cancelar')
      expect(audits[0].entity_id).toBe(apId)
      expect(audits[0].metadata.item_id).toBe(`apresentadora:${apId}:2026-09:fixo`)
    })
    it('cancelar pago integral => 409; reativar nunca cancelado => 404; pagar cancelado => 409', async () => {
      const pago = fakeDb()
      const q = pago.query
      pago.query = vi.fn(async (sql, p) => (String(sql).startsWith('SELECT valor_pago') ? { rows: [{ valor_pago: '2700.00' }] } : q(sql, p)))
      const r1 = await buildApp(pago).inject({ method: 'PATCH', url: `${B}/cancelar`, payload: {} })
      expect(r1.statusCode).toBe(409)
      expect(r1.json().code).toBe('CANCELAMENTO_INVALIDO')

      const vazio = { query: vi.fn(async () => ({ rowCount: 0, rows: [] })) }
      expect((await buildApp(vazio).inject({ method: 'PATCH', url: `${B}/reativar` })).statusCode).toBe(404)

      const canc = fakeDb()
      const q2 = canc.query
      canc.query = vi.fn(async (sql, p) => (String(sql).startsWith('SELECT id, apresentadora_id') ? { rows: [{ id: 'x', apresentadora_id: apId, competencia: '2026-09-01', componente: 'fixo', valor_pago: '0', data_pagamento: null, cancelado_em: 'x' }] } : q2(sql, p)))
      const r3 = await buildApp(canc).inject({ method: 'PATCH', url: `${B}/pagar`, payload: {} })
      expect(r3.statusCode).toBe(409)
      expect(r3.json().code).toBe('CUSTO_CANCELADO')
    })
  })
})
