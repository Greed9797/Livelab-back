/**
 * Núcleo de cálculo do financeiro (funções puras, sem I/O).
 *
 * Metodologia: planilha CONTROLE_FINANCEIRO_LIVELAB.
 *  - Datas trafegam como strings: mês 'YYYY-MM', dia 'YYYY-MM-DD' (sem Date → sem bug de fuso).
 *  - Receita de competência M = fixo dos contratos vigentes em M
 *    + comissão sobre o GMV de M-1 (cobrada em M, no dia de vencimento do contrato).
 *  - Comissão de apresentadora segue a mesma defasagem (GMV de M-1 pago em M).
 *  - Imposto = aliquota × receita do mês (previsto sobre previsto, realizado sobre recebido).
 *  - Resultado = receita + aportes - custos fixos - custos variáveis - imposto.
 */

export const GRUPOS_FIXOS = ['operacional', 'investimento', 'diversos', 'estrutural', 'prolabore']
export const GRUPOS_VARIAVEIS = ['variavel_comissao', 'variavel_produtos', 'variavel_diversos', 'cartao']
export const GRUPOS_CUSTO = [...GRUPOS_FIXOS, ...GRUPOS_VARIAVEIS, 'aporte']

/** Dias de vencimento usados como linhas do fluxo de caixa. */
export const BUCKETS_FLUXO = ['5', '10', '15', '20', '25', '30', 'cartao']
export const BUCKET_IMPOSTO = '20'
export const BUCKET_COMISSAO_APRESENTADORA = '5'
export const ALIQUOTA_IMPOSTO_DEFAULT = 6

/** Contrato sem data de término fica vigente enquanto estiver nesses status. */
const STATUS_VIGENTE = ['ativo']

const RE_MES = /^\d{4}-(0[1-9]|1[0-2])$/
const RE_DIA = /^\d{4}-\d{2}-\d{2}$/

export const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100
export const toNum = (v) => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

// ─── Datas (strings) ────────────────────────────────────────────────────────

export function mesValido(mes) {
  return typeof mes === 'string' && RE_MES.test(mes)
}

export function addMeses(mes, n) {
  const [y, m] = mes.split('-').map(Number)
  const total = y * 12 + (m - 1) + n
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}`
}

/** Lista inclusiva de meses entre inicio e fim ('YYYY-MM'). */
export function mesesEntre(inicio, fim) {
  const out = []
  for (let m = inicio; m <= fim; m = addMeses(m, 1)) out.push(m)
  return out
}

export const primeiroDia = (mes) => `${mes}-01`

export function diasNoMes(mes) {
  const [y, m] = mes.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export const ultimoDia = (mes) => `${mes}-${String(diasNoMes(mes)).padStart(2, '0')}`

/** 'YYYY-MM-DD' (ou Date) → 'YYYY-MM'. */
export function mesDe(data) {
  if (!data) return null
  if (data instanceof Date) {
    // pg converte DATE em Date à meia-noite local — usa componentes locais
    return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}`
  }
  return String(data).slice(0, 7)
}

export function diaStr(data) {
  if (!data) return null
  if (data instanceof Date) {
    return `${mesDe(data)}-${String(data.getDate()).padStart(2, '0')}`
  }
  return String(data).slice(0, 10)
}

/** Data de vencimento no mês (dia limitado ao último dia; null = último dia). */
export function vencimentoNoMes(mes, dia) {
  const max = diasNoMes(mes)
  const d = dia ? Math.min(Math.max(1, Number(dia)), max) : max
  return `${mes}-${String(d).padStart(2, '0')}`
}

/**
 * Resolve o período a partir dos query params.
 * Aceita: inicio=YYYY-MM&fim=YYYY-MM | mes=YYYY-MM | periodo=YYYY-MM | mes=M&ano=YYYY | nada (mês de `hoje`).
 * Retorna { inicio, fim } ('YYYY-MM') ou { error }.
 */
