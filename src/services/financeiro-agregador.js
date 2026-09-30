// Agregador do financeiro (onda 2): une receitas do comercial, custos manuais,
// pagamentos de apresentadoras e imposto num contrato ÚNICO de lançamentos, e
// deriva DRE mensal e fluxo de caixa a partir dele.
//
// Fontes (NÃO reimplementar regra aqui):
//   receitas       → listarTitulosReceita         (services/receitas-comercial.js)
//   custos         → listarCustos                 (services/custos-plano.js)
//   apresentadoras → listarPagamentosApresentadoras (services/apresentadoras-pagamentos.js)
//   imposto        → calculado aqui (base = recebido em M-1) + baixa materializada em
//                    `custos` (tipo 'imposto', 1 por tenant × competência, migration 167)
//
// Status é SEMPRE derivado (lib/lancamento-status.js). Datas trafegam como strings
// 'YYYY-MM-DD' / 'YYYY-MM' — sem Date, para não haver bug de fuso.
// Funções puras exportadas para teste; as que tocam o banco recebem `db` e
// `tenantId` explícito (além do RLS).

import { statusLancamento } from '../lib/lancamento-status.js'
import { hojeSaoPaulo, listarTitulosReceita } from './receitas-comercial.js'
import { addMeses, diasNoMes, listarCustos, mesesEntre, ultimoDia } from './custos-plano.js'
import { listarPagamentosApresentadoras } from './apresentadoras-pagamentos.js'

export { hojeSaoPaulo }

export const ALIQUOTA_IMPOSTO_PADRAO = 10
export const IMPOSTO_DIA_VENCIMENTO = 20
export const FLUXO_DIAS = [5, 10, 15, 20, 25, 30]
export const FLUXO_CHAVES = [...FLUXO_DIAS.map(String), 'cartao']
export const MAX_MESES_AGREGADOR = 36

