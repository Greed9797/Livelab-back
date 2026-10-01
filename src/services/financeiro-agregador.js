// Agregador do financeiro (onda 2): une receitas do comercial, custos manuais,
// pagamentos de apresentadoras e imposto num contrato ÚNICO de lançamentos, e
// deriva DRE mensal e fluxo de caixa a partir dele.
//
// Fontes (NÃO reimplementar regra aqui):
//   receitas       → listarTitulosReceita         (services/receitas-comercial.js)
//   custos         → listarCustos                 (services/custos-plano.js)
//   apresentadoras → listarPagamentosApresentadoras (services/apresentadoras-pagamentos.js)
//   receitas avulsas → listarReceitasAvulsas      (services/receitas-avulsas.js; 'aporte'
//                    é entrada de caixa fora da receita operacional e da base do imposto)
//   imposto        → calculado aqui (base = recebido em M-1) + baixa materializada em
//                    `custos` (tipo 'imposto', 1 por tenant × competência, migration 167)
//
// Corte (migration 169): tenants.financeiro_data_corte. Item com data efetiva
// (data_pagamento se valor_pago > 0, senão vencimento) anterior ao corte fica fora de
// lançamentos, DRE, fluxo, totais e imposto (dentroDoCorte). Sem corte, nada muda.
// Saldo de caixa = financeiro_saldo_abertura + realizado desde o corte (calcularCaixa).
//
// Status é SEMPRE derivado (lib/lancamento-status.js). Datas trafegam como strings
// 'YYYY-MM-DD' / 'YYYY-MM' — sem Date, para não haver bug de fuso.
// Funções puras exportadas para teste; as que tocam o banco recebem `db` e
// `tenantId` explícito (além do RLS).

import { statusLancamento } from '../lib/lancamento-status.js'
import { hojeSaoPaulo, listarTitulosReceita } from './receitas-comercial.js'
import { addMeses, diasNoMes, listarCustos, mesesEntre, ultimoDia } from './custos-plano.js'
import { listarPagamentosApresentadoras } from './apresentadoras-pagamentos.js'
import { ehAporte, listarReceitasAvulsas } from './receitas-avulsas.js'

export { hojeSaoPaulo }

export const ALIQUOTA_IMPOSTO_PADRAO = 10
export const IMPOSTO_DIA_VENCIMENTO = 20
export const FLUXO_DIAS = [5, 10, 15, 20, 25, 30]
export const FLUXO_CHAVES = [...FLUXO_DIAS.map(String), 'cartao']
export const MAX_MESES_AGREGADOR = 36

const RE_MES = /^(\d{4})-(0[1-9]|1[0-2])$/
const RE_MES_OU_DATA = /^(\d{4}-(?:0[1-9]|1[0-2]))(?:-\d{2})?$/
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/

/** 'YYYY-MM-DD' válida no calendário (rejeita 2026-02-30). */
export function dataValida(d) {
  if (!RE_DATA.test(String(d ?? ''))) return false
  const [y, m, dia] = String(d).split('-').map(Number)
  if (m < 1 || m > 12 || dia < 1) return false
  return dia <= new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** Dia anterior de 'YYYY-MM-DD' (aritmética UTC pura, sem fuso). */
export function diaAnterior(d) {
  const [y, m, dia] = String(d).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, dia - 1)).toISOString().slice(0, 10)
}

export const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100
const mesDe = (d) => (d ? String(d).slice(0, 7) : null)

function erro(message, statusCode = 400, code = 'INVALID_PERIOD') {
  const e = new Error(message)
  e.statusCode = statusCode
  e.code = code
  return e
}

// ─── Período ──────────────────────────────────────────────────────────────

/**
 * Resolve o período em meses a partir da query:
 *   inicio/fim (YYYY-MM ou YYYY-MM-DD) → mes (YYYY-MM) → mes+ano → mês corrente (SP).
 */
export function resolverPeriodoMeses(query = {}, hoje = hojeSaoPaulo()) {
  const mesDeValor = (v) => {
    const m = String(v ?? '').match(RE_MES_OU_DATA)
    return m ? m[1] : null
  }
  let inicio = null
  let fim = null
  if (query.inicio || query.fim) {
    inicio = mesDeValor(query.inicio ?? query.fim)
    fim = mesDeValor(query.fim ?? query.inicio)
    if (!inicio || !fim) throw erro('inicio/fim devem estar no formato AAAA-MM')
  } else if (query.mes && query.ano) {
    const m = Number(query.mes)
    const a = Number(query.ano)
    if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(a)) throw erro('mes/ano inválidos')
    inicio = fim = `${String(a).padStart(4, '0')}-${String(m).padStart(2, '0')}`
  } else if (query.mes) {
    inicio = fim = mesDeValor(query.mes)
    if (!inicio) throw erro('mes deve estar no formato AAAA-MM')
  } else {
    inicio = fim = hoje.slice(0, 7)
  }
  if (fim < inicio) throw erro('fim deve ser maior ou igual a inicio')
  if (mesesEntre(inicio, fim).length > MAX_MESES_AGREGADOR) throw erro(`Período máximo de ${MAX_MESES_AGREGADOR} meses`)
  return { inicio, fim }
}

// ─── Normalização para o contrato comum ───────────────────────────────────

const BASE_ITEM = {
  grupo: null, componente: null, marca_id: null, marca_nome: null, cliente_id: null,
  cliente_nome: null, apresentadora_id: null, recorrente_id: null, parcela_grupo_id: null,
  parcela_num: null, parcelas_total: null, observacao: null, virtual: false,
}

