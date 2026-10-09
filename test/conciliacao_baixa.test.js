import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/services/receitas-comercial.js', async (orig) => {
  const real = await orig()
  return {
    ...real,
    receberTitulo: vi.fn(),
    desfazerRecebimento: vi.fn(),
  }
})
vi.mock('../src/services/financeiro-agregador.js', async (orig) => {
  const real = await orig()
  return { ...real, pagarImposto: vi.fn(), desfazerImposto: vi.fn() }
})
vi.mock('../src/services/custos-plano.js', async (orig) => {
  const real = await orig()
  return { ...real, pagarCusto: vi.fn(), desfazerBaixaCusto: vi.fn() }
})
vi.mock('../src/services/receitas-avulsas.js', async (orig) => {
  const real = await orig()
  return { ...real, receberReceitaAvulsa: vi.fn(), desfazerReceitaAvulsa: vi.fn() }
})
vi.mock('../src/services/apresentadoras-pagamentos.js', async (orig) => {
  const real = await orig()
  return { ...real, registrarPagamentoApresentadora: vi.fn(), desfazerPagamentoApresentadora: vi.fn() }
})

import * as receitas from '../src/services/receitas-comercial.js'
import * as agregador from '../src/services/financeiro-agregador.js'
import * as custos from '../src/services/custos-plano.js'
import * as avulsas from '../src/services/receitas-avulsas.js'
import * as apres from '../src/services/apresentadoras-pagamentos.js'
import {
  comSavepoints,
  darBaixaConciliacao,
  desfazerBaixaConciliacao,
} from '../src/services/conciliacao.js'

const T = '00000000-0000-0000-0000-0000000000aa'
const MARCA = '11111111-1111-1111-1111-111111111111'
const TITULO = '22222222-2222-2222-2222-222222222222'
const CUSTO = '33333333-3333-3333-3333-333333333333'
const APRES = '44444444-4444-4444-4444-444444444444'
const PG = '55555555-5555-5555-5555-555555555555'
const GATEWAY = '77777777-7777-7777-7777-777777777777'
const TX = { id: GATEWAY, tipo: 'entrada', valor: 1500.5, data: '2026-03-12' }

function fakeDb(responder = () => ({ rows: [] })) {
  const queries = []
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params })
      return responder(String(sql), params) ?? { rows: [] }
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('comSavepoints', () => {
  it('converte BEGIN/COMMIT/ROLLBACK em savepoints (nunca commita a transação externa)', async () => {
    const db = fakeDb()
    const w = comSavepoints(db)
    await w.query('BEGIN')
    await w.query('SELECT 1', [])
    await w.query('COMMIT')
    await w.query('BEGIN')
    await w.query('ROLLBACK')
    expect(db.queries.map((q) => q.sql)).toEqual([
      'SAVEPOINT conc_sp_1', 'SELECT 1', 'RELEASE SAVEPOINT conc_sp_1',
      'SAVEPOINT conc_sp_2', 'ROLLBACK TO SAVEPOINT conc_sp_2',
    ])
  })
})