export function resolverPeriodo(query = {}, hoje = new Date().toISOString().slice(0, 10), { maxMeses = 36 } = {}) {
  const q = query ?? {}
  let inicio
  let fim
  if (q.inicio || q.fim) {
    inicio = String(q.inicio ?? q.fim)
    fim = String(q.fim ?? q.inicio)
  } else if (mesValido(String(q.mes ?? ''))) {
    inicio = fim = String(q.mes)
  } else if (q.mes && q.ano) {
    inicio = fim = `${q.ano}-${String(q.mes).padStart(2, '0')}`
  } else if (mesValido(String(q.periodo ?? ''))) {
    inicio = fim = String(q.periodo)
  } else {
    inicio = fim = hoje.slice(0, 7)
  }
  if (!mesValido(inicio) || !mesValido(fim)) return { error: 'Período inválido. Formato: YYYY-MM' }
  if (fim < inicio) return { error: 'fim deve ser maior ou igual a inicio' }
  if (mesesEntre(inicio, fim).length > maxMeses) return { error: `Período máximo: ${maxMeses} meses` }
  return { inicio, fim }
}

// ─── Contratos ──────────────────────────────────────────────────────────────

/**
 * Data (YYYY-MM-DD) em que o contrato deixou de valer, ou null se segue vigente.
 * contrato: { status, ativado_em, fim_em } — fim_em = COALESCE(cancelado_em, cancelado_automaticamente_em, arquivado_em).
 * Retorna undefined quando o contrato não pode ser considerado (ex.: não-ativo sem data de término).
 */
export function fimEfetivoContrato(contrato) {
  const ativado = diaStr(contrato.ativado_em)
  const fim = diaStr(contrato.fim_em)
  const vigente = STATUS_VIGENTE.includes(contrato.status)
  if (vigente) {
    // Reativado depois de cancelado: cancelado_em antigo não encerra o contrato
    if (!fim || fim < ativado) return null
    return fim
  }
  if (!fim || fim < ativado) return undefined
  return fim
}

/**
 * Contrato conta no mês M se ativado_em <= último dia de M
 * e (sem término ou término >= primeiro dia de M). Mês cheio, sem pró-rata.
 */
export function contratoVigenteNoMes(contrato, mes) {
  const ativado = diaStr(contrato.ativado_em)
  if (!ativado) return false
  const fim = fimEfetivoContrato(contrato)
  if (fim === undefined) return false
  if (ativado > ultimoDia(mes)) return false
  return fim === null || fim >= primeiroDia(mes)
}

/** Soma do fixo de contratos mês a mês (NÃO multiplica contratos de hoje pelo nº de meses). */
export function fixoContratosPorPeriodo(contratos, meses) {
  const porMes = {}
  for (const mes of meses) {
    porMes[mes] = r2(contratos
      .filter((c) => contratoVigenteNoMes(c, mes))
      .reduce((s, c) => s + toNum(c.valor_fixo), 0))
  }
  return { porMes, total: r2(Object.values(porMes).reduce((s, v) => s + v, 0)) }
}

/** Index de vendas: `${cliente_id}|${mes}` → { comissao_franquia, gmv, comissao_apresentadora }. */
function indexarVendas(vendas) {
  const idx = new Map()
  for (const v of vendas ?? []) {
    const key = `${v.cliente_id ?? ''}|${v.mes}`
    const cur = idx.get(key) ?? { comissao_franquia: 0, gmv: 0, comissao_apresentadora: 0 }
    cur.comissao_franquia += toNum(v.comissao_franquia)
    cur.gmv += toNum(v.gmv)
    cur.comissao_apresentadora += toNum(v.comissao_apresentadora)
    idx.set(key, cur)
  }
  return idx
}

/**
 * Receitas calculadas (sem considerar lançamentos existentes) para a competência `mes`.
 *  - fixo: contrato vigente em `mes`.
 *  - comissão: vendas do mês anterior do cliente, atribuídas ao contrato vigente naquele mês
 *    (se houver mais de um para o mesmo cliente, o de ativado_em mais recente).
 */