/** Título de receita (listarTitulosReceita) → item comum (origem marca_fixo|marca_comissao). */
export function normalizarReceita(t, hoje) {
  const item = {
    ...BASE_ITEM,
    ...t,
    natureza: 'receita',
    origem: t.componente === 'fixo' ? 'marca_fixo' : 'marca_comissao',
    valor_previsto: r2(t.valor_previsto),
    valor_pago: r2(t.valor_pago),
    grupo: 'receita',
    virtual: !t.materializado,
  }
  item.status = statusLancamento(item, hoje)
  return item
}

/** Custo (listarCustos) → item comum (valor_pago numérico). */
export function normalizarCusto(c, hoje) {
  const item = { ...BASE_ITEM, ...c, natureza: 'custo', valor_previsto: r2(c.valor_previsto), valor_pago: r2(c.valor_pago) }
  item.status = statusLancamento(item, hoje)
  return item
}

/** Pagamento de apresentadora → item comum (grupo 'apresentadoras'). */
export function normalizarApresentadora(p, hoje) {
  const item = {
    ...BASE_ITEM,
    ...p,
    natureza: 'custo',
    origem: 'apresentadora',
    grupo: 'apresentadoras',
    valor_previsto: r2(p.valor_previsto),
    valor_pago: r2(p.valor_pago),
    virtual: !(Number(p.valor_pago) > 0),
  }
  item.status = statusLancamento(item, hoje)
  return item
}

// ─── Imposto (lógica pura) ────────────────────────────────────────────────

export function vencimentoImposto(mes) {
  const dia = Math.min(IMPOSTO_DIA_VENCIMENTO, diasNoMes(mes))
  return `${mes}-${String(dia).padStart(2, '0')}`
}

export function idImposto(mes) {
  return `imposto:${mes}`
}

export function parseIdImposto(id) {
  const m = /^imposto:(\d{4}-(?:0[1-9]|1[0-2]))$/.exec(String(id ?? ''))
  return m ? { mes: m[1] } : null
}

/**
 * Imposto da competência `mes`: base = recebido em M-1 quando M-1 já fechou
 * (M-1 < mês corrente); senão PROJEÇÃO sobre o previsto de M-1 (receitas com
 * vencimento em M-1) — nunca menor que o já recebido.
 */
export function calcularImpostoMes({ mes, mesAtual, aliquota, recebidoAnterior = 0, previstoAnterior = 0 }) {
  const anterior = addMeses(mes, -1)
  const fechado = anterior < mesAtual
  const base = r2(fechado ? recebidoAnterior : Math.max(Number(previstoAnterior) || 0, Number(recebidoAnterior) || 0))
  const pct = Number(aliquota ?? ALIQUOTA_IMPOSTO_PADRAO)
  return {
    mes,
    mes_base: anterior,
    base,
    base_tipo: fechado ? 'realizado' : 'projetado',
    aliquota: pct,
    valor: r2(base * pct / 100),
  }
}

/** Item de lançamento do imposto; `materializado` = linha de custos (tipo 'imposto') ou null. */
export function montarItemImposto({ calculo, materializado = null, hoje }) {
  const { mes } = calculo
  const item = {
    ...BASE_ITEM,
    id: idImposto(mes),
    natureza: 'custo',
    origem: 'imposto',
    grupo: 'imposto',
    descricao: `Imposto ${String(calculo.aliquota).replace('.', ',')}% s/ recebido ${calculo.mes_base.slice(5)}/${calculo.mes_base.slice(0, 4)}`,
    competencia: `${mes}-01`,
    data_vencimento: materializado?.data_vencimento ?? vencimentoImposto(mes),
    valor_previsto: materializado ? r2(materializado.valor) : calculo.valor,
    valor_pago: r2(materializado?.valor_pago),
    data_pagamento: materializado?.data_pagamento ?? null,
    observacao: materializado?.observacao ?? null,
    virtual: !materializado,
    custo_id: materializado?.id ?? null,
    aliquota: calculo.aliquota,
    base: calculo.base,
    base_tipo: calculo.base_tipo,
    mes_base: calculo.mes_base,
    valor_calculado: calculo.valor,
  }
  item.status = statusLancamento(item, hoje)
  return item
}

/** Σ valor_previsto das receitas por mês de VENCIMENTO. */
export function previstoReceitaPorVencimento(receitas) {
  const out = new Map()
  for (const r of receitas) {
    const m = mesDe(r.data_vencimento)
    if (m) out.set(m, r2((out.get(m) ?? 0) + Number(r.valor_previsto || 0)))
  }
  return out
}

// ─── Corte (início do financeiro) ─────────────────────────────────────────

/**
 * Data efetiva do item para a regra de corte: data_pagamento quando há pagamento
 * (valor_pago > 0), senão data_vencimento (sem vencimento → último dia da competência).
 */
export function dataEfetiva(item) {
  if (Number(item?.valor_pago) > 0 && item?.data_pagamento) return String(item.data_pagamento).slice(0, 10)
  const v = vencimentoEfetivo(item ?? {})
  return v ? String(v).slice(0, 10) : null
}

/** true se o item vale a partir do corte (data efetiva >= data_corte). Sem corte → sempre true. */
export function dentroDoCorte(item, dataCorte) {
  if (!dataCorte) return true
  const d = dataEfetiva(item)
  return !d || d >= String(dataCorte).slice(0, 10)
}

export const aplicarCorte = (itens, dataCorte) => (dataCorte ? itens.filter((i) => dentroDoCorte(i, dataCorte)) : itens)

// ─── Filtros e totais ─────────────────────────────────────────────────────

const normTxt = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function filtrarLancamentos(itens, { natureza, status, grupo, q } = {}) {
  const busca = q ? normTxt(q).trim() : ''
  return itens.filter((i) => (
    (!natureza || i.natureza === natureza)
    && (!status || i.status === status)
    && (!grupo || i.grupo === grupo)
    && (!busca || normTxt([i.descricao, i.marca_nome, i.cliente_nome, i.observacao, i.grupo].join(' ')).includes(busca))
  ))
}