describe('darBaixaConciliacao — receita', () => {
  it('título virtual: receberTitulo com valor/data da transação, guarda UUID real', async () => {
    receitas.receberTitulo.mockImplementation(async (db) => {
      await db.query('BEGIN'); await db.query('COMMIT') // como o serviço real
      return { id: TITULO, valor_pago: 1500.5, data_pagamento: '2026-03-12' }
    })
    const db = fakeDb()
    const r = await darBaixaConciliacao(db, { tenantId: T, transacao: TX, tipo: 'receita', alvoId: `calc:${MARCA}:2026-03:fixo`, userId: 'u1' })
    expect(r).toMatchObject({ aplicada: true, alvo_tipo: 'receita', alvo_id: TITULO, valor_pago: 1500.5 })
    const args = receitas.receberTitulo.mock.calls[0][1]
    expect(args).toMatchObject({ tenantId: T, id: `calc:${MARCA}:2026-03:fixo`, valorIncremental: '1500.50', dataPagamento: '2026-03-12' })
    expect(args.chaveOperacao).toMatch(new RegExp(`^asaas:${GATEWAY}:`))
    const sqls = db.queries.map((q) => q.sql)
    expect(sqls).not.toContain('COMMIT')
    expect(sqls.some((x) => x.startsWith('SAVEPOINT'))).toBe(true)
  })

  it('título já baixado: só vincula (aplicada=false, ja_baixado)', async () => {
    const db = fakeDb((sql) => (/FROM receita_titulos/.test(sql) ? { rows: [{ id: TITULO, valor_pago: '100.00' }] } : null))
    const r = await darBaixaConciliacao(db, { tenantId: T, transacao: TX, tipo: 'receita', alvoId: TITULO })
    expect(r).toMatchObject({ aplicada: false, motivo: 'ja_baixado', alvo_id: TITULO })
    expect(receitas.receberTitulo).not.toHaveBeenCalled()
  })

  it('título materializado inexistente → 404', async () => {
    await expect(darBaixaConciliacao(fakeDb(), { tenantId: T, transacao: TX, tipo: 'receita', alvoId: TITULO }))
      .rejects.toMatchObject({ status: 404 })
  })

  it('id inválido → 404', async () => {
    await expect(darBaixaConciliacao(fakeDb(), { tenantId: T, transacao: TX, tipo: 'receita', alvoId: 'lixo' }))
      .rejects.toMatchObject({ status: 404 })
  })
})