export function receitasCalculadasMes(mes, contratos, vendas) {
  const mesGmv = addMeses(mes, -1)
  const idx = indexarVendas(vendas)

  // Contrato que recebe a comissão de cada cliente (vigente no mês do GMV)
  const donoComissao = new Map()
  for (const c of contratos) {
    if (!c.cliente_id || !contratoVigenteNoMes(c, mesGmv)) continue
    const atual = donoComissao.get(c.cliente_id)
    const chave = `${diaStr(c.ativado_em)}|${c.id}`
    if (!atual || chave > `${diaStr(atual.ativado_em)}|${atual.id}`) donoComissao.set(c.cliente_id, c)
  }

  const out = []
  for (const c of contratos) {
    const vigente = contratoVigenteNoMes(c, mes)
    const donoDaComissao = donoComissao.get(c.cliente_id)?.id === c.id
    const venda = donoDaComissao ? idx.get(`${c.cliente_id}|${mesGmv}`) : null
    const comissao = r2(venda?.comissao_franquia ?? 0)
    if (!vigente && comissao <= 0) continue
    out.push({
      contrato_id: c.id,
      cliente_id: c.cliente_id ?? null,
      cliente_nome: c.cliente_nome ?? null,
      competencia: primeiroDia(mes),
      fixo_previsto: vigente ? r2(c.valor_fixo) : 0,
      comissao_prevista: comissao,
      gmv_base: r2(venda?.gmv ?? 0),
      dia_vencimento: c.dia_vencimento ?? null,
    })
  }
  return out
}

/**
 * Plano de geração idempotente das receitas previstas de `mes`.
 * existentes: linhas de receitas_previstas já gravadas na competência.
 * Regras: insere o que falta; atualiza só linhas "intocadas" (status previsto, nada recebido,
 * sem ajuste manual) cujos valores mudaram; o resto fica como está.
 */
export function planejarGeracaoReceitas({ mes, contratos, vendas, existentes = [] }) {
  const calculadas = receitasCalculadasMes(mes, contratos, vendas)
  const porContrato = new Map(existentes.filter((e) => e.contrato_id).map((e) => [e.contrato_id, e]))
  const inserir = []
  const atualizar = []
  const inalteradas = []
  for (const calc of calculadas) {
    const ex = porContrato.get(calc.contrato_id)
    if (!ex) { inserir.push(calc); continue }
    const intocada = ex.status === 'previsto' && !ex.ajuste_manual
      && toNum(ex.fixo_recebido) === 0 && toNum(ex.comissao_recebida) === 0
    const igual = r2(ex.fixo_previsto) === calc.fixo_previsto
      && r2(ex.comissao_prevista) === calc.comissao_prevista
      && r2(ex.gmv_base) === calc.gmv_base
      && (ex.dia_vencimento ?? null) === (calc.dia_vencimento ?? null)
    if (intocada && !igual) atualizar.push({ id: ex.id, ...calc })
    else inalteradas.push(ex.id)
  }
  return { inserir, atualizar, inalteradas }
}

/** Status efetivo de uma receita prevista (atrasado é derivado da data de hoje). */
export function statusReceita(row, hoje = new Date().toISOString().slice(0, 10)) {
  const previsto = r2(toNum(row.fixo_previsto) + toNum(row.comissao_prevista))
  const recebido = r2(toNum(row.fixo_recebido) + toNum(row.comissao_recebida))
  if (recebido > 0 && recebido >= previsto) return 'recebido'
  const mes = mesDe(row.competencia)
  if (mes && previsto > 0 && vencimentoNoMes(mes, row.dia_vencimento) < hoje) return 'atrasado'
  return recebido > 0 ? 'parcial' : 'previsto'
}

// ─── Custos recorrentes ─────────────────────────────────────────────────────

export function recorrenteVigenteNoMes(rec, mes) {
  if (rec.ativo === false) return false
  const inicio = diaStr(rec.inicio)
  const fim = diaStr(rec.fim)
  if (!inicio || inicio > ultimoDia(mes)) return false
  return !fim || fim >= primeiroDia(mes)
}