const emAberto = (i) => Math.max(0, r2(i.valor_previsto) - r2(i.valor_pago))

/**
 * Totais por natureza: previsto (Σ valor_previsto), pago (Σ valor_pago),
 * atrasado (em aberto dos atrasados), pendente (em aberto dos demais não pagos).
 */
export function totalizarLancamentos(itens) {
  const zero = () => ({ previsto: 0, pago: 0, atrasado: 0, pendente: 0 })
  const t = { receita: zero(), custo: zero() }
  const aportes = { previsto: 0, pago: 0 }
  for (const i of itens) {
    const n = t[i.natureza]
    if (!n) continue
    if (ehAporte(i)) {
      aportes.previsto += Number(i.valor_previsto) || 0
      aportes.pago += Number(i.valor_pago) || 0
    }
    n.previsto += Number(i.valor_previsto) || 0
    n.pago += Number(i.valor_pago) || 0
    if (i.status === 'atrasado') n.atrasado += emAberto(i)
    else if (i.status !== 'pago') n.pendente += emAberto(i)
  }
  for (const n of [t.receita, t.custo]) for (const k of Object.keys(n)) n[k] = r2(n[k])
  return {
    ...t,
    // aportes (receitas avulsas do grupo 'aporte') já estão em receita; aqui à parte.
    aportes: { previsto: r2(aportes.previsto), pago: r2(aportes.pago) },
    saldo_previsto: r2(t.receita.previsto - t.custo.previsto),
    saldo_realizado: r2(t.receita.pago - t.custo.pago),
  }
}

export function ordenarLancamentos(itens) {
  return itens.sort((a, b) => (
    String(a.data_vencimento ?? '9999').localeCompare(String(b.data_vencimento ?? '9999'))
    || (a.natureza === b.natureza ? 0 : a.natureza === 'receita' ? -1 : 1)
    || String(a.descricao).localeCompare(String(b.descricao), 'pt-BR')
  ))
}

// ─── DRE (competência) ────────────────────────────────────────────────────

const pr = () => ({ previsto: 0, realizado: 0 })
const addPr = (alvo, i) => {
  alvo.previsto += Number(i.valor_previsto) || 0
  alvo.realizado += Number(i.valor_pago) || 0
}
const roundPr = (o) => ({ previsto: r2(o.previsto), realizado: r2(o.realizado) })

/**
 * DRE mensal por COMPETÊNCIA: previsto = Σ valor_previsto; realizado = Σ valor_pago.
 * custos exclui apresentadoras e imposto (linhas próprias). resultado = receita −
 * custos − apresentadoras − imposto. `impostos` = Map mes → { aliquota, base }.
 * Aportes (receita avulsa grupo 'aporte') NÃO são receita operacional: linha
 * `aportes` informativa, fora do resultado.
 */
export function montarDre({ meses, itens, impostos = new Map(), aliquota = ALIQUOTA_IMPOSTO_PADRAO }) {
  const porMes = new Map(meses.map((m) => [m, {
    mes: m, receita: pr(), aportes: pr(), custos: { ...pr(), por_grupo: {} }, apresentadoras: pr(),
    imposto: { ...pr(), aliquota: impostos.get(m)?.aliquota ?? Number(aliquota), base: impostos.get(m)?.base ?? 0 },
  }]))
  for (const i of itens) {
    const linha = porMes.get(mesDe(i.competencia))
    if (!linha) continue
    if (ehAporte(i)) addPr(linha.aportes, i)
    else if (i.natureza === 'receita') addPr(linha.receita, i)
    else if (i.origem === 'apresentadora') addPr(linha.apresentadoras, i)
    else if (i.origem === 'imposto') addPr(linha.imposto, i)
    else {
      addPr(linha.custos, i)
      const g = i.grupo || 'outros'
      linha.custos.por_grupo[g] ??= pr()
      addPr(linha.custos.por_grupo[g], i)
    }
  }
  const resultado = (l, k) => r2(l.receita[k] - l.custos[k] - l.apresentadoras[k] - l.imposto[k])
  const fechar = (l) => {
    const porGrupo = Object.fromEntries(Object.entries(l.custos.por_grupo).map(([g, v]) => [g, roundPr(v)]))
    const out = {
      receita: roundPr(l.receita),
      aportes: roundPr(l.aportes),
      custos: { ...roundPr(l.custos), por_grupo: porGrupo },
      apresentadoras: roundPr(l.apresentadoras),
      imposto: { ...roundPr(l.imposto), aliquota: l.imposto.aliquota, base: r2(l.imposto.base) },
    }
    out.resultado = { previsto: resultado(out, 'previsto'), realizado: resultado(out, 'realizado') }
    return out
  }
  const linhas = meses.map((m) => ({ mes: m, ...fechar(porMes.get(m)) }))
  const tot = {
    receita: pr(), aportes: pr(), custos: { ...pr(), por_grupo: {} }, apresentadoras: pr(),
    imposto: { ...pr(), aliquota: Number(aliquota), base: 0 },
  }
  for (const l of linhas) {
    for (const k of ['previsto', 'realizado']) {
      tot.receita[k] += l.receita[k]
      tot.aportes[k] += l.aportes[k]
      tot.custos[k] += l.custos[k]
      tot.apresentadoras[k] += l.apresentadoras[k]
      tot.imposto[k] += l.imposto[k]
    }
    tot.imposto.base += l.imposto.base
    for (const [g, v] of Object.entries(l.custos.por_grupo)) {
      tot.custos.por_grupo[g] ??= pr()
      tot.custos.por_grupo[g].previsto += v.previsto
      tot.custos.por_grupo[g].realizado += v.realizado
    }
  }
  return { meses: linhas, totais: fechar(tot) }
}