describe('darBaixaConciliacao — custo / imposto / apresentadora', () => {
  const SAIDA = { id: GATEWAY, tipo: 'saida', valor: 300, data: '2026-03-20' }

  it('custo: chama comando canônico por savepoint e marca operação Asaas', async () => {
    custos.pagarCusto.mockImplementation(async (tx) => {
      await tx.query('BEGIN'); await tx.query('COMMIT')
      return { valor_pago: 300, data_pagamento: '2026-03-20' }
    })
    const db = fakeDb((sql) => (/FROM custos/.test(sql) ? { rows: [{ id: CUSTO, valor_pago: null, tipo: 'outros' }] } : null))
    const r = await darBaixaConciliacao(db, { tenantId: T, transacao: SAIDA, tipo: 'custo', alvoId: CUSTO })
    expect(r).toMatchObject({ aplicada: true, alvo_id: CUSTO, valor_pago: 300, data_pagamento: '2026-03-20' })
    expect(custos.pagarCusto.mock.calls[0][1]).toMatchObject({
      tenantId: T, id: CUSTO, valorIncremental: '300.00', dataPagamento: '2026-03-20',
    })
    expect(custos.pagarCusto.mock.calls[0][1].chaveOperacao).toMatch(new RegExp(`^asaas:${GATEWAY}:`))
    expect(db.queries.map((q) => q.sql)).toContain('SAVEPOINT conc_sp_1')
    expect(db.queries.map((q) => q.sql)).toContain('RELEASE SAVEPOINT conc_sp_1')
    expect(db.queries.some((q) => /UPDATE custos/.test(q.sql))).toBe(false)
  })

  it('custo já pago: não sobrescreve', async () => {
    const db = fakeDb((sql) => (/FROM custos/.test(sql) ? { rows: [{ id: CUSTO, valor_pago: '300', tipo: 'outros' }] } : null))
    const r = await darBaixaConciliacao(db, { tenantId: T, transacao: SAIDA, tipo: 'custo', alvoId: CUSTO })
    expect(r).toMatchObject({ aplicada: false, motivo: 'ja_baixado' })
    expect(custos.pagarCusto).not.toHaveBeenCalled()
  })

  it('custo recorrente virtual é materializado antes da baixa', async () => {
    custos.pagarCusto.mockResolvedValue({ valor_pago: 300, data_pagamento: '2026-03-20' })
    const db = fakeDb((sql) => {
      if (/FROM custos_recorrentes/.test(sql)) {
        return { rows: [{ id: APRES, nome: 'Aluguel', valor: 300, grupo: 'estrutural', dia_vencimento: 5, mes_offset: 0, inicio: '2026-01-01', fim: null, ativo: true }] }
      }
      if (/SELECT id FROM custos WHERE tenant_id/.test(sql)) return { rows: [{ id: CUSTO }] }
      if (/FROM custos/.test(sql)) return { rows: [{ id: CUSTO, valor_pago: null, tipo: 'recorrente' }] }
      return null
    })
    const r = await darBaixaConciliacao(db, { tenantId: T, transacao: SAIDA, tipo: 'custo', alvoId: `rec:${APRES}:2026-03` })
    expect(r).toMatchObject({ aplicada: true, alvo_id: CUSTO })
    expect(db.queries.some((q) => /INSERT INTO custos/.test(q.sql))).toBe(true)
  })

  it('imposto virtual sem custo materializado → pagarImposto com valor/data da transação', async () => {
    let materializado = false
    agregador.pagarImposto.mockImplementation(async () => { materializado = true })
    const db = fakeDb((sql) => {
      if (/tipo = 'imposto'/.test(sql)) return { rows: materializado ? [{ id: CUSTO }] : [] }
      return null
    })
    const r = await darBaixaConciliacao(db, { tenantId: T, transacao: SAIDA, tipo: 'imposto', alvoId: 'imposto:2026-03' })
    expect(agregador.pagarImposto.mock.calls[0][0]).toHaveProperty('query')
    expect(agregador.pagarImposto.mock.calls[0][1]).toMatchObject({
      tenantId: T, mes: '2026-03', valorIncremental: '300.00', dataPagamento: SAIDA.data,
    })
    expect(r).toMatchObject({ aplicada: true, alvo_tipo: 'imposto', alvo_id: CUSTO, valor_pago: SAIDA.valor, data_pagamento: SAIDA.data })
  })

  it('imposto já materializado em custos (tipo imposto) recebe a baixa', async () => {
    agregador.pagarImposto.mockResolvedValue({})
    const db = fakeDb((sql) => {
      if (/tipo = 'imposto'/.test(sql)) return { rows: [{ id: CUSTO, valor_pago: null, mes: '2026-03' }] }
      if (/FROM custos/.test(sql)) return { rows: [{ id: CUSTO, valor_pago: null, tipo: 'imposto' }] }
      return null
    })
    const r = await darBaixaConciliacao(db, { tenantId: T, transacao: SAIDA, tipo: 'imposto', alvoId: 'imposto:2026-03' })
    expect(r).toMatchObject({ aplicada: true, alvo_tipo: 'imposto', alvo_id: CUSTO })
    expect(agregador.pagarImposto).toHaveBeenCalledTimes(1)
  })

  it('imposto: id uuid de custo que não é tipo imposto → 404', async () => {
    const db = fakeDb((sql) => (/FROM custos/.test(sql) && !/tipo = 'imposto'/.test(sql) ? { rows: [{ id: CUSTO, valor_pago: null, tipo: 'outros' }] } : null))
    await expect(darBaixaConciliacao(db, { tenantId: T, transacao: SAIDA, tipo: 'imposto', alvoId: CUSTO }))
      .rejects.toMatchObject({ status: 404 })
  })

  it('apresentadora: registra pagamento e devolve id da linha', async () => {
    apres.registrarPagamentoApresentadora.mockResolvedValue({ valor_pago: '300.00', data_pagamento: '2026-03-20' })
    let n = 0
    const db = fakeDb((sql) => {
      if (/FROM apresentadora_pagamentos/.test(sql)) return ++n === 1 ? { rows: [] } : { rows: [{ id: PG }] }
      return null
    })
    const r = await darBaixaConciliacao(db, { tenantId: T, transacao: SAIDA, tipo: 'apresentadora', alvoId: `apresentadora:${APRES}:2026-02`, userId: 'u1' })
    expect(r).toMatchObject({ aplicada: true, alvo_id: PG, valor_pago: 300 })
    expect(apres.registrarPagamentoApresentadora.mock.calls[0][1]).toMatchObject({
      tenantId: T, apresentadoraId: APRES, mes: '2026-02', componente: 'fixo', valorIncremental: '300.00', dataPagamento: '2026-03-20',
    })
  })

  it('apresentadora: id com componente baixa SÓ aquele componente (consulta e registro)', async () => {
    apres.registrarPagamentoApresentadora.mockResolvedValue({ valor_pago: '300.00', data_pagamento: '2026-03-20' })
    let n = 0
    const db = fakeDb((sql) => {
      if (/FROM apresentadora_pagamentos/.test(sql)) return ++n === 1 ? { rows: [] } : { rows: [{ id: PG }] }
      return null
    })
    const r = await darBaixaConciliacao(db, { tenantId: T, transacao: SAIDA, tipo: 'apresentadora', alvoId: `apresentadora:${APRES}:2026-02:variavel` })
    expect(r).toMatchObject({ aplicada: true, alvo_id: PG })
    expect(apres.registrarPagamentoApresentadora.mock.calls[0][1]).toMatchObject({ componente: 'variavel' })
    for (const q of db.queries.filter((x) => /FROM apresentadora_pagamentos/.test(x.sql))) {
      expect(q.params).toEqual([T, APRES, '2026-02-01', 'variavel'])
    }
  })

  it('apresentadora: componente fixo já baixado não bloqueia o variável (e vice-versa)', async () => {
    apres.registrarPagamentoApresentadora.mockResolvedValue({ valor_pago: '300.00', data_pagamento: '2026-03-20' })
    apres.registrarPagamentoApresentadora.mockRejectedValueOnce(Object.assign(new Error('sem saldo'), { code: 'APRESENTADORA_SEM_SALDO' }))
    let n = 0
    const db = fakeDb((sql, params) => {
      if (/FROM apresentadora_pagamentos/.test(sql)) {
        if (params[3] === 'fixo') return { rows: [{ id: PG, valor_pago: '2700' }] }
        return ++n === 1 ? { rows: [] } : { rows: [{ id: PG }] }
      }
      return null
    })
    const fixo = await darBaixaConciliacao(db, { tenantId: T, transacao: SAIDA, tipo: 'apresentadora', alvoId: `apresentadora:${APRES}:2026-02:fixo` })
    expect(fixo).toMatchObject({ aplicada: false, motivo: 'ja_baixado' })
    const variavel = await darBaixaConciliacao(db, { tenantId: T, transacao: SAIDA, tipo: 'apresentadora', alvoId: `apresentadora:${APRES}:2026-02:variavel` })
    expect(variavel.aplicada).toBe(true)
  })

  it('apresentadora já paga: só vincula', async () => {
    apres.registrarPagamentoApresentadora.mockRejectedValueOnce(Object.assign(new Error('sem saldo'), { code: 'APRESENTADORA_SEM_SALDO' }))
    const db = fakeDb((sql) => (/FROM apresentadora_pagamentos/.test(sql) ? { rows: [{ id: PG, valor_pago: '10' }] } : null))
    const r = await darBaixaConciliacao(db, { tenantId: T, transacao: SAIDA, tipo: 'apresentadora', alvoId: `apresentadora:${APRES}:2026-02` })
    expect(r).toMatchObject({ aplicada: false, motivo: 'ja_baixado', alvo_id: PG })
    expect(apres.registrarPagamentoApresentadora).toHaveBeenCalledTimes(1)
  })

  it('apresentadora cancelada: 409 ALVO_CANCELADO e não registra pagamento', async () => {
    apres.registrarPagamentoApresentadora.mockClear()
    const db = fakeDb((sql) => (/FROM apresentadora_pagamentos/.test(sql) ? { rows: [{ id: PG, valor_pago: '0', cancelado_em: '2026-02-10T00:00:00Z' }] } : null))
    await expect(darBaixaConciliacao(db, { tenantId: T, transacao: SAIDA, tipo: 'apresentadora', alvoId: `apresentadora:${APRES}:2026-02:fixo` }))
      .rejects.toMatchObject({ status: 409, codigo: 'ALVO_CANCELADO' })
    expect(apres.registrarPagamentoApresentadora).not.toHaveBeenCalled()
  })
})