/**
 * Plano de geração idempotente dos custos do mês a partir de custos_recorrentes.
 * existentes: custos já materializados ({ recorrente_id, competencia }).
 */
export function planejarGeracaoCustos({ mes, recorrentes, existentes = [] }) {
  const ja = new Set(existentes
    .filter((e) => e.recorrente_id && mesDe(e.competencia) === mes)
    .map((e) => e.recorrente_id))
  const inserir = []
  for (const rec of recorrentes) {
    if (!recorrenteVigenteNoMes(rec, mes) || ja.has(rec.id)) continue
    inserir.push({
      recorrente_id: rec.id,
      descricao: rec.nome,
      observacao: rec.descricao ?? null,
      grupo: rec.grupo,
      valor: r2(rec.valor),
      dia_vencimento: rec.dia_vencimento ?? null,
      cartao: Boolean(rec.cartao),
      competencia: primeiroDia(mes),
    })
  }
  return { inserir }
}

// ─── Itens do mês (base do DRE e do fluxo) ──────────────────────────────────

/** Linha do fluxo de caixa para um dia de vencimento. null → '30' (fim do mês). */
export function bucketVencimento(dia, cartao = false) {
  if (cartao) return 'cartao'
  const d = Number(dia)
  if (!d) return '30'
  for (const b of ['5', '10', '15', '20', '25', '30']) {
    if (d <= Number(b)) return b
  }
  return '30'
}

function categoriaCusto(c) {
  if (c.tipo === 'imposto') return 'imposto'
  if (c.grupo === 'aporte') return 'aporte'
  return GRUPOS_FIXOS.includes(c.grupo) ? 'custo_fixo' : 'custo_variavel'
}

/**
 * Monta os itens (entradas/saídas, previsto x realizado) de um mês.
 * dados: { contratos, vendas, receitas, custos, recorrentes, aliquota }
 *  - vendas: [{ cliente_id, mes, comissao_franquia, gmv, comissao_apresentadora }]
 *  - receitas: linhas de receitas_previstas; custos: linhas de custos (com grupo/status).
 */
