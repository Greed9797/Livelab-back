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
// Perdas/cancelamentos (migration 173): receita PERDIDA (perdido_em) e custo CANCELADO
// (cancelado_em) encerram o SALDO em aberto (previsto − pago); valor_pago fica preservado.
// Encerrado sai de pendente/atrasado/a receber/a pagar, do previsto do fluxo, da projeção
// do imposto e dos candidatos da conciliação. DRE: receita.previsto NÃO muda (linha
// `perdas.receita` à parte, descontada do resultado previsto); custos previstos excluem o
// saldo cancelado. Realizado nunca muda. Ver encerrado()/valorEncerrado()/previstoEfetivo().
//
// Status é SEMPRE derivado (lib/lancamento-status.js). Datas trafegam como strings
// 'YYYY-MM-DD' / 'YYYY-MM' — sem Date, para não haver bug de fuso.
// Funções puras exportadas para teste; as que tocam o banco recebem `db` e
// `tenantId` explícito (além do RLS).

import { encerrado, normalizarMotivo, saldoAberto, statusLancamento, timestampIso, valorEncerrado } from '../lib/lancamento-status.js'
import { centsToExactMoney, exactMoneyToCents } from '../lib/money.js'
import { randomUUID } from 'node:crypto'
import { hojeSaoPaulo, listarTitulosReceita } from './receitas-comercial.js'
import { registrarEstorno, registrarLiquidacao } from './financeiro-liquidacoes-command.js'
import { addMeses, diasNoMes, listarCustos, mesesEntre, ultimoDia } from './custos-plano.js'
import { listarPagamentosApresentadoras } from './apresentadoras-pagamentos.js'
import { ehAporte, listarReceitasAvulsas } from './receitas-avulsas.js'
import { CLASSES_CUSTO, classeDoItem } from '../lib/custo-classe.js'
import { lerMovimentosFinanceirosPeriodo } from './financeiro-movimentos-periodo.js'
import { esperarLeiturasFinanceiras } from './financeiro-read-snapshot.js'

export { CLASSES_CUSTO, classeDoItem, hojeSaoPaulo }

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
  parcela_num: null, parcelas_total: null, observacao: null, virtual: false, classe: null,
  perdido_em: null, perdido_motivo: null, cancelado_em: null, cancelado_motivo: null,
}

// ─── Perdas e cancelamentos (encerramento do saldo) ───────────────────────

export { encerrado, valorEncerrado }

/** Previsto que ainda conta: valor_previsto menos perda/cancelamento. */
export function previstoEfetivo(i) {
  return r2(r2(i?.valor_previsto) - valorEncerrado(i))
}

/** Garante os campos de perda/cancelamento e o status derivado 'perdido'|'cancelado'. */
export function marcarEncerramento(item) {
  if (item.suspensao_comercial?.ativa) return { ...item, status: 'cancelado' }
  for (const k of ['perdido_em', 'perdido_motivo', 'cancelado_em', 'cancelado_motivo']) item[k] ??= null
  if (encerrado(item)) item.status = item.natureza === 'custo' ? 'cancelado' : 'perdido'
  return item
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
  return marcarEncerramento(item)
}

/** Custo (listarCustos) → item comum (valor_pago numérico). */
export function normalizarCusto(c, hoje) {
  const item = { ...BASE_ITEM, ...c, natureza: 'custo', valor_previsto: r2(c.valor_previsto), valor_pago: r2(c.valor_pago) }
  item.classe = classeDoItem(item)
  item.status = statusLancamento(item, hoje)
  return marcarEncerramento(item)
}

/**
 * Pagamento de apresentadora → item comum (grupo 'apresentadoras'). Contrato v3: um item
 * por pessoa × mês × `componente` ('fixo' | 'variavel'); item sem componente (contrato
 * antigo, total único) é tratado como 'variavel'.
 */
export function normalizarApresentadora(p, hoje) {
  const item = {
    ...BASE_ITEM,
    ...p,
    natureza: 'custo',
    origem: 'apresentadora',
    grupo: 'apresentadoras',
    componente: p.componente === 'fixo' || p.componente === 'variavel' ? p.componente : null,
    valor_previsto: r2(p.valor_previsto),
    valor_pago: r2(p.valor_pago),
    virtual: !(Number(p.valor_pago) > 0) && !p.cancelado_em,
    cancelado_em: timestampIso(p.cancelado_em),
    cancelado_motivo: p.cancelado_motivo ?? null,
  }
  item.classe = classeDoItem(item)
  item.status = statusLancamento(item, hoje)
  return marcarEncerramento(item)
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
    data_vencimento: materializado ? materializado.data_vencimento : vencimentoImposto(mes),
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
    classe: 'variavel',
    cancelado_em: timestampIso(materializado?.cancelado_em),
    cancelado_motivo: materializado?.cancelado_motivo ?? null,
    cancelado_por: materializado?.cancelado_por ?? null,
  }
  item.status = statusLancamento(item, hoje)
  return marcarEncerramento(item)
}