describe('darBaixaConciliacao — avulsa', () => {
  const AV = '66666666-6666-6666-6666-666666666666'

  it('baixa a receita avulsa com valor/data da transação', async () => {
    avulsas.receberReceitaAvulsa.mockResolvedValue({ id: AV, valor_pago: 1500.5, data_pagamento: '2026-03-12' })
    const db = fakeDb((sql) => (/FROM receitas_avulsas/.test(sql) ? { rows: [{ id: AV, valor_pago: '0.00' }] } : null))
    const r = await darBaixaConciliacao(db, { tenantId: T, transacao: TX, tipo: 'avulsa', alvoId: AV })
    expect(r).toMatchObject({ aplicada: true, alvo_tipo: 'avulsa', alvo_id: AV, valor_pago: 1500.5, data_pagamento: '2026-03-12' })
    expect(avulsas.receberReceitaAvulsa.mock.calls[0][1]).toMatchObject({ tenantId: T, id: AV, valorPago: '1500.50', dataPagamento: '2026-03-12' })
    expect(avulsas.receberReceitaAvulsa.mock.calls[0][1].chaveOperacao).toMatch(new RegExp(`^asaas:${GATEWAY}:`))
    expect(db.queries[0].sql).toMatch(/FOR UPDATE/)
    expect(db.queries[0].params).toEqual([AV, T])
  })
  it('já recebida: só vincula; inexistente/ id inválido → 404', async () => {
    const pago = fakeDb((sql) => (/FROM receitas_avulsas/.test(sql) ? { rows: [{ id: AV, valor_pago: '10' }] } : null))
    expect(await darBaixaConciliacao(pago, { tenantId: T, transacao: TX, tipo: 'avulsa', alvoId: AV }))
      .toMatchObject({ aplicada: false, motivo: 'ja_baixado', alvo_id: AV })
    expect(avulsas.receberReceitaAvulsa).not.toHaveBeenCalled()
    await expect(darBaixaConciliacao(fakeDb(), { tenantId: T, transacao: TX, tipo: 'avulsa', alvoId: AV })).rejects.toMatchObject({ status: 404 })
    await expect(darBaixaConciliacao(fakeDb(), { tenantId: T, transacao: TX, tipo: 'avulsa', alvoId: 'rec:x' })).rejects.toMatchObject({ status: 404 })
  })
})