export function montarItensMes(dados, mes) {
  const itens = []
  const aliquota = toNum(dados.aliquota ?? ALIQUOTA_IMPOSTO_DEFAULT)

  // Receitas: lançadas + calculadas para contratos ainda sem lançamento
  const receitasMes = (dados.receitas ?? []).filter((r) => mesDe(r.competencia) === mes)
  const contratosLancados = new Set(receitasMes.map((r) => r.contrato_id).filter(Boolean))
  const virtuais = receitasCalculadasMes(mes, dados.contratos ?? [], dados.vendas ?? [])
    .filter((r) => !contratosLancados.has(r.contrato_id))
  const addReceita = (r, origem) => {
    const bucket = bucketVencimento(r.dia_vencimento)
    const base = { mes, natureza: 'entrada', bucket, origem, ref_id: r.id ?? r.contrato_id ?? null }
    itens.push({ ...base, categoria: 'receita_fixo', grupo: null,
      previsto: r2(r.fixo_previsto), realizado: r2(r.fixo_recebido ?? 0) })
    itens.push({ ...base, categoria: 'receita_comissao', grupo: null,
      previsto: r2(r.comissao_prevista), realizado: r2(r.comissao_recebida ?? 0) })
  }
  receitasMes.forEach((r) => addReceita(r, 'receita'))
  virtuais.forEach((r) => addReceita(r, 'contrato'))

  // Custos lançados
  const custosMes = (dados.custos ?? []).filter((c) => mesDe(c.competencia) === mes)
  for (const c of custosMes) {
    const categoria = categoriaCusto(c)
    itens.push({
      mes,
      natureza: categoria === 'aporte' ? 'entrada' : 'saida',
      categoria,
      grupo: c.grupo ?? 'diversos',
      bucket: bucketVencimento(c.dia_vencimento, c.cartao || c.grupo === 'cartao'),
      previsto: r2(c.valor),
      realizado: c.status === 'pago' ? r2(c.valor) : 0,
      origem: 'custo',
      ref_id: c.id ?? null,
    })
  }

  // Recorrentes ainda não materializados no mês
  const materializados = new Set(custosMes.map((c) => c.recorrente_id).filter(Boolean))
  for (const rec of dados.recorrentes ?? []) {
    if (materializados.has(rec.id) || !recorrenteVigenteNoMes(rec, mes)) continue
    const categoria = categoriaCusto(rec)
    itens.push({
      mes,
      natureza: categoria === 'aporte' ? 'entrada' : 'saida',
      categoria,
      grupo: rec.grupo,
      bucket: bucketVencimento(rec.dia_vencimento, rec.cartao || rec.grupo === 'cartao'),
      previsto: r2(rec.valor),
      realizado: 0,
      origem: 'recorrente',
      ref_id: rec.id,
    })
  }

  // Comissão de apresentadoras (vendas do mês anterior) — só se não houver lançamento no grupo
  const temComissaoLancada = itens.some((i) => i.grupo === 'variavel_comissao')
  if (!temComissaoLancada) {
    const mesGmv = addMeses(mes, -1)
    const total = r2((dados.vendas ?? [])
      .filter((v) => v.mes === mesGmv)
      .reduce((s, v) => s + toNum(v.comissao_apresentadora), 0))
    if (total > 0) {
      itens.push({ mes, natureza: 'saida', categoria: 'custo_variavel', grupo: 'variavel_comissao',
        bucket: BUCKET_COMISSAO_APRESENTADORA, previsto: total, realizado: 0, origem: 'vendas', ref_id: null })
    }
  }

  // Imposto calculado — só se não houver lançamento de imposto no mês
  if (!itens.some((i) => i.categoria === 'imposto')) {
    const recPrev = itens.filter((i) => i.categoria.startsWith('receita_')).reduce((s, i) => s + i.previsto, 0)
    const recReal = itens.filter((i) => i.categoria.startsWith('receita_')).reduce((s, i) => s + i.realizado, 0)
    const prev = r2(recPrev * aliquota / 100)
    const real = r2(recReal * aliquota / 100)
    if (prev > 0 || real > 0) {
      itens.push({ mes, natureza: 'saida', categoria: 'imposto', grupo: null, bucket: BUCKET_IMPOSTO,
        previsto: prev, realizado: real, origem: 'imposto', ref_id: null })
    }
  }

  return itens
}

// ─── DRE ────────────────────────────────────────────────────────────────────

function dreVazio() {
  return {
    receita: { fixo: 0, comissao: 0, total: 0 },
    aportes: 0,
    custos_fixos: { total: 0, por_grupo: {} },
    custos_variaveis: { total: 0, por_grupo: {} },
    imposto: 0,
    resultado: 0,
  }
}

function dreDe(itens, campo) {
  const d = dreVazio()
  for (const i of itens) {
    const v = i[campo]
    switch (i.categoria) {
      case 'receita_fixo': d.receita.fixo += v; break
      case 'receita_comissao': d.receita.comissao += v; break
      case 'aporte': d.aportes += v; break
      case 'imposto': d.imposto += v; break
      case 'custo_fixo':
        d.custos_fixos.total += v
        d.custos_fixos.por_grupo[i.grupo] = (d.custos_fixos.por_grupo[i.grupo] ?? 0) + v
        break
      case 'custo_variavel':
        d.custos_variaveis.total += v
        d.custos_variaveis.por_grupo[i.grupo] = (d.custos_variaveis.por_grupo[i.grupo] ?? 0) + v
        break
      default: break
    }
  }
  d.receita.fixo = r2(d.receita.fixo)
  d.receita.comissao = r2(d.receita.comissao)
  d.receita.total = r2(d.receita.fixo + d.receita.comissao)
  d.aportes = r2(d.aportes)
  d.imposto = r2(d.imposto)
  d.custos_fixos.total = r2(d.custos_fixos.total)
  d.custos_variaveis.total = r2(d.custos_variaveis.total)
  for (const k of Object.keys(d.custos_fixos.por_grupo)) d.custos_fixos.por_grupo[k] = r2(d.custos_fixos.por_grupo[k])
  for (const k of Object.keys(d.custos_variaveis.por_grupo)) d.custos_variaveis.por_grupo[k] = r2(d.custos_variaveis.por_grupo[k])
  d.resultado = r2(d.receita.total + d.aportes - d.custos_fixos.total - d.custos_variaveis.total - d.imposto)
  return d
}