const RE_MES = /^(\d{4})-(0[1-9]|1[0-2])$/
const RE_MES_OU_DATA = /^(\d{4}-(?:0[1-9]|1[0-2]))(?:-\d{2})?$/
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/

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
  for (const i of itens) {
    const n = t[i.natureza]
    if (!n) continue
    n.previsto += Number(i.valor_previsto) || 0
    n.pago += Number(i.valor_pago) || 0
    if (i.status === 'atrasado') n.atrasado += emAberto(i)
    else if (i.status !== 'pago') n.pendente += emAberto(i)
  }
  for (const n of [t.receita, t.custo]) for (const k of Object.keys(n)) n[k] = r2(n[k])
  return {
    ...t,
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
 */
export function montarDre({ meses, itens, impostos = new Map(), aliquota = ALIQUOTA_IMPOSTO_PADRAO }) {
  const porMes = new Map(meses.map((m) => [m, {
    mes: m, receita: pr(), custos: { ...pr(), por_grupo: {} }, apresentadoras: pr(),
    imposto: { ...pr(), aliquota: impostos.get(m)?.aliquota ?? Number(aliquota), base: impostos.get(m)?.base ?? 0 },
  }]))
  for (const i of itens) {
    const linha = porMes.get(mesDe(i.competencia))
    if (!linha) continue
    if (i.natureza === 'receita') addPr(linha.receita, i)
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
      custos: { ...roundPr(l.custos), por_grupo: porGrupo },
      apresentadoras: roundPr(l.apresentadoras),
      imposto: { ...roundPr(l.imposto), aliquota: l.imposto.aliquota, base: r2(l.imposto.base) },
    }
    out.resultado = { previsto: resultado(out, 'previsto'), realizado: resultado(out, 'realizado') }
    return out
  }
  const linhas = meses.map((m) => ({ mes: m, ...fechar(porMes.get(m)) }))
  const tot = {
    receita: pr(), custos: { ...pr(), por_grupo: {} }, apresentadoras: pr(),
    imposto: { ...pr(), aliquota: Number(aliquota), base: 0 },
  }
  for (const l of linhas) {
    for (const k of ['previsto', 'realizado']) {
      tot.receita[k] += l.receita[k]
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
export function montarFluxoCaixa({ mes, itens, saldoInicial = 0 }) {
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

export async function buscarConfigFinanceiro(db, tenantId) {
  const r = await db.query('SELECT aliquota_imposto_pct FROM tenants WHERE id = $1::uuid', [tenantId])
  const v = r.rows[0]?.aliquota_imposto_pct
  return { aliquota_imposto_pct: v == null ? ALIQUOTA_IMPOSTO_PADRAO : Number(v) }
}

export async function atualizarConfigFinanceiro(db, tenantId, { aliquota_imposto_pct: aliquota }) {
  const n = Number(aliquota)
  if (!Number.isFinite(n) || n < 0 || n > 100) throw erro('aliquota_imposto_pct deve estar entre 0 e 100', 400, 'INVALID_CONFIG')
  await db.query('UPDATE tenants SET aliquota_imposto_pct = $2 WHERE id = $1::uuid', [tenantId, r2(n)])
  return buscarConfigFinanceiro(db, tenantId)
}

// ─── Banco: imposto ───────────────────────────────────────────────────────

const IMPOSTO_COLS = `id, valor, valor_pago, observacao,
  to_char(competencia,'YYYY-MM-DD') AS competencia,
  to_char(data_vencimento,'YYYY-MM-DD') AS data_vencimento,
  to_char(data_pagamento,'YYYY-MM-DD') AS data_pagamento`

/** Σ valor_pago das receitas (receita_titulos) por mês de DATA DE PAGAMENTO. */
async function recebidoPorMes(db, { tenantId, mesInicio, mesFim }) {
  const { rows } = await db.query(
    `SELECT to_char(date_trunc('month', data_pagamento), 'YYYY-MM') AS mes, COALESCE(SUM(valor_pago), 0) AS total
       FROM receita_titulos
      WHERE tenant_id = $1::uuid AND valor_pago > 0 AND data_pagamento IS NOT NULL
        AND data_pagamento >= $2::date AND data_pagamento <= $3::date
      GROUP BY 1`,
    [tenantId, `${mesInicio}-01`, ultimoDia(mesFim)],
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
export async function calcularImpostos(db, { tenantId, inicio, fim, hoje = hojeSaoPaulo(), aliquota } = {}) {
  if (!tenantId) throw erro('tenantId é obrigatório', 400, 'INVALID_SCOPE')
  const mesAtual = hoje.slice(0, 7)
  const pct = aliquota ?? (await buscarConfigFinanceiro(db, tenantId)).aliquota_imposto_pct
  const baseIni = addMeses(inicio, -1)
  const baseFim = addMeses(fim, -1)
  const recebido = await recebidoPorMes(db, { tenantId, mesInicio: baseIni, mesFim: baseFim })
  // Projeção só é necessária para meses-base não fechados (>= mês corrente).
  let previsto = new Map()
  if (baseFim >= mesAtual) {
    const projIni = baseIni > mesAtual ? baseIni : mesAtual
    // Vencimento = competência + offset (0|1) → competências a partir de projIni-1.
    const titulos = await listarTitulosReceita(db, { tenantId, inicio: addMeses(projIni, -1), fim: baseFim, hoje })
    previsto = previstoReceitaPorVencimento(titulos)
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
export async function listarImpostos(db, { tenantId, inicio, fim, hoje = hojeSaoPaulo(), aliquota } = {}) {
  const [calculos, mats] = await Promise.all([
    calcularImpostos(db, { tenantId, inicio, fim, hoje, aliquota }),
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
 * e ordenados por vencimento: receitas + custos + apresentadoras + imposto.
 */
export async function listarLancamentos(db, { tenantId, inicio, fim, hoje = hojeSaoPaulo(), aliquota } = {}) {
  if (!tenantId) throw erro('tenantId é obrigatório', 400, 'INVALID_SCOPE')
  const [receitas, custos, apresentadoras, impostos] = await Promise.all([
    listarTitulosReceita(db, { tenantId, inicio, fim, hoje }),
    listarCustos(db, { tenantId, inicio, fim, hoje }),
    listarPagamentosApresentadoras(db, { tenantId, inicio: `${inicio}-01`, fim: `${fim}-01`, hoje }),
    listarImpostos(db, { tenantId, inicio, fim, hoje, aliquota }),
  ])
  return ordenarLancamentos([
    ...receitas.map((t) => normalizarReceita(t, hoje)),
    // imposto materializado em `custos` sai daqui e entra como lançamento próprio
    ...custos.filter((c) => c.tipo !== 'imposto').map((c) => normalizarCusto(c, hoje)),
    ...apresentadoras.map((p) => normalizarApresentadora(p, hoje)),
    ...impostos,
  ])
}

/** GET /lancamentos: itens filtrados + totais (dos itens filtrados). */
export async function consultarLancamentos(db, { tenantId, inicio, fim, hoje = hojeSaoPaulo(), filtros = {} } = {}) {
  const itens = filtrarLancamentos(await listarLancamentos(db, { tenantId, inicio, fim, hoje }), filtros)
  return { inicio, fim, hoje, itens, totais: totalizarLancamentos(itens) }
}

/** DRE mensal previsto × realizado para [inicio, fim]. */
export async function calcularDre(db, { tenantId, inicio, fim, hoje = hojeSaoPaulo() } = {}) {
  const { aliquota_imposto_pct: aliquota } = await buscarConfigFinanceiro(db, tenantId)
  const itens = await listarLancamentos(db, { tenantId, inicio, fim, hoje, aliquota })
  const impostos = new Map(itens.filter((i) => i.origem === 'imposto')
    .map((i) => [mesDe(i.competencia), { aliquota: i.aliquota, base: i.base }]))
  return { inicio, fim, aliquota, ...montarDre({ meses: mesesEntre(inicio, fim), itens, impostos, aliquota }) }
}

/**
 * Fluxo de caixa do mês + série anual. Carrega as competências de nov/(ano-1)
 * a dez/ano (vencimentos com offset de até 1 mês caem dentro do ano).
 */
export async function calcularFluxoCaixa(db, { tenantId, mes, saldoInicial = 0, hoje = hojeSaoPaulo() } = {}) {
  if (!RE_MES.test(String(mes ?? ''))) throw erro('mes deve estar no formato AAAA-MM')
  const ano = mes.slice(0, 4)
  const itens = await listarLancamentos(db, { tenantId, inicio: addMeses(`${ano}-01`, -2), fim: `${ano}-12`, hoje })
  return montarFluxoCaixa({ mes, itens, saldoInicial })
}