// ─── Fluxo de caixa ───────────────────────────────────────────────────────

/** Dia 'YYYY-MM-DD' → faixa do fluxo ('5','10',...,'30'); dia 31 cai em '30'. */
export function faixaDoDia(data) {
  const dia = Number(String(data).slice(8, 10)) || 30
  return String(FLUXO_DIAS.find((d) => dia <= d) ?? 30)
}

/** Chave da linha do fluxo: custos do grupo 'cartao' vão para a linha 'cartao'. */
export function chaveFluxo(item, data) {
  if (item.natureza === 'custo' && item.grupo === 'cartao') return 'cartao'
  return faixaDoDia(data)
}

/** Data de vencimento efetiva (sem vencimento → último dia da competência). */
export const vencimentoEfetivo = (i) => i.data_vencimento ?? (i.competencia ? ultimoDia(mesDe(i.competencia)) : null)

const labelFluxo = (k) => (k === 'cartao' ? 'Cartão' : `Dia ${k}`)

/**
 * Fluxo de caixa do mês `mes`:
 *   previsto  = Σ valor_previsto por DATA DE VENCIMENTO no mês;
 *   realizado = Σ valor_pago por DATA DE PAGAMENTO no mês.
 * Linhas nas faixas 5/10/15/20/25/30 (+ 'cartao'), saldo e acumulado (a partir de
 * saldo_inicial). serie_anual jan–dez do ano de `mes`, mesma regra.
 * Formato legado (`entradas`/`saidas`/`items` por dia, previsto) mantido para o front atual.
 */
export function montarFluxoCaixa({ mes, itens, saldoInicial = 0, saldoInicialOrigem = 'informado' }) {
  const ano = mes.slice(0, 4)
  const linhas = new Map(FLUXO_CHAVES.map((k) => [k, { chave: k, label: labelFluxo(k), entradas: pr(), saidas: pr() }]))
  const serie = new Map(Array.from({ length: 12 }, (_, i) => {
    const m = `${ano}-${String(i + 1).padStart(2, '0')}`
    return [m, { mes: m, entradas: pr(), saidas: pr() }]
  }))
  const porDia = new Map()
  const lado = (i) => (i.natureza === 'receita' ? 'entradas' : 'saidas')

  for (const i of itens) {
    const venc = vencimentoEfetivo(i)
    const previsto = Number(i.valor_previsto) || 0
    const pago = Number(i.valor_pago) || 0
    if (venc) {
      const mv = mesDe(venc)
      if (mv === mes) {
        linhas.get(chaveFluxo(i, venc))[lado(i)].previsto += previsto
        const d = porDia.get(venc) ?? { dia: venc, entradas: 0, saidas: 0 }
        d[lado(i)] += previsto
        porDia.set(venc, d)
      }
      if (serie.has(mv)) serie.get(mv)[lado(i)].previsto += previsto
    }
    if (pago > 0 && i.data_pagamento) {
      const mp = mesDe(i.data_pagamento)
      if (mp === mes) linhas.get(chaveFluxo(i, i.data_pagamento))[lado(i)].realizado += pago
      if (serie.has(mp)) serie.get(mp)[lado(i)].realizado += pago
    }
  }

  const saldoIni = r2(saldoInicial)
  const acum = { previsto: saldoIni, realizado: saldoIni }
  const outLinhas = FLUXO_CHAVES.map((k) => {
    const l = linhas.get(k)
    const entradas = roundPr(l.entradas)
    const saidas = roundPr(l.saidas)
    const saldo = { previsto: r2(entradas.previsto - saidas.previsto), realizado: r2(entradas.realizado - saidas.realizado) }
    acum.previsto = r2(acum.previsto + saldo.previsto)
    acum.realizado = r2(acum.realizado + saldo.realizado)
    return { chave: k, label: l.label, entradas, saidas, saldo, acumulado: { ...acum } }
  })
  const soma = (campo, k) => r2(outLinhas.reduce((s, l) => s + l[campo][k], 0))
  const totais = {
    entradas: { previsto: soma('entradas', 'previsto'), realizado: soma('entradas', 'realizado') },
    saidas: { previsto: soma('saidas', 'previsto'), realizado: soma('saidas', 'realizado') },
  }
  totais.saldo = {
    previsto: r2(totais.entradas.previsto - totais.saidas.previsto),
    realizado: r2(totais.entradas.realizado - totais.saidas.realizado),
  }
  const serieAnual = [...serie.values()].map((s) => {
    const entradas = roundPr(s.entradas)
    const saidas = roundPr(s.saidas)
    return {
      mes: s.mes, entradas, saidas,
      saldo: { previsto: r2(entradas.previsto - saidas.previsto), realizado: r2(entradas.realizado - saidas.realizado) },
    }
  })
  const dias = [...porDia.values()].sort((a, b) => a.dia.localeCompare(b.dia))
    .map((d) => ({ dia: d.dia, entradas: r2(d.entradas), saidas: r2(d.saidas) }))
  return {
    mes,
    saldo_inicial: saldoIni,
    saldo_inicial_origem: saldoInicialOrigem,
    linhas: outLinhas,
    totais,
    serie_anual: serieAnual,
    // legado (FinanceiroPage atual): séries diárias do mês por vencimento (previsto)
    periodo: `${mes}-01`,
    inicio: `${mes}-01`,
    fim: ultimoDia(mes),
    entradas: dias.filter((d) => d.entradas !== 0).map((d) => ({ dia: d.dia, valor: d.entradas })),
    saidas: dias.filter((d) => d.saidas !== 0).map((d) => ({ dia: d.dia, valor: d.saidas })),
    items: dias,
  }
}

// ─── Banco: config ────────────────────────────────────────────────────────