/** Σ previsto das receitas por mês de VENCIMENTO (perdidas contam só o que foi pago). */
export function previstoReceitaPorVencimento(receitas) {
  const out = new Map()
  for (const r of receitas) {
    const m = mesDe(r.data_vencimento)
    if (m) out.set(m, r2((out.get(m) ?? 0) + previstoEfetivo(r)))
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

export function filtrarLancamentos(itens, { natureza, status, grupo, classe, origem, q } = {}) {
  const busca = q ? normTxt(q).trim() : ''
  return itens.filter((i) => (
    (!natureza || i.natureza === natureza)
    && (!status || i.status === status)
    && (!grupo || i.grupo === grupo)
    && (!classe || i.classe === classe)
    && (!origem || i.origem === origem)
    && (!busca || normTxt([i.descricao, i.marca_nome, i.cliente_nome, i.observacao, i.grupo].join(' ')).includes(busca))
  ))
}

/** Em aberto após pagamento e perda/cancelamento, inclusive parcial. */
const emAberto = saldoAberto

/**
 * Totais por natureza: previsto (Σ valor_previsto), pago (Σ valor_pago),
 * atrasado (em aberto dos atrasados), pendente (em aberto dos demais não pagos).
 * receita.perdido / custo.cancelado = saldo encerrado (previsto − pago) dos itens
 * perdidos/cancelados — fora de pendente/atrasado. saldo_previsto desconta ambos.
 */
export function totalizarLancamentos(itens) {
  const zero = () => ({ previsto: 0, pago: 0, atrasado: 0, pendente: 0 })
  const t = { receita: { ...zero(), perdido: 0 }, custo: { ...zero(), cancelado: 0 } }
  const aportes = { previsto: 0, pago: 0 }
  for (const i of itens) {
    const n = t[i.natureza]
    if (!n) continue
    if (ehAporte(i)) {
      // previsto EFETIVO: o saldo de um aporte perdido já sai em receita.perdido (não subtrair 2x)
      aportes.previsto += previstoEfetivo(i)
      aportes.pago += Number(i.valor_pago) || 0
    }
    n.previsto += Number(i.valor_previsto) || 0
    n.pago += Number(i.valor_pago) || 0
    n[i.natureza === 'receita' ? 'perdido' : 'cancelado'] += valorEncerrado(i)
    if (i.status === 'atrasado') n.atrasado += emAberto(i)
    else if (i.status !== 'pago') n.pendente += emAberto(i)
  }
  for (const n of [t.receita, t.custo]) for (const k of Object.keys(n)) n[k] = r2(n[k])
  return {
    ...t,
    // aportes (receitas avulsas do grupo 'aporte') já estão em receita; aqui à parte.
    aportes: { previsto: r2(aportes.previsto), pago: r2(aportes.pago) },
    // Mesma conta do DRE (resultado): aporte é entrada de caixa, fora da receita operacional.
    saldo_previsto: r2((t.receita.previsto - t.receita.perdido - aportes.previsto) - (t.custo.previsto - t.custo.cancelado)),
    saldo_realizado: r2((t.receita.pago - aportes.pago) - t.custo.pago),
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
// Custo: previsto sem o saldo cancelado (cancelado sem pagamento sai do previsto).
const addPrCusto = (alvo, i) => {
  alvo.previsto += previstoEfetivo(i)
  alvo.realizado += Number(i.valor_pago) || 0
}
const roundPr = (o) => ({ previsto: r2(o.previsto), realizado: r2(o.realizado) })

/**
 * DRE mensal por COMPETÊNCIA: previsto = Σ valor_previsto; realizado = Σ valor_pago.
 * Visão por CLASSE (v3): custos_fixos / custos_variaveis (classeDoItem; imposto e
 * apresentadora-variável dentro de variáveis) e resultado = receita − custos_fixos −
 * custos_variaveis. Chaves legadas mantidas (mesmo resultado): custos (exclui
 * apresentadoras e imposto), apresentadoras, imposto. `impostos` = Map mes → { aliquota, base }.
 * Aportes (receita avulsa grupo 'aporte') NÃO são receita operacional: linha
 * `aportes` informativa, fora do resultado.
 * Perdas: receita.previsto inalterado; `perdas.receita.valor` contém perdas legadas
 * na competência e eventos FIN-02 no mês de registro; custos excluem o saldo
 * cancelado do previsto. resultado.previsto = receita − perdas − custos_fixos −
 * custos_variaveis; resultado.realizado inalterado.
 */
export function montarDre({ meses, itens, eventosPerda = [], impostos = new Map(), aliquota = ALIQUOTA_IMPOSTO_PADRAO }) {
  const porMes = new Map(meses.map((m) => [m, {
    mes: m, receita: pr(), aportes: pr(), custos: { ...pr(), por_grupo: {} }, apresentadoras: pr(),
    imposto: { ...pr(), aliquota: impostos.get(m)?.aliquota ?? Number(aliquota), base: impostos.get(m)?.base ?? 0 },
    custos_fixos: pr(), custos_variaveis: pr(), perdas: { receita: { valor: 0 } },
  }]))
  for (const i of itens) {
    const linha = porMes.get(mesDe(i.competencia))
    if (!linha) continue
    if (ehAporte(i)) addPr(linha.aportes, i)
    else if (i.natureza === 'receita') {
      addPr(linha.receita, i)
      // valor_perdido não nulo identifica uma projeção FIN-02. A trilha de
      // eventos determina o mês do efeito; só o legado fica na competência.
      // Isso independe da ordem das duas consultas quando ocorre escrita concorrente.
      if (i.perda_dre != null) linha.perdas.receita.valor += i.perda_dre
      else if (i.valor_perdido == null) linha.perdas.receita.valor += valorEncerrado(i)
    } else {
      addPrCusto((i.classe ?? classeDoItem(i)) === 'fixo' ? linha.custos_fixos : linha.custos_variaveis, i)
      if (i.origem === 'apresentadora') addPrCusto(linha.apresentadoras, i)
      else if (i.origem === 'imposto') addPrCusto(linha.imposto, i)
      else {
        addPrCusto(linha.custos, i)
        const g = i.grupo || 'outros'
        linha.custos.por_grupo[g] ??= pr()
        addPrCusto(linha.custos.por_grupo[g], i)
      }
    }
  }
  for (const evento of eventosPerda) {
    const linha = porMes.get(evento.mes_registro)
    if (!linha) continue
    const valor = Number(evento.valor) || 0
    linha.perdas.receita.valor += evento.tipo === 'reversao' ? -valor : valor
  }
  const resultado = (l, k) => r2(l.receita[k] - (k === 'previsto' ? l.perdas.receita.valor : 0)
    - l.custos_fixos[k] - l.custos_variaveis[k])
  const fechar = (l) => {
    const porGrupo = Object.fromEntries(Object.entries(l.custos.por_grupo).map(([g, v]) => [g, roundPr(v)]))
    const out = {
      receita: roundPr(l.receita),
      aportes: roundPr(l.aportes),
      custos: { ...roundPr(l.custos), por_grupo: porGrupo },
      apresentadoras: roundPr(l.apresentadoras),
      imposto: { ...roundPr(l.imposto), aliquota: l.imposto.aliquota, base: r2(l.imposto.base) },
      custos_fixos: roundPr(l.custos_fixos),
      custos_variaveis: roundPr(l.custos_variaveis),
      perdas: { receita: { valor: r2(l.perdas.receita.valor) } },
    }
    out.resultado = { previsto: resultado(out, 'previsto'), realizado: resultado(out, 'realizado') }
    return out
  }
  const linhas = meses.map((m) => ({ mes: m, ...fechar(porMes.get(m)) }))
  const tot = {
    receita: pr(), aportes: pr(), custos: { ...pr(), por_grupo: {} }, apresentadoras: pr(),
    imposto: { ...pr(), aliquota: Number(aliquota), base: 0 }, custos_fixos: pr(), custos_variaveis: pr(),
    perdas: { receita: { valor: 0 } },
  }
  for (const l of linhas) {
    tot.perdas.receita.valor += l.perdas.receita.valor
    for (const k of ['previsto', 'realizado']) {
      tot.receita[k] += l.receita[k]
      tot.aportes[k] += l.aportes[k]
      tot.custos[k] += l.custos[k]
      tot.apresentadoras[k] += l.apresentadoras[k]
      tot.imposto[k] += l.imposto[k]
      tot.custos_fixos[k] += l.custos_fixos[k]
      tot.custos_variaveis[k] += l.custos_variaveis[k]
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

// ─── DRE do mês (detalhe) ─────────────────────────────────────────────────

const pctDe = (parte, total) => (Number(total) > 0 ? r2((Number(parte) / Number(total)) * 100) : null)
const deltaPr = (a, b) => ({ previsto: r2(a.previsto - b.previsto), realizado: r2(a.realizado - b.realizado) })

/** Nome da apresentadora: campo do item ou extraído de "Pagamento <nome> - MM/AAAA". */
function nomeApresentadora(i) {
  if (i.apresentadora_nome || i.nome) return i.apresentadora_nome ?? i.nome
  const m = /^Pagamento\s+(.+?)(?:\s+\((?:fixo|vari[aá]vel|comiss[aã]o)[^)]*\))?\s+-\s+\d{2}\/\d{4}$/i.exec(String(i.descricao ?? ''))
  return m ? m[1] : (i.descricao ?? 'Apresentadora')
}

/** % de comissão da marca: campo do título, memória do cálculo ou comissão bruta ÷ GMV. */
function pctComissao(t) {
  const mem = t.memoria ?? {}
  const direto = t.pct ?? t.comissao_pct ?? mem.pct ?? mem.comissao_pct ?? null
  if (direto != null && Number.isFinite(Number(direto))) return r2(direto)
  return mem.gmv > 0 && mem.comissao_bruta != null ? pctDe(mem.comissao_bruta, mem.gmv) : null
}

// `previsto` = quanto o item conta no previsto da linha do DRE: receita perdida conta
// cheia (a perda vai para `perdas.receita`); custo cancelado conta só o que foi pago.
// `valor_encerrado` = saldo perdido/cancelado (0 se não encerrado).
const itemResumo = (i) => ({
  id: i.id,
  descricao: i.descricao,
  origem: i.origem,
  grupo: i.grupo,
  classe: i.classe,
  componente: i.componente ?? null,
  previsto: i.natureza === 'custo' ? previstoEfetivo(i) : r2(i.valor_previsto),
  realizado: r2(i.valor_pago),
  status: i.status_original ?? i.status,
  data_vencimento: i.data_vencimento ?? null,
  virtual: Boolean(i.virtual),
  valor_previsto: r2(i.valor_previsto),
  valor_encerrado: valorEncerrado(i),
  perdido_em: i.perdido_em ?? null,
  perdido_motivo: i.perdido_motivo ?? null,
  cancelado_em: i.cancelado_em ?? null,
  cancelado_motivo: i.cancelado_motivo ?? null,
  competencia_original: i.competencia_original ?? i.competencia,
  movimentos: i.movimentos ?? [],
})

/** Custos (exceto apresentadoras e imposto) agrupados por `grupo`, maior previsto primeiro. */
function custosPorGrupo(itens) {
  const grupos = new Map()
  for (const i of itens) {
    const g = i.grupo || 'outros'
    if (!grupos.has(g)) grupos.set(g, { grupo: g, total: pr(), itens: [] })
    const alvo = grupos.get(g)
    addPrCusto(alvo.total, i)
    alvo.itens.push(itemResumo(i))
  }
  return [...grupos.values()]
    .map((g) => ({ ...g, total: roundPr(g.total) }))
    .sort((a, b) => b.total.previsto - a.total.previsto || a.grupo.localeCompare(b.grupo))
}

/** Apresentadoras de um componente agregadas por pessoa. */
function apresentadorasPorPessoa(itens, componente) {
  const porId = new Map()
  for (const i of itens) {
    const id = i.apresentadora_id ?? i.id
    if (!porId.has(id)) {
      porId.set(id, {
        apresentadora_id: i.apresentadora_id ?? null,
        nome: nomeApresentadora(i),
        ...(componente === 'variavel' ? { comissao: 0, adicionais: 0 } : {}),
        previsto: 0,
        realizado: 0,
      })
    }
    const a = porId.get(id)
    a.previsto += Number(i.valor_previsto) || 0
    a.realizado += Number(i.valor_pago) || 0
    if (componente === 'variavel') {
      // contrato v3: comissao/adicionais do componente; legado (sem componente): idem do total
      a.comissao += Number(i.comissao) || 0
      a.adicionais += Number(i.adicionais) || 0
    }
  }
  return [...porId.values()]
    .map((a) => ({
      ...a,
      ...(componente === 'variavel' ? { comissao: r2(a.comissao), adicionais: r2(a.adicionais) } : {}),
      previsto: r2(a.previsto),
      realizado: r2(a.realizado),
    }))
    .sort((x, y) => y.previsto - x.previsto || String(x.nome).localeCompare(String(y.nome), 'pt-BR'))
}

/** Receita do mês por cliente → marca (fixo e comissão previstos × realizados + GMV/%). */
function receitaPorCliente(titulos) {
  const clientes = new Map()
  for (const t of titulos) {
    const cid = t.cliente_id ?? null
    // Mesma chave de receitas-comercial: marca sem cliente vira o próprio grupo
    // (antes todas caíam juntas em '__sem_cliente__'). Totais idênticos.
    const ck = cid ?? `sem-cliente:${t.marca_id}`
    if (!clientes.has(ck)) clientes.set(ck, { cliente_id: cid, cliente_nome: t.cliente_nome ?? (cid ? null : t.marca_nome ?? null), marcas: new Map(), total: pr(), perdido: 0 })
    const c = clientes.get(ck)
    if (!c.marcas.has(t.marca_id)) {
      c.marcas.set(t.marca_id, { marca_id: t.marca_id, marca_nome: t.marca_nome ?? null, fixo: pr(), comissao: pr(), gmv: null, pct: null, perdido: 0 })
    }
    const m = c.marcas.get(t.marca_id)
    const comp = t.origem === 'marca_fixo' ? 'fixo' : 'comissao'
    addPr(m[comp], t)
    addPr(c.total, t)
    m.perdido += valorEncerrado(t)
    c.perdido += valorEncerrado(t)
    if (comp === 'comissao') {
      const gmv = t.gmv ?? t.memoria?.gmv
      if (gmv != null) m.gmv = r2((m.gmv ?? 0) + Number(gmv))
      m.pct ??= pctComissao(t)
    }
  }
  return [...clientes.values()]
    .map((c) => ({
      cliente_id: c.cliente_id,
      cliente_nome: c.cliente_nome,
      total: roundPr(c.total),
      perdido: r2(c.perdido),
      marcas: [...c.marcas.values()]
        .map((m) => ({ ...m, fixo: roundPr(m.fixo), comissao: roundPr(m.comissao), perdido: r2(m.perdido) }))
        .sort((a, b) => String(a.marca_nome ?? '').localeCompare(String(b.marca_nome ?? ''), 'pt-BR')),
    }))
    .sort((a, b) => b.total.previsto - a.total.previsto || String(a.cliente_nome ?? '').localeCompare(String(b.cliente_nome ?? ''), 'pt-BR'))
}

/**
 * Detalhe do DRE de `mes` (GET /dre/mes). Pura: `itens` = lançamentos (já com corte)
 * das competências [mes−1, mes]. Invariantes:
 *   receita.total            = atual.receita
 *   custos_fixos.total       = Σ por_grupo + Σ apresentadoras_fixo
 *   custos_variaveis.total   = Σ por_grupo + Σ apresentadoras_variavel + imposto
 *   atual.resultado.previsto = receita − perdas.receita − custos_fixos − custos_variaveis (aportes fora)
 *   receita.perdas.valor     = atual.perdas.receita.valor (legado + eventos do mês)
 * Itens perdidos/cancelados aparecem no detalhe (status + motivo + valor_encerrado).
 */
export function montarDreDetalhe({ mes, itens, eventosPerda = [], aliquota = ALIQUOTA_IMPOSTO_PADRAO, hoje = null }) {
  const anteriorMes = addMeses(mes, -1)
  const impostos = new Map(itens.filter((i) => i.origem === 'imposto')
    .map((i) => [mesDe(i.competencia), { aliquota: i.aliquota, base: i.base }]))
  const { meses: [anterior, atual] } = montarDre({ meses: [anteriorMes, mes], itens, eventosPerda, impostos, aliquota })
  const doMes = itens.filter((i) => mesDe(i.competencia) === mes)

  const titulos = doMes.filter((i) => i.origem === 'marca_fixo' || i.origem === 'marca_comissao')
  const avulsas = doMes.filter((i) => i.natureza === 'receita' && i.origem === 'avulsa' && !ehAporte(i))
  const custos = doMes.filter((i) => i.natureza === 'custo')
  const classe = (i) => i.classe ?? classeDoItem(i)
  const comuns = (c) => custos.filter((i) => classe(i) === c && i.origem !== 'apresentadora' && i.origem !== 'imposto')
  const aps = (c) => custos.filter((i) => i.origem === 'apresentadora' && classe(i) === c)
  const calcImp = custos.find((i) => i.origem === 'imposto') ?? null

  const contribuicao = {
    previsto: r2(atual.receita.previsto - atual.perdas.receita.valor - atual.custos_variaveis.previsto),
    realizado: r2(atual.receita.realizado - atual.custos_variaveis.realizado),
  }
  return {
    mes,
    mes_anterior: anteriorMes,
    atual,
    anterior,
    delta: {
      receita: deltaPr(atual.receita, anterior.receita),
      custos_fixos: deltaPr(atual.custos_fixos, anterior.custos_fixos),
      custos_variaveis: deltaPr(atual.custos_variaveis, anterior.custos_variaveis),
      resultado: deltaPr(atual.resultado, anterior.resultado),
      perdas: { receita: { valor: r2(atual.perdas.receita.valor - anterior.perdas.receita.valor) } },
    },
    receita: {
      por_cliente: receitaPorCliente(titulos),
      avulsas: avulsas.map(itemResumo),
      total: atual.receita,
      perdas: atual.perdas.receita,
      eventos_perda: eventosPerda.filter((e) => e.mes_registro === mes),
      perdidos: [...titulos, ...avulsas].filter((i) => valorEncerrado(i) > 0).map((i) => ({
        ...itemResumo(i), marca_id: i.marca_id ?? null, marca_nome: i.marca_nome ?? null,
        cliente_id: i.cliente_id ?? null, cliente_nome: i.cliente_nome ?? null,
      })),
    },
    custos_fixos: {
      total: atual.custos_fixos,
      por_grupo: custosPorGrupo(comuns('fixo')),
      apresentadoras_fixo: apresentadorasPorPessoa(aps('fixo'), 'fixo'),
    },
    custos_variaveis: {
      total: atual.custos_variaveis,
      por_grupo: custosPorGrupo(comuns('variavel')),
      apresentadoras_variavel: apresentadorasPorPessoa(aps('variavel'), 'variavel'),
      imposto: {
        id: calcImp?.id ?? idImposto(mes),
        previsto: atual.imposto.previsto,
        realizado: atual.imposto.realizado,
        aliquota: calcImp?.aliquota ?? atual.imposto.aliquota,
        base: r2(calcImp?.base ?? atual.imposto.base),
        // imposto zerado não gera lançamento: base_tipo pela mesma regra de calcularImpostoMes
        base_tipo: calcImp?.base_tipo ?? (hoje ? (anteriorMes < String(hoje).slice(0, 7) ? 'realizado' : 'projetado') : null),
        mes_base: calcImp?.mes_base ?? anteriorMes,
        status: calcImp?.status ?? null,
        data_vencimento: calcImp?.data_vencimento ?? vencimentoImposto(mes),
      },
    },
    aportes: doMes.filter(ehAporte).map(itemResumo),
    margem: {
      contribuicao,
      pct: { previsto: pctDe(contribuicao.previsto, atual.receita.previsto), realizado: pctDe(contribuicao.realizado, atual.receita.realizado) },
    },
  }
}

/** Eventos FIN-02 relevantes ao DRE: registrados no período ou ligados a obrigação do período. */
export async function listarEventosPerdaDre(db, { tenantId, inicio, fim } = {}) {
  if (!tenantId) throw erro('tenantId é obrigatório', 400, 'INVALID_SCOPE')
  const { rows } = await db.query(
    `SELECT e.tipo, e.origem_tipo, e.origem_id::text AS origem_id, e.valor::text AS valor,
            to_char(e.competencia_obrigacao, 'YYYY-MM-DD') AS competencia_obrigacao,
            to_char(e.registrado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') AS mes_registro
       FROM financeiro_perdas_eventos e
       LEFT JOIN receitas_avulsas a
         ON e.origem_tipo = 'receita_avulsa'
        AND a.tenant_id = e.tenant_id
        AND a.id = e.origem_id
      WHERE e.tenant_id = $1::uuid
        AND (e.origem_tipo = 'receita_titulo' OR (e.origem_tipo = 'receita_avulsa' AND a.id IS NOT NULL AND a.grupo <> 'aporte'))
        AND (
          (e.registrado_em >= ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
           AND e.registrado_em < (($3::date + INTERVAL '1 month')::timestamp AT TIME ZONE 'America/Sao_Paulo'))
          OR (e.competencia_obrigacao >= $2::date AND e.competencia_obrigacao <= $3::date)
        )
      ORDER BY e.registrado_em, e.id`,
    [tenantId, `${inicio}-01`, `${fim}-01`],
  )
  return rows
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
 *   previsto  = Σ valor_previsto por DATA DE VENCIMENTO no mês (sem o saldo perdido/cancelado);
 *   realizado = Σ eventos de liquidação/estorno nas respectivas datas do mês.
 * Linhas nas faixas 5/10/15/20/25/30 (+ 'cartao'), saldo e acumulado (a partir de
 * saldo_inicial). serie_anual jan–dez do ano de `mes`, mesma regra.
 * Formato legado (`entradas`/`saidas`/`items` por dia, previsto) mantido para o front atual.
 */
export function montarFluxoCaixa({ mes, itens, movimentos = [], saldoInicial = 0, saldoInicialOrigem = 'informado' }) {
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
    // perdido/cancelado: o saldo encerrado sai do previsto (o que foi pago continua)
    const previsto = previstoEfetivo(i)
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
  }
  // Obrigações definem a previsão; só os fatos de caixa definem o realizado.
  for (const movimento of movimentos) {
    const mp = mesDe(movimento.data)
    const valor = Number(movimento.valor) || 0
    if (mp === mes) linhas.get(chaveFluxo(movimento, movimento.data))[lado(movimento)].realizado += valor
    if (serie.has(mp)) serie.get(mp)[lado(movimento)].realizado += valor
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
export async function buscarConfigFinanceiro(db, tenantId, { dinheiroExato = false } = {}) {
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
    saldo_abertura: dinheiroExato
      ? (row.saldo_abertura == null ? null : centsToExactMoney(exactMoneyToCents(String(row.saldo_abertura))))
      : r2(row.saldo_abertura),
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
  to_char(data_pagamento,'YYYY-MM-DD') AS data_pagamento,
  cancelado_em, cancelado_motivo, cancelado_por`

/** Recebimentos operacionais líquidos por mês do evento; aportes ficam fora da base. */
async function recebidoPorMes(db, { tenantId, mesInicio, mesFim, dataCorte = null }) {
  const { itens } = await lerMovimentosFinanceirosPeriodo(db, {
    tenantId, de: `${mesInicio}-01`, ate: ultimoDia(mesFim), dataCorte,
  })
  const centavos = new Map()
  for (const i of itens) {
    if (i.natureza !== 'receita' || ehAporte(i)) continue
    const mes = mesDe(i.data)
    centavos.set(mes, (centavos.get(mes) ?? 0n) + exactMoneyToCents(String(i.valor)))
  }
  return new Map([...centavos].map(([mes, total]) => [mes, Number(centsToExactMoney(total))]))
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
 * `receitas` (opcional; objeto ou Promise de): { titulos, avulsas, inicio, fim } já carregados
 * por listarTitulosReceita/listarReceitasAvulsas (mesmo `hoje`) — usados na projeção quando
 * cobrem as competências necessárias [projIni−1, baseFim]; senão consulta o banco como antes.
 * O resultado é idêntico ao da consulta (só as competências necessárias são consideradas).
 */
export async function calcularImpostos(db, { tenantId, inicio, fim, hoje = hojeSaoPaulo(), aliquota, dataCorte, receitas } = {}) {
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
    const de = addMeses(projIni, -1)
    const carregadas = receitas ? await receitas : null
    let titulos
    let avulsas
    if (carregadas && carregadas.inicio <= de && carregadas.fim >= baseFim) {
      const naFaixa = (x) => { const m = String(x.competencia ?? '').slice(0, 7); return m >= de && m <= baseFim }
      titulos = carregadas.titulos.filter(naFaixa)
      avulsas = carregadas.avulsas.filter(naFaixa)
    } else {
      ;[titulos, avulsas] = await esperarLeiturasFinanceiras([
        listarTitulosReceita(db, { tenantId, inicio: de, fim: baseFim, hoje }),
        listarReceitasAvulsas(db, { tenantId, inicio: de, fim: baseFim, hoje }),
      ])
    }
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
export async function listarImpostos(db, { tenantId, inicio, fim, hoje = hojeSaoPaulo(), aliquota, dataCorte, receitas } = {}) {
  const [calculos, mats] = await esperarLeiturasFinanceiras([
    calcularImpostos(db, { tenantId, inicio, fim, hoje, aliquota, dataCorte, receitas }),
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
function erroImposto(message, code, statusCode = 409) {
  return erro(message, statusCode, code)
}

function centavosImposto(valor, campo = 'valor_pago') {
  try {
    return exactMoneyToCents(typeof valor === 'number' ? r2(valor).toFixed(2) : (valor ?? '0'))
  } catch {
    throw erro(`${campo} deve ser um valor monetário válido`, 400, 'INVALID_PAYMENT')
  }
}

async function impostoMaterializadoAtual(db, tenantId, mes, lock = false) {
  const { rows } = await db.query(
    `SELECT id, tenant_id, valor::text AS valor, COALESCE(valor_pago, 0)::text AS valor_pago,
            cancelado_em
       FROM custos
      WHERE tenant_id = $1::uuid AND tipo = 'imposto' AND competencia = $2::date${lock ? ' FOR UPDATE' : ''}`,
    [tenantId, `${mes}-01`],
  )
  return rows[0] ?? null
}

async function totalLiquidoImposto(db, tenantId, custoId) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(l.valor), 0)::text AS liquidado,
            COALESCE(SUM(e.total), 0)::text AS estornado
       FROM financeiro_liquidacoes l
       LEFT JOIN LATERAL (
         SELECT SUM(valor) AS total FROM financeiro_estornos
          WHERE tenant_id = l.tenant_id AND liquidacao_id = l.id
       ) e ON true
      WHERE l.tenant_id = $1::uuid AND l.origem_tipo = 'imposto' AND l.origem_id = $2::uuid`,
    [tenantId, custoId],
  )
  return exactMoneyToCents(rows[0].liquidado) - exactMoneyToCents(rows[0].estornado)
}

/**
 * Baixa do imposto no contrato FIN-03A. A linha de `custos` é somente a
 * projeção agregada da obrigação; o fato financeiro e a projeção são gravados
 * juntos pelo comando canônico.
 */
export async function pagarImposto(db, {
  tenantId, mes, valorPago, valorIncremental, dataPagamento, observacao, hoje = hojeSaoPaulo(),
  ator = { tipo: 'sistema', id: 'financeiro-agregador' }, chaveOperacao = randomUUID(), retornarLiquidacao = false,
} = {}) {
  if (valorPago != null && valorIncremental != null) throw erro('Informe valorPago acumulado ou valorIncremental, não ambos', 400, 'INVALID_PAYMENT')
  if (!RE_MES.test(String(mes ?? ''))) throw erro('mes deve estar no formato AAAA-MM')
  if (dataPagamento != null && !RE_DATA.test(String(dataPagamento))) throw erro('data_pagamento deve estar no formato AAAA-MM-DD', 400, 'INVALID_PAYMENT')
  const materializados = await impostosMaterializados(db, { tenantId, inicio: mes, fim: mes })
  if (materializados.get(mes)?.cancelado_em) throw erro('Imposto cancelado. Reative antes de pagar.', 409, 'CUSTO_CANCELADO')
  const [calculo] = await calcularImpostos(db, { tenantId, inicio: mes, fim: mes, hoje })
  const incremento = valorIncremental == null ? null : centavosImposto(valorIncremental, 'valor_operacao')
  const alvo = incremento === null ? (valorPago == null ? centavosImposto(calculo.valor) : centavosImposto(valorPago)) : null
  if ((alvo ?? incremento) <= 0n) throw erro('valor_pago deve ser maior que zero (imposto calculado é zero)', 400, 'INVALID_PAYMENT')
  const previsto = calculo.valor > 0 ? calculo.valor : Number(centsToExactMoney(alvo ?? incremento))
  const obs = observacao ?? `Base ${calculo.mes_base} (${calculo.base_tipo}): ${calculo.base.toFixed(2)} × ${calculo.aliquota}%`
  // Materialização cria apenas a obrigação. Nunca grava a baixa fora do
  // comando: isso mantém evento e projeção atômicos.
  await db.query(
    `INSERT INTO custos (tenant_id, descricao, valor, tipo, grupo, competencia, data_vencimento,
                         observacao)
     VALUES ($1::uuid, $2, $3, 'imposto', 'outros', $4::date, $5::date, $6)
     ON CONFLICT (tenant_id, competencia) WHERE tipo = 'imposto'
     DO NOTHING`,
    [tenantId, `Imposto ${mes.slice(5)}/${mes.slice(0, 4)}`, previsto, `${mes}-01`, vencimentoImposto(mes),
      obs],
  )
  const atual = await impostoMaterializadoAtual(db, tenantId, mes)
  if (!atual) throw erroImposto('Imposto não encontrado neste tenant', 'IMPOSTO_NAO_ENCONTRADO', 404)
  if (atual.cancelado_em) throw erro('Imposto cancelado. Reative antes de pagar.', 409, 'CUSTO_CANCELADO')
  const previstoCents = centavosImposto(atual.valor, 'valor')
  const pagoAtual = centavosImposto(atual.valor_pago)
  const liquidoAtual = await totalLiquidoImposto(db, tenantId, atual.id)
  if (liquidoAtual !== pagoAtual) throw erroImposto('Baixa legada sem fatos equivalentes; revisão necessária', 'IMPOSTO_LIQUIDACAO_DIVERGENTE')
  if (alvo !== null && alvo > previstoCents) throw erroImposto('valor_pago excede o valor previsto', 'IMPOSTO_VALOR_EXCEDENTE')
  const { rows: anteriores } = await db.query(
    `SELECT valor::text AS valor, to_char(data_liquidacao, 'YYYY-MM-DD') AS data
       FROM financeiro_liquidacoes WHERE tenant_id = $1::uuid AND idempotencia_chave = $2`,
    [tenantId, chaveOperacao],
  )
  const anterior = anteriores[0]
  const delta = anterior ? centavosImposto(anterior.valor, 'valor') : incremento ?? (alvo - pagoAtual)
  if (!anterior && delta <= 0n) throw erroImposto('Imposto já pago neste valor', 'IMPOSTO_SEM_SALDO')
  const data = dataPagamento ?? anterior?.data ?? hoje
  const motivo = JSON.stringify(incremento === null
    ? { alvo: centsToExactMoney(alvo), observacao: obs, operacao: 'baixa_total_legada' }
    : { valor_operacao: centsToExactMoney(incremento), observacao: obs, operacao: 'incremental' })
  const liquidacao = await registrarLiquidacao(db, {
    tenantId, origemTipo: 'imposto', origemId: atual.id, valor: centsToExactMoney(delta), data,
    ator, idempotenciaChave: chaveOperacao, comandoOrigem: 'impostos.pagar', motivo,
    validarOrigemParaUpdate: async (tx) => {
      const imposto = await impostoMaterializadoAtual(tx, tenantId, mes, true)
      if (!imposto) return null
      if (imposto.cancelado_em) throw erro('Imposto cancelado. Reative antes de pagar.', 409, 'CUSTO_CANCELADO')
      const valor = centavosImposto(imposto.valor, 'valor')
      const pago = centavosImposto(imposto.valor_pago)
      const liquido = await totalLiquidoImposto(tx, tenantId, imposto.id)
      if (liquido !== pago) throw erroImposto('Baixa legada sem fatos equivalentes; revisão necessária', 'IMPOSTO_LIQUIDACAO_DIVERGENTE')
      if (alvo !== null && alvo !== pago + delta) throw erroImposto('valor_pago mudou durante a baixa; tente novamente', 'IMPOSTO_PAGAMENTO_CONCORRENTE')
      const saldo = valor - pago
      if (saldo <= 0n) throw erroImposto('Imposto sem saldo disponível', 'IMPOSTO_SEM_SALDO')
      return { tenantId: imposto.tenant_id, natureza: 'custo', saldoElegivel: centsToExactMoney(saldo) }
    },
    aplicarProjecao: async (tx, evento) => {
      await tx.query(
        `UPDATE custos SET valor_pago = COALESCE(valor_pago, 0) + $3::numeric,
                data_pagamento = $4::date, observacao = COALESCE($5, observacao), atualizado_em = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [tenantId, atual.id, evento.valor, data, observacao ?? null],
      )
    },
  })
  const item = await itemImpostoDoMes(db, { tenantId, mes, hoje })
  return retornarLiquidacao ? { item, liquidacao } : item
}

/**
 * Cancela o imposto da competência `mes` (não será pago): materializa a linha de `custos`
 * com o previsto calculado agora, `valor_pago` 0 e `cancelado_*`. Já cancelado: mantém
 * cancelado_em/por; motivo informado substitui o anterior. Imposto pago integralmente → 409.
 */
export async function cancelarImposto(db, { tenantId, mes, motivo, actorUserId = null, hoje = hojeSaoPaulo() } = {}) {
  if (!RE_MES.test(String(mes ?? ''))) throw erro('mes deve estar no formato AAAA-MM')
  const motivoNorm = normalizarMotivo(motivo)
  const [calculo] = await calcularImpostos(db, { tenantId, inicio: mes, fim: mes, hoje })
  const atual = (await impostosMaterializados(db, { tenantId, inicio: mes, fim: mes })).get(mes)
  const previsto = atual ? r2(atual.valor) : calculo.valor
  if (r2(atual?.valor_pago) > 0 && r2(atual.valor_pago) >= previsto) throw erro('Imposto já pago integralmente não pode ser cancelado', 409, 'JA_PAGO')
  if (!(previsto > 0)) throw erro('Imposto sem valor previsto não pode ser cancelado', 409, 'CANCELAMENTO_INVALIDO')
  await db.query(
    `INSERT INTO custos (tenant_id, descricao, valor, tipo, grupo, competencia, data_vencimento,
                         valor_pago, cancelado_em, cancelado_por, cancelado_motivo)
     VALUES ($1::uuid, $2, $3, 'imposto', 'outros', $4::date, $5::date, 0, NOW(), $6::uuid, $7::text)
     ON CONFLICT (tenant_id, competencia) WHERE tipo = 'imposto'
     DO UPDATE SET cancelado_em = COALESCE(custos.cancelado_em, NOW()),
                   cancelado_por = CASE WHEN custos.cancelado_em IS NULL THEN $6::uuid ELSE custos.cancelado_por END,
                   cancelado_motivo = CASE WHEN custos.cancelado_em IS NULL THEN $7::text ELSE COALESCE($7::text, custos.cancelado_motivo) END,
                   atualizado_em = NOW()`,
    [tenantId, `Imposto ${mes.slice(5)}/${mes.slice(0, 4)}`, previsto, `${mes}-01`, vencimentoImposto(mes),
      actorUserId ?? null, motivoNorm],
  )
  return itemImpostoDoMes(db, { tenantId, mes, hoje })
}

/** Reativa o imposto cancelado: sem baixa a linha some (volta a ser calculado); com baixa só limpa cancelado_*. */
export async function reativarImposto(db, { tenantId, mes, hoje = hojeSaoPaulo() } = {}) {
  if (!RE_MES.test(String(mes ?? ''))) throw erro('mes deve estar no formato AAAA-MM')
  const comp = `${mes}-01`
  const del = await db.query(
    `DELETE FROM custos WHERE tenant_id = $1::uuid AND tipo = 'imposto' AND competencia = $2::date
        AND cancelado_em IS NOT NULL AND COALESCE(valor_pago, 0) = 0 RETURNING id`,
    [tenantId, comp],
  )
  if (!del.rows[0]) {
    const upd = await db.query(
      `UPDATE custos SET cancelado_em = NULL, cancelado_motivo = NULL, cancelado_por = NULL, atualizado_em = NOW()
        WHERE tenant_id = $1::uuid AND tipo = 'imposto' AND competencia = $2::date AND cancelado_em IS NOT NULL
        RETURNING id`,
      [tenantId, comp],
    )
    if (!upd.rows[0]) throw erro('Imposto não está cancelado', 404, 'IMPOSTO_NOT_FOUND')
  }
  return itemImpostoDoMes(db, { tenantId, mes, hoje })
}

/** Desfaz uma baixa canônica; a linha materializada permanece como projeção agregada. */
export async function desfazerImposto(db, {
  tenantId, mes, hoje = hojeSaoPaulo(), ator = { tipo: 'sistema', id: 'financeiro-agregador' }, chaveOperacao = randomUUID(),
} = {}) {
  if (!RE_MES.test(String(mes ?? ''))) throw erro('mes deve estar no formato AAAA-MM')
  const atual = await impostoMaterializadoAtual(db, tenantId, mes)
  if (!atual) throw erro('Imposto sem baixa registrada', 404, 'IMPOSTO_NOT_FOUND')
  const { rows: anteriores } = await db.query(
    `SELECT liquidacao_id, valor::text AS valor, to_char(data_estorno, 'YYYY-MM-DD') AS data
       FROM financeiro_estornos WHERE tenant_id = $1::uuid AND idempotencia_chave = $2`,
    [tenantId, chaveOperacao],
  )
  let fato = anteriores[0]
  if (!fato) {
    const { rows: fatos } = await db.query(
      `SELECT l.id, (l.valor - COALESCE(SUM(e.valor), 0))::text AS saldo
         FROM financeiro_liquidacoes l
         LEFT JOIN financeiro_estornos e ON e.tenant_id = l.tenant_id AND e.liquidacao_id = l.id
        WHERE l.tenant_id = $1::uuid AND l.origem_tipo = 'imposto' AND l.origem_id = $2::uuid
        GROUP BY l.id, l.valor HAVING l.valor > COALESCE(SUM(e.valor), 0)
        ORDER BY l.id`,
      [tenantId, atual.id],
    )
    const pago = centavosImposto(atual.valor_pago)
    const total = fatos.reduce((sum, item) => sum + centavosImposto(item.saldo, 'saldo'), 0n)
    if (total !== pago) throw erroImposto('Baixa legada sem fatos equivalentes; revisão necessária', 'IMPOSTO_LIQUIDACAO_DIVERGENTE')
    if (fatos.length === 0) throw erro('Imposto sem baixa registrada', 404, 'IMPOSTO_NOT_FOUND')
    if (fatos.length > 1) throw erroImposto('Múltiplas liquidações exigem estorno granular', 'IMPOSTO_ESTORNO_GRANULAR_NECESSARIO')
    fato = { liquidacao_id: fatos[0].id, valor: fatos[0].saldo, data: hoje }
  }
  await registrarEstorno(db, {
    tenantId, liquidacaoId: fato.liquidacao_id, valor: fato.valor, data: fato.data,
    ator, idempotenciaChave: chaveOperacao, comandoOrigem: 'impostos.desfazer', motivo: 'Desfazer pagamento de imposto',
    aplicarProjecao: async (tx, evento) => {
      if (evento.natureza !== 'custo' || evento.origemTipo !== 'imposto' || evento.origemId !== atual.id) {
        throw erroImposto('Liquidação não pertence ao imposto', 'IMPOSTO_LIQUIDACAO_DIVERGENTE')
      }
      const { rows } = await tx.query(
        `UPDATE custos SET valor_pago = valor_pago - $3::numeric,
                data_pagamento = CASE WHEN valor_pago = $3::numeric THEN NULL ELSE data_pagamento END,
                atualizado_em = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::uuid AND valor_pago >= $3::numeric
          RETURNING id`,
        [tenantId, atual.id, evento.valor],
      )
      if (!rows[0]) throw erroImposto('Pagamento mudou durante o estorno; revisão necessária', 'IMPOSTO_ESTORNO_CONCORRENTE')
    },
  })
  return itemImpostoDoMes(db, { tenantId, mes, hoje })
}

// ─── Banco: lançamentos unificados ────────────────────────────────────────

/**
 * Todos os lançamentos das competências [inicio, fim] (YYYY-MM), já normalizados
 * e ordenados por vencimento: receitas (marcas + avulsas) + custos + apresentadoras
 * + imposto, com a regra de corte aplicada (dataCorte undefined → lida da config).
 */
export async function listarLancamentos(db, { tenantId, inicio, fim, hoje = hojeSaoPaulo(), aliquota, dataCorte, vencimentoDe, vencimentoAte, incluirSemData = false, regraCorte = 'legado' } = {}) {
  if (!tenantId) throw erro('tenantId é obrigatório', 400, 'INVALID_SCOPE')
  let pct = aliquota
  let corte = dataCorte
  if (pct === undefined || corte === undefined) {
    const cfg = await buscarConfigFinanceiro(db, tenantId)
    pct ??= cfg.aliquota_imposto_pct
    if (corte === undefined) corte = cfg.data_corte
  }
  // Receitas/avulsas são carregadas UMA vez e reaproveitadas pela projeção do imposto
  // (antes calcularImpostos refazia as mesmas duas listagens).
  const pTitulos = listarTitulosReceita(db, { tenantId, inicio, fim, hoje, vencimentoDe, vencimentoAte, incluirSemData })
  const pAvulsas = listarReceitasAvulsas(db, { tenantId, inicio, fim, hoje, vencimentoDe, vencimentoAte, incluirSemData })
  const pReceitas = esperarLeiturasFinanceiras([pTitulos, pAvulsas]).then(([titulos, avulsas]) => ({ titulos, avulsas, inicio, fim }))
  pReceitas.catch(() => {}) // se o imposto não precisar dela, a rejeição já é tratada no Promise.all abaixo
  // A branch (notably presenter month loops) can issue more reads after another
  // rejects. Drain every branch before the caller rolls back/releases its tenant
  // snapshot; Promise.all would leave those reads running outside the snapshot.
  const resultados = await Promise.allSettled([
    pTitulos,
    pAvulsas,
    listarCustos(db, { tenantId, inicio, fim, hoje, vencimentoAte, incluirSemData }),
    listarPagamentosApresentadoras(db, { tenantId, inicio: `${inicio}-01`, fim: `${fim}-01`, hoje }),
    listarImpostos(db, { tenantId, inicio, fim, hoje, aliquota: pct, dataCorte: corte, receitas: pReceitas }),
  ])
  const falha = resultados.find(r => r.status === 'rejected')
  if (falha) throw falha.reason
  const [receitas, avulsas, custos, apresentadoras, impostos] = resultados.map(r => r.value)
  const itens = [
    ...receitas.map((t) => normalizarReceita(t, hoje)),
    ...avulsas.map((a) => marcarEncerramento({ ...BASE_ITEM, ...a })),
    // imposto materializado em `custos` sai daqui e entra como lançamento próprio
    ...custos.filter((c) => c.tipo !== 'imposto').map((c) => normalizarCusto(c, hoje)),
    ...apresentadoras.map((p) => normalizarApresentadora(p, hoje)),
    ...impostos,
    // A manually moved tax due date may belong to an old competence. Include
    // that persisted obligation without duplicating taxes calculated above.
    ...(vencimentoDe ? custos.filter((c) => c.tipo === 'imposto' && !impostos.some((i) => i.custo_id === c.id))
      .map((c) => normalizarCusto({ ...c, origem: 'imposto', custo_id: c.id }, hoje)) : []),
  ]
  // Previsões de caixa seguem vencimento; a base do imposto mantém seu próprio corte.
  const filtrados = regraCorte === 'nenhum' ? itens : regraCorte === 'vencimento' && corte
    ? itens.filter((i) => vencimentoEfetivo(i) >= corte)
    : aplicarCorte(itens, corte)
  return ordenarLancamentos(filtrados)
}

export function normalizarRegimeDre(regime = 'caixa_vencimento') {
  if (!['caixa_vencimento', 'competencia'].includes(regime)) throw erro('regime deve ser caixa_vencimento ou competencia', 400, 'INVALID_DRE_REGIME')
  return regime
}

const chaveOrigemDre = (i) => i.origem === 'apresentadora'
  ? `apresentadora:${i.apresentadora_id}:${mesDe(i.competencia_original ?? i.competencia)}:${i.componente}`
  : `${i.origem}:${i.custo_id ?? i.origem_id ?? i.id}`

/** One contribution per obligation/month, keeping original competence and facts.
 * Amounts settled outside the due month never leak into its realized column.
 */
export function projetarDreCaixa({ itens, movimentos, inicio, fim, dataCorte = null }) {
  const porChave = new Map()
  for (const i of itens) {
    const data = vencimentoEfetivo(i)
    const mes = mesDe(data)
    if (!mes || mes < inicio || mes > fim || (dataCorte && data < dataCorte)) continue
    const previsto = i.natureza === 'custo' ? previstoEfetivo(i) : r2(i.valor_previsto)
    const linha = { ...i, competencia_original: i.competencia, competencia: `${mes}-01`,
      valor_previsto: previsto, valor_pago: 0, data_pagamento: null, movimentos: [],
      status_original: i.status, status: 'previsto',
      // Closures already reduced the forecast; do not reduce it twice after
      // replacing the accumulated payment with the month's event amount.
      cancelado_em: null, perdido_em: null, valor_perdido: i.natureza === 'receita' ? valorEncerrado(i) : 0,
      perda_dre: i.natureza === 'receita' ? valorEncerrado(i) : 0,
    }
    porChave.set(`${chaveOrigemDre(linha)}:${mes}`, linha)
  }
  for (const e of movimentos) {
    const mes = mesDe(e.data)
    if (!mes || mes < inicio || mes > fim || (dataCorte && e.data < dataCorte)) continue
    const chave = `${chaveOrigemDre(e)}:${mes}`
    if (!porChave.has(chave)) porChave.set(chave, {
      ...e, id: e.origem_id, competencia_original: e.competencia, competencia: `${mes}-01`,
      data_pagamento: e.data, valor_previsto: 0, valor_pago: 0, valor_perdido: 0,
      virtual: false, status: 'pago', movimentos: [], perda_dre: 0,
      // Facts add money only; their repeated metadata must not add GMV/commission.
      gmv: 0, comissao: 0, adicionais: 0,
    })
    const linha = porChave.get(chave)
    linha.valor_pago = r2(linha.valor_pago + e.valor)
    linha.movimentos.push(e)
  }
  return [...porChave.values()]
}

async function selecionarDreCaixa(db, { tenantId, inicio, fim, hoje, config }) {
  const de = `${inicio}-01`
  const ate = ultimoDia(fim)
  const opts = { tenantId, hoje, aliquota: config.aliquota_imposto_pct, dataCorte: null, vencimentoDe: de, vencimentoAte: ate }
  // The preceding competence covers contractual offsets. Persisted obligations
  // are independently selected by due date, including debts from older years.
  const [atuais, anteriores, movimentos] = await Promise.all([
    listarLancamentos(db, { ...opts, inicio, fim }),
    listarLancamentos(db, { ...opts, inicio: addMeses(inicio, -1), fim: addMeses(inicio, -1) }),
    lerMovimentosFinanceirosPeriodo(db, { tenantId, de, ate, dataCorte: config.data_corte }),
  ])
  const unicos = [...new Map([...anteriores, ...atuais].map((i) => [chaveOrigemDre(i), i])).values()]
  return { itens: projetarDreCaixa({ itens: unicos, movimentos: movimentos.itens, inicio, fim, dataCorte: config.data_corte }), reconciliacao: movimentos.reconciliacao }
}

export async function saldosDreCaixa(db, options) {
  return saldosCaixaInicioMeses(db, options)
}

/** GET /lancamentos: itens filtrados + totais (dos itens filtrados). */
export async function consultarLancamentos(db, { tenantId, inicio, fim, hoje = hojeSaoPaulo(), filtros = {}, vencimentoAte } = {}) {
  const itens = filtrarLancamentos(await listarLancamentos(db, { tenantId, inicio, fim, hoje, vencimentoAte }), filtros)
  return { inicio, fim, hoje, itens, totais: totalizarLancamentos(itens) }
}

/** DRE mensal previsto × realizado para [inicio, fim]. */
export async function calcularDre(db, { tenantId, inicio, fim, hoje = hojeSaoPaulo(), regime = 'caixa_vencimento' } = {}) {
  normalizarRegimeDre(regime)
  const config = await buscarConfigFinanceiro(db, tenantId)
  const { aliquota_imposto_pct: aliquota, data_corte: dataCorte } = config
  const [competenciaItens, eventosPerdaCompetencia] = regime === 'competencia' ? await Promise.all([
    listarLancamentos(db, { tenantId, inicio, fim, hoje, aliquota, dataCorte }),
    listarEventosPerdaDre(db, { tenantId, inicio, fim }),
  ]) : [[], []]
  const selecao = regime === 'caixa_vencimento' ? await selecionarDreCaixa(db, { tenantId, inicio, fim, hoje, config }) : null
  const itens = selecao?.itens ?? competenciaItens
  const eventosPerda = regime === 'competencia' ? eventosPerdaCompetencia : []
  const impostos = new Map(itens.filter((i) => i.origem === 'imposto')
    .map((i) => [mesDe(i.competencia), { aliquota: i.aliquota, base: i.base }]))
  const meses = mesesEntre(inicio, fim)
  const dre = montarDre({ meses, itens, eventosPerda, impostos, aliquota })
  const saldos = regime === 'caixa_vencimento' ? await saldosDreCaixa(db, { tenantId, meses, config })
    : await saldosCaixaInicioMeses(db, { tenantId, meses, config })
  return {
    inicio, fim, regime, aliquota, data_corte: dataCorte, reconciliacao: selecao?.reconciliacao,
    ...dre,
    meses: dre.meses.map((linha) => ({ ...linha, caixa: { saldo_inicio_mes: saldos.get(linha.mes) ?? null } })),
  }
}

/**
 * GET /dre/mes: detalhe do DRE de `mes` + comparativo com mes−1. Uma única chamada a
 * listarLancamentos cobre [mes−1, mes] (sem consulta por item/mês). Corte aplicado.
 */
export async function calcularDreMes(db, { tenantId, mes, hoje = hojeSaoPaulo(), regime = 'caixa_vencimento' } = {}) {
  normalizarRegimeDre(regime)
  if (!tenantId) throw erro('tenantId é obrigatório', 400, 'INVALID_SCOPE')
  if (!RE_MES.test(String(mes ?? ''))) throw erro('mes deve estar no formato AAAA-MM')
  const cfg = await buscarConfigFinanceiro(db, tenantId)
  const { aliquota_imposto_pct: aliquota, data_corte: dataCorte } = cfg
  const inicioDre = addMeses(mes, -1)
  const [competenciaItens, eventosPerdaCompetencia] = regime === 'competencia' ? await Promise.all([
    listarLancamentos(db, { tenantId, inicio: inicioDre, fim: mes, hoje, aliquota, dataCorte }),
    listarEventosPerdaDre(db, { tenantId, inicio: inicioDre, fim: mes }),
  ]) : [[], []]
  const selecao = regime === 'caixa_vencimento' ? await selecionarDreCaixa(db, { tenantId, inicio: inicioDre, fim: mes, hoje, config: cfg }) : null
  const itens = selecao?.itens ?? competenciaItens
  const eventosPerda = regime === 'competencia' ? eventosPerdaCompetencia : []
  const saldoInicio = dataCorte ? (regime === 'caixa_vencimento'
    ? (await saldosDreCaixa(db, { tenantId, meses: [mes], config: cfg })).get(mes)
    : await saldoCaixaInicioMes(db, { tenantId, mes, config: cfg })) : 0
  const caixa = dataCorte
    ? { saldo_inicio_mes: saldoInicio, saldo_abertura: r2(cfg.saldo_abertura), data_corte: dataCorte, origem: 'caixa' }
    : { saldo_inicio_mes: 0, saldo_abertura: 0, data_corte: null, origem: 'padrao' }
  return { hoje, regime, aliquota, data_corte: dataCorte, caixa, reconciliacao: selecao?.reconciliacao, ...montarDreDetalhe({ mes, itens, eventosPerda, aliquota, hoje }) }
}

/**
 * Fluxo de caixa do mês + série anual. Inclui obrigações antigas remarcadas
 * por vencimento e realizado pela data de cada liquidação/estorno.
 */
export async function calcularFluxoCaixa(db, { tenantId, mes, saldoInicial, hoje = hojeSaoPaulo() } = {}) {
  if (!RE_MES.test(String(mes ?? ''))) throw erro('mes deve estar no formato AAAA-MM')
  const ano = mes.slice(0, 4)
  const cfg = await buscarConfigFinanceiro(db, tenantId)
  const [itens, movimentos] = await Promise.all([
    listarLancamentos(db, {
      tenantId, inicio: addMeses(`${ano}-01`, -2), fim: `${ano}-12`, hoje,
      aliquota: cfg.aliquota_imposto_pct, dataCorte: cfg.data_corte,
      vencimentoDe: `${ano}-01-01`, vencimentoAte: `${ano}-12-31`, regraCorte: 'vencimento',
    }),
    lerMovimentosFinanceirosPeriodo(db, { tenantId, de: `${ano}-01-01`, ate: `${ano}-12-31`, dataCorte: cfg.data_corte }),
  ])
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
  return { ...montarFluxoCaixa({ mes, itens, movimentos: movimentos.itens, saldoInicial: saldo, saldoInicialOrigem: origem }), data_corte: cfg.data_corte }
}

// ─── Caixa (saldo de abertura + realizado desde o corte) ──────────────────

/** Realizado líquido por evento em [de, ate], usando a mesma leitura de Receita e DRE. */
export async function realizadoEntre(db, { tenantId, de, ate }) {
  const centavos = { receitas: 0n, avulsas: 0n, aportes: 0n, custos: 0n, apresentadoras: 0n, imposto: 0n }
  if (de && ate && ate >= de) {
    const { itens } = await lerMovimentosFinanceirosPeriodo(db, { tenantId, de, ate })
    for (const i of itens) {
      const chave = i.natureza === 'receita'
        ? ehAporte(i) ? 'aportes' : i.origem_tipo === 'receita_avulsa' ? 'avulsas' : 'receitas'
        : i.origem_tipo === 'imposto' ? 'imposto' : i.origem_tipo === 'apresentadora_pagamento' ? 'apresentadoras' : 'custos'
      centavos[chave] += exactMoneyToCents(String(i.valor))
    }
  }
  centavos.entradas = centavos.receitas + centavos.avulsas + centavos.aportes
  centavos.saidas = centavos.custos + centavos.apresentadoras + centavos.imposto
  return Object.fromEntries(Object.entries(centavos).map(([chave, valor]) => [chave, Number(centsToExactMoney(valor))]))
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
 * Saldo no início de vários meses com a mesma semântica de saldoCaixaInicioMes,
 * em uma única consulta. Mês anterior ao corte (ou configuração sem corte) → null.
 */
export async function saldosCaixaInicioMeses(db, { tenantId, meses, config }) {
  const lista = [...new Set((meses ?? []).filter((m) => RE_MES.test(String(m))))]
  const out = new Map(lista.map((m) => [m, null]))
  if (!lista.length) return out
  const cfg = config ?? await buscarConfigFinanceiro(db, tenantId)
  if (!cfg.data_corte) return out

  const corteMes = mesDe(cfg.data_corte)
  const elegiveis = lista.filter((m) => m >= corteMes)
  if (!elegiveis.length) return out

  const ate = diaAnterior(`${elegiveis.slice().sort().at(-1)}-01`)
  const movimentos = ate >= cfg.data_corte
    ? (await lerMovimentosFinanceirosPeriodo(db, { tenantId, de: cfg.data_corte, ate, dataCorte: cfg.data_corte })).itens
    : []
  for (const mes of elegiveis) {
    const total = movimentos.filter((i) => i.data < `${mes}-01`).reduce((saldo, i) =>
      saldo + exactMoneyToCents(String(i.valor)) * (i.natureza === 'receita' ? 1n : -1n), exactMoneyToCents(String(cfg.saldo_abertura ?? 0)))
    out.set(mes, Number(centsToExactMoney(total)))
  }
  return out
}

/**
 * Pura: em aberto (previsto − pago) de receitas e custos com vencimento em
 * [dataCorte, fimMes]. Itens já passaram pela regra de corte. Perdidos/cancelados
 * não têm saldo em aberto (emAberto = 0).
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
      ? listarLancamentos(db, { tenantId, inicio: mesIni, fim: mesFim, hoje, aliquota: config.aliquota_imposto_pct, dataCorte: corte, vencimentoDe: corte, vencimentoAte: fimMes, regraCorte: 'vencimento' })
      : [],
  ])
  return montarCaixa({ config, ate: dataAte, fimMes, realizado, realizadoPosAte, abertos: abertosAte(itens, { dataCorte: corte, fimMes }) })
}

function diaSeguinte(d) {
  const [y, m, dia] = String(d).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, dia + 1)).toISOString().slice(0, 10)
}

// ─── Painel do mês (GET /painel) ──────────────────────────────────────────

const ZERO_REALIZADO = { receitas: 0, avulsas: 0, aportes: 0, custos: 0, apresentadoras: 0, imposto: 0, entradas: 0, saidas: 0 }

/**
 * Pura: em aberto de UMA natureza com vencimento efetivo em [dataCorte, fimMes] (sem corte:
 * sem limite inferior). `no_mes` = vence dentro do mês; `atrasado_anterior` = vence antes do
 * 1º dia do mês; `atrasados` = vence antes de `hoje` (qualquer um dos dois) — para o chip.
 * Perdido/cancelado não tem saldo (emAberto = 0). Mesma regra de abertosAte.
 */
export function resumirAbertos(itens, { natureza, dataCorte = null, mes, hoje }) {
  const inicioMes = `${mes}-01`
  const fimMes = ultimoDia(mes)
  const piso = dataCorte ? String(dataCorte).slice(0, 10) : '0000-00-00'
  const acc = { no_mes: 0, atrasado_anterior: 0, qtd: 0, atr_qtd: 0, atr_valor: 0 }
  for (const i of itens) {
    if (i.natureza !== natureza) continue
    const venc = vencimentoEfetivo(i)
    if (!venc || venc < piso || venc > fimMes) continue
    const aberto = emAberto(i)
    if (!(aberto > 0)) continue
    if (venc < inicioMes) acc.atrasado_anterior += aberto
    else acc.no_mes += aberto
    acc.qtd += 1
    if (venc < hoje) { acc.atr_qtd += 1; acc.atr_valor += aberto }
  }
  return {
    no_mes: r2(acc.no_mes),
    atrasado_anterior: r2(acc.atrasado_anterior),
    total: r2(acc.no_mes + acc.atrasado_anterior),
    qtd: acc.qtd,
    atrasados: { qtd: acc.atr_qtd, valor: r2(acc.atr_valor) },
  }
}

/**
 * Pura: projeção de comissão do mês corrente (competência = mês de `hoje`). Considera itens
 * `marca_comissao` não encerrados e sem pagamento; projetado = previsto_atual ÷ dias_decorridos
 * × dias_mes (dia do mês ≥ dias_mes → projetado = previsto_atual). `vence_em` = MAIOR vencimento
 * dos itens (conservador: só "entra no painel" se todos vencem até o fim do mês do painel).
 * Nunca entra nos totais reais. Sem itens → null.
 */
export function projetarComissao({ itens, hoje, fimMes }) {
  const competencia = hoje.slice(0, 7)
  const alvo = itens.filter((i) => i.origem === 'marca_comissao' && mesDe(i.competencia) === competencia
    && !encerrado(i) && !(Number(i.valor_pago) > 0))
  if (!alvo.length) return null
  const previstoAtual = r2(alvo.reduce((s, i) => s + (Number(i.valor_previsto) || 0), 0))
  const diasMes = diasNoMes(competencia)
  const diasDecorridos = Math.max(1, Number(hoje.slice(8, 10)) || 1)
  const projetado = diasDecorridos >= diasMes ? previstoAtual : r2((previstoAtual / diasDecorridos) * diasMes)
  const vencs = alvo.map(vencimentoEfetivo).filter(Boolean).sort()
  const venceEm = vencs.length ? vencs[vencs.length - 1] : null
  return {
    competencia,
    previsto_atual: previstoAtual,
    projetado,
    ajuste: r2(projetado - previstoAtual),
    dias_decorridos: diasDecorridos,
    dias_mes: diasMes,
    qtd: alvo.length,
    vence_em: venceEm,
    entra_no_painel: Boolean(venceEm && venceEm <= fimMes),
  }
}

/**
 * Pura: contrato de GET /painel. `itens` = lançamentos (com corte) que cobrem [corte−2m, mes];
 * `realizadoAte` = realizado [corte, ate]; `realizadoPos` = (ate, fim_mes]; `realizadoMes` =
 * [max(1º do mês, corte), fim_mes] por data de pagamento. `competencia` é só referência (DRE).
 */
export function montarPainel({
  mes, hoje, config, itens, itensAbertos = itens, realizadoAte = ZERO_REALIZADO, realizadoPos = ZERO_REALIZADO,
  realizadoMes = ZERO_REALIZADO, eventosPerda = [], aliquota = ALIQUOTA_IMPOSTO_PADRAO,
}) {
  const fimMes = ultimoDia(mes)
  const mesAtual = hoje.slice(0, 7)
  const configurado = Boolean(config?.data_corte)
  const corte = configurado ? String(config.data_corte).slice(0, 10) : null
  const abertura = configurado ? r2(config.saldo_abertura) : 0
  const ate = hoje < fimMes ? hoje : fimMes

  const saldoAtual = configurado ? r2(abertura + realizadoAte.entradas - realizadoAte.saidas) : 0
  const aReceber = resumirAbertos(itensAbertos, { natureza: 'receita', dataCorte: corte, mes, hoje })
  const aPagar = resumirAbertos(itensAbertos, { natureza: 'custo', dataCorte: corte, mes, hoje })
  const projetado = configurado
    ? r2(saldoAtual + realizadoPos.entradas - realizadoPos.saidas + aReceber.total - aPagar.total)
    : 0

  // Mês passado: a comissão em andamento é de competência posterior ao painel — sem projeção.
  const projecao = mes < mesAtual ? null : projetarComissao({ itens, hoje, fimMes })
  const ritmo = configurado && projecao?.entra_no_painel && projecao.ajuste > 0 ? r2(projetado + projecao.ajuste) : null

  const impostos = new Map(itens.filter((i) => i.origem === 'imposto')
    .map((i) => [mesDe(i.competencia), { aliquota: i.aliquota, base: i.base }]))
  const [dre] = montarDre({ meses: [mes], itens, eventosPerda, impostos, aliquota }).meses
  const custos = {
    previsto: r2(dre.custos_fixos.previsto + dre.custos_variaveis.previsto),
    realizado: r2(dre.custos_fixos.realizado + dre.custos_variaveis.realizado),
  }

  return {
    mes,
    hoje,
    fim_mes: fimMes,
    mes_relativo: mes < mesAtual ? 'passado' : mes > mesAtual ? 'futuro' : 'corrente',
    configurado,
    data_corte: corte,
    saldo_abertura: abertura,
    caixa: { saldo_atual: saldoAtual, ate },
    recebido_mes: {
      total: r2(realizadoMes.entradas),
      receitas: r2(realizadoMes.receitas + realizadoMes.avulsas),
      aportes: r2(realizadoMes.aportes),
    },
    pago_mes: { total: r2(realizadoMes.saidas) },
    a_receber: aReceber,
    a_pagar: aPagar,
    projetado_fim_mes: projetado,
    projecao_comissao: projecao,
    projetado_fim_mes_ritmo: ritmo,
    competencia: {
      receita: dre.receita,
      custos,
      resultado: dre.resultado,
    },
  }
}

/**
 * GET /painel?mes=: carrega os lançamentos UMA vez na janela [mes−12m, mes],
 * com o corte financeiro aplicado aos itens, e delega a montarPainel.
 */
export async function calcularPainelMes(db, { tenantId, mes, hoje = hojeSaoPaulo() } = {}) {
  if (!tenantId) throw erro('tenantId é obrigatório', 400, 'INVALID_SCOPE')
  if (!RE_MES.test(String(mes ?? ''))) throw erro('mes deve estar no formato AAAA-MM')
  const config = await buscarConfigFinanceiro(db, tenantId)
  const corte = config.data_corte
  const fimMes = ultimoDia(mes)
  const ate = hoje < fimMes ? hoje : fimMes
  const inicio = addMeses(mes, -12)
  const deMes = corte && corte > `${mes}-01` ? corte : `${mes}-01`
  const [itens, eventosPerda, realizadoAte, realizadoPos, realizadoMes] = await Promise.all([
    listarLancamentos(db, { tenantId, inicio, fim: mes, hoje, aliquota: config.aliquota_imposto_pct, dataCorte: corte, vencimentoDe: corte ?? '0001-01-01', vencimentoAte: fimMes, regraCorte: 'nenhum' }),
    listarEventosPerdaDre(db, { tenantId, inicio: mes, fim: mes }),
    corte ? realizadoEntre(db, { tenantId, de: corte, ate }) : ZERO_REALIZADO,
    corte ? realizadoEntre(db, { tenantId, de: ate >= corte ? diaSeguinte(ate) : corte, ate: fimMes }) : ZERO_REALIZADO,
    realizadoEntre(db, { tenantId, de: deMes, ate: fimMes }),
  ])
  return montarPainel({
    mes, hoje, config, itens: aplicarCorte(itens, corte), itensAbertos: itens, eventosPerda, realizadoAte, realizadoPos, realizadoMes, aliquota: config.aliquota_imposto_pct,
  })
}