describe('desfazerBaixaConciliacao', () => {
  const origem = { receita: 'receita_titulo', avulsa: 'receita_avulsa', custo: 'custo', apresentadora: 'apresentadora_pagamento', imposto: 'imposto' }
  const dbComFato = (tipo, alvoId, extra = () => null) => fakeDb((sql, params) => {
    if (/FROM financeiro_liquidacoes l/.test(sql)) {
      expect(params).toEqual([T, `asaas:${GATEWAY}:%`])
      return { rows: [{ id: TITULO, origem_tipo: origem[tipo], origem_id: alvoId, saldo: '300.00' }] }
    }
    return extra(sql, params)
  })
  const args = (tipo, alvoId) => ({ tenantId: T, tipo, alvoId, transacaoId: GATEWAY })

  it('avulsa usa estorno canônico e não a limpeza legada', async () => {
    avulsas.desfazerReceitaAvulsa.mockResolvedValue({ id: TITULO })
    const db = dbComFato('avulsa', TITULO)
    expect(await desfazerBaixaConciliacao(db, args('avulsa', TITULO))).toEqual({ desfeita: true })
    expect(avulsas.desfazerReceitaAvulsa.mock.calls[0][1]).toMatchObject({ tenantId: T, id: TITULO, autoEstorno: true })
    expect(avulsas.desfazerReceitaAvulsa.mock.calls[0][0]).toHaveProperty('query')
    expect(db.queries.some((q) => /UPDATE receitas_avulsas/.test(q.sql))).toBe(false)
  })
  it('receita só desfaz o fato associado à transação', async () => {
    receitas.desfazerRecebimento.mockResolvedValue({})
    expect(await desfazerBaixaConciliacao(dbComFato('receita', TITULO), args('receita', TITULO))).toEqual({ desfeita: true })
    expect(receitas.desfazerRecebimento.mock.calls[0][1]).toMatchObject({ tenantId: T, id: TITULO })
  })
  it('custo e imposto usam comandos canônicos', async () => {
    custos.desfazerBaixaCusto.mockResolvedValue({ id: CUSTO })
    agregador.desfazerImposto.mockResolvedValue({ id: CUSTO })
    expect(await desfazerBaixaConciliacao(dbComFato('custo', CUSTO), args('custo', CUSTO))).toEqual({ desfeita: true })
    expect(custos.desfazerBaixaCusto.mock.calls[0][1]).toMatchObject({ tenantId: T, id: CUSTO })
    const dbTax = dbComFato('imposto', CUSTO, (sql) => (/FROM custos/.test(sql) ? { rows: [{ mes: '2026-03' }] } : null))
    expect(await desfazerBaixaConciliacao(dbTax, args('imposto', CUSTO))).toEqual({ desfeita: true })
    expect(agregador.desfazerImposto.mock.calls[0][1]).toMatchObject({ tenantId: T, mes: '2026-03' })
    expect(dbTax.queries.some((q) => /UPDATE custos/.test(q.sql))).toBe(false)
  })
  it('apresentadora conserva a linha e usa estorno canônico por componente', async () => {
    apres.desfazerPagamentoApresentadora.mockResolvedValue(true)
    const db = dbComFato('apresentadora', PG, (sql) => (/FROM apresentadora_pagamentos/.test(sql)
      ? { rows: [{ apresentadora_id: APRES, mes: '2026-02', componente: 'variavel' }] } : null))
    expect(await desfazerBaixaConciliacao(db, args('apresentadora', PG))).toEqual({ desfeita: true })
    expect(apres.desfazerPagamentoApresentadora.mock.calls[0][1]).toMatchObject({
      tenantId: T, apresentadoraId: APRES, mes: '2026-02', componente: 'variavel',
    })
    expect(db.queries.some((q) => /DELETE|UPDATE apresentadora_pagamentos/.test(q.sql))).toBe(false)
  })
  it('link legado, fato de outro alvo ou vários fatos exigem revisão', async () => {
    await expect(desfazerBaixaConciliacao(fakeDb(), args('custo', CUSTO)))
      .rejects.toMatchObject({ status: 409, codigo: 'CONCILIACAO_BAIXA_AMBIGUA' })
    const trocado = fakeDb((sql) => (/FROM financeiro_liquidacoes l/.test(sql)
      ? { rows: [{ id: TITULO, origem_tipo: 'custo', origem_id: PG, saldo: '300.00' }] } : null))
    await expect(desfazerBaixaConciliacao(trocado, args('custo', CUSTO))).rejects.toMatchObject({ status: 409 })
    expect(custos.desfazerBaixaCusto).not.toHaveBeenCalled()
  })
})