/** { aliquota_imposto_pct, data_corte: 'YYYY-MM-DD'|null, saldo_abertura } do tenant. */
export async function buscarConfigFinanceiro(db, tenantId) {
  const r = await db.query(
    `SELECT aliquota_imposto_pct,
            to_char(financeiro_data_corte, 'YYYY-MM-DD') AS data_corte,
            financeiro_saldo_abertura AS saldo_abertura
       FROM tenants WHERE id = $1::uuid`,
    [tenantId],
  )
  const row = r.rows[0] ?? {}
  return {
    aliquota_imposto_pct: row.aliquota_imposto_pct == null ? ALIQUOTA_IMPOSTO_PADRAO : Number(row.aliquota_imposto_pct),
    data_corte: row.data_corte ?? null,
    saldo_abertura: r2(row.saldo_abertura),
  }
}

/** PATCH parcial: qualquer subconjunto de { aliquota_imposto_pct, data_corte, saldo_abertura }. */
export async function atualizarConfigFinanceiro(db, tenantId, patch = {}) {
  const sets = []
  const params = [tenantId]
  if (patch.aliquota_imposto_pct !== undefined) {
    const n = Number(patch.aliquota_imposto_pct)
    if (!Number.isFinite(n) || n < 0 || n > 100) throw erro('aliquota_imposto_pct deve estar entre 0 e 100', 400, 'INVALID_CONFIG')
    params.push(r2(n))
    sets.push(`aliquota_imposto_pct = $${params.length}`)
  }
  if (patch.data_corte !== undefined) {
    if (patch.data_corte !== null && !dataValida(patch.data_corte)) throw erro('data_corte deve ser uma data AAAA-MM-DD válida', 400, 'INVALID_CONFIG')
    params.push(patch.data_corte)
    sets.push(`financeiro_data_corte = $${params.length}::date`)
  }
  if (patch.saldo_abertura !== undefined) {
    const n = Number(patch.saldo_abertura)
    if (!Number.isFinite(n) || Math.abs(n) >= 1e13) throw erro('saldo_abertura inválido', 400, 'INVALID_CONFIG')
    params.push(r2(n))
    sets.push(`financeiro_saldo_abertura = $${params.length}`)
  }
  if (sets.length) await db.query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $1::uuid`, params)
  return buscarConfigFinanceiro(db, tenantId)
}

// ─── Banco: imposto ───────────────────────────────────────────────────────

const IMPOSTO_COLS = `id, valor, valor_pago, observacao,
  to_char(competencia,'YYYY-MM-DD') AS competencia,
  to_char(data_vencimento,'YYYY-MM-DD') AS data_vencimento,
  to_char(data_pagamento,'YYYY-MM-DD') AS data_pagamento`

/**
 * Σ valor_pago das receitas operacionais (receita_titulos + receitas avulsas exceto
 * 'aporte') por mês de DATA DE PAGAMENTO. Com corte, só pagamentos >= data_corte.
 */
async function recebidoPorMes(db, { tenantId, mesInicio, mesFim, dataCorte = null }) {
  const { rows } = await db.query(
    `SELECT to_char(date_trunc('month', data_pagamento), 'YYYY-MM') AS mes, COALESCE(SUM(valor_pago), 0) AS total
       FROM (
         SELECT data_pagamento, valor_pago FROM receita_titulos
          WHERE tenant_id = $1::uuid AND valor_pago > 0 AND data_pagamento IS NOT NULL
            AND data_pagamento >= $2::date AND data_pagamento <= $3::date
            AND ($4::date IS NULL OR data_pagamento >= $4::date)
         UNION ALL
         SELECT data_pagamento, valor_pago FROM receitas_avulsas
          WHERE tenant_id = $1::uuid AND grupo <> 'aporte' AND valor_pago > 0 AND data_pagamento IS NOT NULL
            AND data_pagamento >= $2::date AND data_pagamento <= $3::date
            AND ($4::date IS NULL OR data_pagamento >= $4::date)
       ) rec
      GROUP BY 1`,
    [tenantId, `${mesInicio}-01`, ultimoDia(mesFim), dataCorte],
  )
  return new Map(rows.map((r) => [r.mes, r2(r.total)]))
}

async function impostosMaterializados(db, { tenantId, inicio, fim }) {
  const { rows } = await db.query(
    `SELECT ${IMPOSTO_COLS} FROM custos
      WHERE tenant_id = $1::uuid AND tipo = 'imposto'
        AND competencia >= $2::date AND competencia <= $3::date`,
    [tenantId, `${inicio}-01`, ultimoDia(fim)],
  )
  return new Map(rows.map((r) => [mesDe(r.competencia), r]))
}

/**
 * Cálculos de imposto para as competências [inicio, fim] (YYYY-MM).
 * `receitas` (opcional): itens de receita já carregados — usados na projeção
 * quando cobrem os meses de vencimento necessários.
 */
export async function calcularImpostos(db, { tenantId, inicio, fim, hoje = hojeSaoPaulo(), aliquota, dataCorte } = {}) {
  if (!tenantId) throw erro('tenantId é obrigatório', 400, 'INVALID_SCOPE')
  const mesAtual = hoje.slice(0, 7)
  let pct = aliquota
  let corte = dataCorte
  if (pct === undefined || corte === undefined) {
    const cfg = await buscarConfigFinanceiro(db, tenantId)
    pct ??= cfg.aliquota_imposto_pct
    if (corte === undefined) corte = cfg.data_corte
  }
  const baseIni = addMeses(inicio, -1)
  const baseFim = addMeses(fim, -1)
  const recebido = await recebidoPorMes(db, { tenantId, mesInicio: baseIni, mesFim: baseFim, dataCorte: corte })
  // Projeção só é necessária para meses-base não fechados (>= mês corrente).
  let previsto = new Map()
  if (baseFim >= mesAtual) {
    const projIni = baseIni > mesAtual ? baseIni : mesAtual
    // Vencimento = competência + offset (0|1) → competências a partir de projIni-1.
    const [titulos, avulsas] = await Promise.all([
      listarTitulosReceita(db, { tenantId, inicio: addMeses(projIni, -1), fim: baseFim, hoje }),
      listarReceitasAvulsas(db, { tenantId, inicio: addMeses(projIni, -1), fim: baseFim, hoje }),
    ])
    // Aporte não é base de imposto; corte vale também para a projeção.
    previsto = previstoReceitaPorVencimento(aplicarCorte([...titulos, ...avulsas.filter((a) => !ehAporte(a))], corte))
  }
  return mesesEntre(inicio, fim).map((mes) => calcularImpostoMes({
    mes,
    mesAtual,
    aliquota: pct,
    recebidoAnterior: recebido.get(addMeses(mes, -1)) ?? 0,
    previstoAnterior: previsto.get(addMeses(mes, -1)) ?? 0,
  }))
}

/** Lançamentos de imposto do período (omitidos quando valor 0 e sem baixa). */
export async function listarImpostos(db, { tenantId, inicio, fim, hoje = hojeSaoPaulo(), aliquota, dataCorte } = {}) {
  const [calculos, mats] = await Promise.all([
    calcularImpostos(db, { tenantId, inicio, fim, hoje, aliquota, dataCorte }),
    impostosMaterializados(db, { tenantId, inicio, fim }),
  ])
  return calculos
    .map((c) => ({ calculo: c, materializado: mats.get(c.mes) ?? null }))
    .filter(({ calculo, materializado }) => materializado || calculo.valor > 0)
    .map(({ calculo, materializado }) => montarItemImposto({ calculo, materializado, hoje }))
}

async function itemImpostoDoMes(db, { tenantId, mes, hoje }) {
  const [calculo] = await calcularImpostos(db, { tenantId, inicio: mes, fim: mes, hoje })
  const mats = await impostosMaterializados(db, { tenantId, inicio: mes, fim: mes })
  return montarItemImposto({ calculo, materializado: mats.get(mes) ?? null, hoje })
}

/**
 * Baixa do imposto da competência `mes`: materializa (upsert) a linha em `custos`
 * com o valor previsto calculado agora; valor_pago default = previsto; data default = hoje.
 */
export async function pagarImposto(db, { tenantId, mes, valorPago, dataPagamento, observacao, hoje = hojeSaoPaulo() } = {}) {
  if (!RE_MES.test(String(mes ?? ''))) throw erro('mes deve estar no formato AAAA-MM')
  if (dataPagamento != null && !RE_DATA.test(String(dataPagamento))) throw erro('data_pagamento deve estar no formato AAAA-MM-DD', 400, 'INVALID_PAYMENT')
  const [calculo] = await calcularImpostos(db, { tenantId, inicio: mes, fim: mes, hoje })
  const pago = valorPago == null ? calculo.valor : r2(valorPago)
  if (!(pago > 0)) throw erro('valor_pago deve ser maior que zero (imposto calculado é zero)', 400, 'INVALID_PAYMENT')
  const previsto = calculo.valor > 0 ? calculo.valor : pago
  const obs = observacao ?? `Base ${calculo.mes_base} (${calculo.base_tipo}): ${calculo.base.toFixed(2)} × ${calculo.aliquota}%`
  await db.query(
    `INSERT INTO custos (tenant_id, descricao, valor, tipo, grupo, competencia, data_vencimento,
                         valor_pago, data_pagamento, observacao)
     VALUES ($1::uuid, $2, $3, 'imposto', 'outros', $4::date, $5::date, $6, $7::date, $8)
     ON CONFLICT (tenant_id, competencia) WHERE tipo = 'imposto'
     DO UPDATE SET valor_pago = EXCLUDED.valor_pago, data_pagamento = EXCLUDED.data_pagamento,
                   observacao = COALESCE($8, custos.observacao), atualizado_em = NOW()`,
    [tenantId, `Imposto ${mes.slice(5)}/${mes.slice(0, 4)}`, previsto, `${mes}-01`, vencimentoImposto(mes),
      pago, dataPagamento ?? hoje, obs],
  )
  return itemImpostoDoMes(db, { tenantId, mes, hoje })
}

/** Desfaz a baixa: remove a linha materializada (o imposto volta a ser calculado). */
export async function desfazerImposto(db, { tenantId, mes, hoje = hojeSaoPaulo() } = {}) {
  if (!RE_MES.test(String(mes ?? ''))) throw erro('mes deve estar no formato AAAA-MM')
  const r = await db.query(
    `DELETE FROM custos WHERE tenant_id = $1::uuid AND tipo = 'imposto' AND competencia = $2::date RETURNING id`,
    [tenantId, `${mes}-01`],
  )
  if (!r.rows[0]) throw erro('Imposto sem baixa registrada', 404, 'IMPOSTO_NOT_FOUND')
  return itemImpostoDoMes(db, { tenantId, mes, hoje })
}

// ─── Banco: lançamentos unificados ────────────────────────────────────────

/**
 * Todos os lançamentos das competências [inicio, fim] (YYYY-MM), já normalizados
 * e ordenados por vencimento: receitas (marcas + avulsas) + custos + apresentadoras
 * + imposto, com a regra de corte aplicada (dataCorte undefined → lida da config).
 */
export async function listarLancamentos(db, { tenantId, inicio, fim, hoje = hojeSaoPaulo(), aliquota, dataCorte } = {}) {
  if (!tenantId) throw erro('tenantId é obrigatório', 400, 'INVALID_SCOPE')
  let pct = aliquota
  let corte = dataCorte
  if (pct === undefined || corte === undefined) {
    const cfg = await buscarConfigFinanceiro(db, tenantId)
    pct ??= cfg.aliquota_imposto_pct
    if (corte === undefined) corte = cfg.data_corte
  }
  const [receitas, avulsas, custos, apresentadoras, impostos] = await Promise.all([
    listarTitulosReceita(db, { tenantId, inicio, fim, hoje }),
    listarReceitasAvulsas(db, { tenantId, inicio, fim, hoje }),
    listarCustos(db, { tenantId, inicio, fim, hoje }),
    listarPagamentosApresentadoras(db, { tenantId, inicio: `${inicio}-01`, fim: `${fim}-01`, hoje }),
    listarImpostos(db, { tenantId, inicio, fim, hoje, aliquota: pct, dataCorte: corte }),
  ])
  return ordenarLancamentos(aplicarCorte([
    ...receitas.map((t) => normalizarReceita(t, hoje)),
    ...avulsas.map((a) => ({ ...BASE_ITEM, ...a })),
    // imposto materializado em `custos` sai daqui e entra como lançamento próprio
    ...custos.filter((c) => c.tipo !== 'imposto').map((c) => normalizarCusto(c, hoje)),
    ...apresentadoras.map((p) => normalizarApresentadora(p, hoje)),
    ...impostos,
  ], corte))
}

/** GET /lancamentos: itens filtrados + totais (dos itens filtrados). */
export async function consultarLancamentos(db, { tenantId, inicio, fim, hoje = hojeSaoPaulo(), filtros = {} } = {}) {
  const itens = filtrarLancamentos(await listarLancamentos(db, { tenantId, inicio, fim, hoje }), filtros)
  return { inicio, fim, hoje, itens, totais: totalizarLancamentos(itens) }
}

/** DRE mensal previsto × realizado para [inicio, fim]. */
export async function calcularDre(db, { tenantId, inicio, fim, hoje = hojeSaoPaulo() } = {}) {
  const { aliquota_imposto_pct: aliquota, data_corte: dataCorte } = await buscarConfigFinanceiro(db, tenantId)
  const itens = await listarLancamentos(db, { tenantId, inicio, fim, hoje, aliquota, dataCorte })
  const impostos = new Map(itens.filter((i) => i.origem === 'imposto')
    .map((i) => [mesDe(i.competencia), { aliquota: i.aliquota, base: i.base }]))
  return { inicio, fim, aliquota, data_corte: dataCorte, ...montarDre({ meses: mesesEntre(inicio, fim), itens, impostos, aliquota }) }
}

/**
 * Fluxo de caixa do mês + série anual. Carrega as competências de nov/(ano-1)
 * a dez/ano (vencimentos com offset de até 1 mês caem dentro do ano).
 */
export async function calcularFluxoCaixa(db, { tenantId, mes, saldoInicial, hoje = hojeSaoPaulo() } = {}) {
  if (!RE_MES.test(String(mes ?? ''))) throw erro('mes deve estar no formato AAAA-MM')
  const ano = mes.slice(0, 4)
  const cfg = await buscarConfigFinanceiro(db, tenantId)
  const itens = await listarLancamentos(db, {
    tenantId, inicio: addMeses(`${ano}-01`, -2), fim: `${ano}-12`, hoje,
    aliquota: cfg.aliquota_imposto_pct, dataCorte: cfg.data_corte,
  })
  let saldo = saldoInicial
  let origem = 'informado'
  if (saldo == null) {
    if (!cfg.data_corte) {
      saldo = 0
      origem = 'padrao'
    } else {
      saldo = await saldoCaixaInicioMes(db, { tenantId, mes, config: cfg })
      origem = 'caixa'
    }
  }
  return { ...montarFluxoCaixa({ mes, itens, saldoInicial: saldo, saldoInicialOrigem: origem }), data_corte: cfg.data_corte }
}

// ─── Caixa (saldo de abertura + realizado desde o corte) ──────────────────

/**
 * Realizado (Σ valor_pago) com data_pagamento em [de, ate] (inclusive), direto das
 * tabelas de baixa — itens virtuais nunca têm pagamento. Tenant explícito.
 */
export async function realizadoEntre(db, { tenantId, de, ate }) {
  const zero = { receitas: 0, avulsas: 0, aportes: 0, custos: 0, apresentadoras: 0, imposto: 0, entradas: 0, saidas: 0 }
  if (!de || !ate || ate < de) return zero
  const { rows } = await db.query(
    `SELECT
       (SELECT COALESCE(SUM(valor_pago), 0) FROM receita_titulos
         WHERE tenant_id = $1::uuid AND valor_pago > 0 AND data_pagamento BETWEEN $2::date AND $3::date) AS receitas,
       (SELECT COALESCE(SUM(valor_pago) FILTER (WHERE grupo <> 'aporte'), 0) FROM receitas_avulsas
         WHERE tenant_id = $1::uuid AND valor_pago > 0 AND data_pagamento BETWEEN $2::date AND $3::date) AS avulsas,
       (SELECT COALESCE(SUM(valor_pago) FILTER (WHERE grupo = 'aporte'), 0) FROM receitas_avulsas
         WHERE tenant_id = $1::uuid AND valor_pago > 0 AND data_pagamento BETWEEN $2::date AND $3::date) AS aportes,
       (SELECT COALESCE(SUM(valor_pago) FILTER (WHERE tipo IS DISTINCT FROM 'imposto'), 0) FROM custos
         WHERE tenant_id = $1::uuid AND valor_pago > 0 AND data_pagamento BETWEEN $2::date AND $3::date) AS custos,
       (SELECT COALESCE(SUM(valor_pago) FILTER (WHERE tipo = 'imposto'), 0) FROM custos
         WHERE tenant_id = $1::uuid AND valor_pago > 0 AND data_pagamento BETWEEN $2::date AND $3::date) AS imposto,
       (SELECT COALESCE(SUM(valor_pago), 0) FROM apresentadora_pagamentos
         WHERE tenant_id = $1::uuid AND valor_pago > 0 AND data_pagamento BETWEEN $2::date AND $3::date) AS apresentadoras`,
    [tenantId, de, ate],
  )
  const r = rows[0] ?? {}
  const out = Object.fromEntries(Object.keys(zero).map((k) => [k, r2(r[k])]))
  out.entradas = r2(out.receitas + out.avulsas + out.aportes)
  out.saidas = r2(out.custos + out.apresentadoras + out.imposto)
  return out
}

/** Saldo de caixa no INÍCIO de `mes` (antes do dia 1): abertura + realizado [corte, dia anterior]. Mês < corte → 0. */
export async function saldoCaixaInicioMes(db, { tenantId, mes, config }) {
  const cfg = config ?? await buscarConfigFinanceiro(db, tenantId)
  if (!cfg.data_corte) return 0
  if (mes < mesDe(cfg.data_corte)) return 0
  const real = await realizadoEntre(db, { tenantId, de: cfg.data_corte, ate: diaAnterior(`${mes}-01`) })
  return r2(cfg.saldo_abertura + real.entradas - real.saidas)
}

/**
 * Pura: em aberto (previsto − pago) de receitas e custos com vencimento em
 * [dataCorte, fimMes]. Itens já passaram pela regra de corte.
 */
export function abertosAte(itens, { dataCorte, fimMes }) {
  const out = { a_receber: 0, a_pagar: 0 }
  for (const i of itens) {
    const venc = vencimentoEfetivo(i)
    if (!venc || venc < dataCorte || venc > fimMes) continue
    const aberto = emAberto(i)
    if (!(aberto > 0)) continue
    if (i.natureza === 'receita') out.a_receber += aberto
    else out.a_pagar += aberto
  }
  return { a_receber: r2(out.a_receber), a_pagar: r2(out.a_pagar) }
}

/** Pura: monta o contrato de GET /caixa a partir dos agregados. */
export function montarCaixa({ config, ate, fimMes, realizado, realizadoPosAte, abertos }) {
  if (!config?.data_corte) {
    return {
      configurado: false, data_corte: null, saldo_abertura: 0, ate, fim_mes: fimMes,
      entradas_realizadas: 0, saidas_realizadas: 0, saldo_atual: 0, a_receber: 0, a_pagar: 0, saldo_projetado_fim_mes: 0,
      detalhe: { entradas: { receitas: 0, avulsas: 0, aportes: 0 }, saidas: { custos: 0, apresentadoras: 0, imposto: 0 } },
    }
  }
  const abertura = r2(config.saldo_abertura)
  const saldoAtual = r2(abertura + realizado.entradas - realizado.saidas)
  const pos = realizadoPosAte ?? { entradas: 0, saidas: 0 }
  return {
    configurado: true,
    data_corte: config.data_corte,
    saldo_abertura: abertura,
    ate,
    fim_mes: fimMes,
    entradas_realizadas: r2(realizado.entradas),
    saidas_realizadas: r2(realizado.saidas),
    saldo_atual: saldoAtual,
    a_receber: abertos.a_receber,
    a_pagar: abertos.a_pagar,
    saldo_projetado_fim_mes: r2(saldoAtual + pos.entradas - pos.saidas + abertos.a_receber - abertos.a_pagar),
    detalhe: {
      entradas: { receitas: realizado.receitas, avulsas: realizado.avulsas, aportes: realizado.aportes },
      saidas: { custos: realizado.custos, apresentadoras: realizado.apresentadoras, imposto: realizado.imposto },
    },
  }
}

/**
 * GET /caixa: saldo_atual = abertura + entradas − saídas realizadas em [corte, ate];
 * a_receber/a_pagar = em aberto com vencimento em [corte, fim do mês de `ate`];
 * saldo_projetado_fim_mes = saldo_atual + realizado (ate, fim do mês] + a_receber − a_pagar.
 */
export async function calcularCaixa(db, { tenantId, ate, hoje = hojeSaoPaulo() } = {}) {
  if (!tenantId) throw erro('tenantId é obrigatório', 400, 'INVALID_SCOPE')
  const dataAte = ate ?? hoje
  if (!dataValida(dataAte)) throw erro('ate deve ser uma data AAAA-MM-DD válida')
  const fimMes = ultimoDia(mesDe(dataAte))
  const config = await buscarConfigFinanceiro(db, tenantId)
  if (!config.data_corte) return montarCaixa({ config, ate: dataAte, fimMes })
  const corte = config.data_corte
  const mesIni = addMeses(mesDe(corte), -2) // vencimento = competência + até 1 mês (+ folga)
  const mesFim = mesDe(fimMes)
  const [realizado, realizadoPosAte, itens] = await Promise.all([
    realizadoEntre(db, { tenantId, de: corte, ate: dataAte }),
    realizadoEntre(db, { tenantId, de: dataAte >= corte ? diaSeguinte(dataAte) : corte, ate: fimMes }),
    mesFim >= mesIni
      ? listarLancamentos(db, { tenantId, inicio: mesIni, fim: mesFim, hoje, aliquota: config.aliquota_imposto_pct, dataCorte: corte })
      : [],
  ])
  return montarCaixa({ config, ate: dataAte, fimMes, realizado, realizadoPosAte, abertos: abertosAte(itens, { dataCorte: corte, fimMes }) })
}

function diaSeguinte(d) {
  const [y, m, dia] = String(d).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, dia + 1)).toISOString().slice(0, 10)
}