/** DRE previsto x realizado de um conjunto de itens. */
export function calcularDRE(itens) {
  return { previsto: dreDe(itens, 'previsto'), realizado: dreDe(itens, 'realizado') }
}

/** DRE por mês + consolidado do período. */
export function calcularDREPeriodo(dados, meses) {
  const itensPorMes = meses.map((mes) => montarItensMes(dados, mes))
  const porMes = meses.map((mes, i) => ({ mes, ...calcularDRE(itensPorMes[i]) }))
  return { meses: porMes, total: calcularDRE(itensPorMes.flat()) }
}

// ─── Fluxo de caixa ─────────────────────────────────────────────────────────

function somar(itens, natureza, campo) {
  return r2(itens.filter((i) => i.natureza === natureza).reduce((s, i) => s + i[campo], 0))
}

/**
 * Linhas por dia de vencimento com saldo acumulado ao longo do mês.
 * saldoInicial: { previsto, realizado } — acumulado dos meses anteriores do ano.
 */
export function calcularFluxoMes(itens, saldoInicial = { previsto: 0, realizado: 0 }) {
  let accPrev = toNum(saldoInicial.previsto)
  let accReal = toNum(saldoInicial.realizado)
  return BUCKETS_FLUXO.map((bucket) => {
    const doDia = itens.filter((i) => i.bucket === bucket)
    const entradas_previstas = somar(doDia, 'entrada', 'previsto')
    const saidas_previstas = somar(doDia, 'saida', 'previsto')
    const entradas_realizadas = somar(doDia, 'entrada', 'realizado')
    const saidas_realizadas = somar(doDia, 'saida', 'realizado')
    const saldo_previsto = r2(entradas_previstas - saidas_previstas)
    const saldo_realizado = r2(entradas_realizadas - saidas_realizadas)
    accPrev = r2(accPrev + saldo_previsto)
    accReal = r2(accReal + saldo_realizado)
    return {
      dia: bucket,
      entradas_previstas, saidas_previstas, saldo_previsto, acumulado_previsto: accPrev,
      entradas_realizadas, saidas_realizadas, saldo_realizado, acumulado_realizado: accReal,
    }
  })
}

/** Série mensal (ex.: jan..dez) com saldo e acumulado a partir de saldoInicial. */
export function calcularSerieAnual(dados, meses, saldoInicial = { previsto: 0, realizado: 0 }) {
  let accPrev = toNum(saldoInicial.previsto)
  let accReal = toNum(saldoInicial.realizado)
  return meses.map((mes) => {
    const itens = montarItensMes(dados, mes)
    const saldo_inicial_previsto = accPrev
    const saldo_inicial_realizado = accReal
    const entradas_previstas = somar(itens, 'entrada', 'previsto')
    const saidas_previstas = somar(itens, 'saida', 'previsto')
    const entradas_realizadas = somar(itens, 'entrada', 'realizado')
    const saidas_realizadas = somar(itens, 'saida', 'realizado')
    const saldo_previsto = r2(entradas_previstas - saidas_previstas)
    const saldo_realizado = r2(entradas_realizadas - saidas_realizadas)
    accPrev = r2(accPrev + saldo_previsto)
    accReal = r2(accReal + saldo_realizado)
    return {
      mes,
      saldo_inicial_previsto, saldo_inicial_realizado,
      entradas_previstas, saidas_previstas, saldo_previsto, acumulado_previsto: accPrev,
      entradas_realizadas, saidas_realizadas, saldo_realizado, acumulado_realizado: accReal,
    }
  })
}
