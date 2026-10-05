// Receitas a partir do COMERCIAL (fonte única): fixo por vigência + comissão de
// franquia por marca/competência, com vencimento definido na condição comercial.
// O financeiro só consome: títulos virtuais (calculados) + `receita_titulos`
// (materializados/baixados). Status é sempre derivado (lib/lancamento-status.js).
import '../lib/pg-date-string.js'
import { marcasCondicaoVigenteMesSql, receitaMarcaMensalSql } from '../lib/receita-marca-sql.js'
import { normalizarMotivo, saldoEncerrado, statusLancamento, timestampIso } from '../lib/lancamento-status.js'
import { centsToExactMoney, exactMoneyToCents } from '../lib/money.js'
import { perdaJaRegistrada, requisicaoPerda } from '../lib/perda-idempotencia.js'
import { saoPauloDateInput } from '../lib/timezone.js'
import { ehAporte, listarReceitasAvulsas } from './receitas-avulsas.js'
// Ciclo estático intencional (o agregador importa este módulo): só usado em tempo de
// chamada, nunca no topo do módulo.
import { aplicarCorte, buscarConfigFinanceiro, dentroDoCorte, vencimentoEfetivo } from './financeiro-agregador.js'

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VIRTUAL_RE = /^calc:([0-9a-f-]{36}):(\d{4}-\d{2}):(fixo|comissao)$/i
export const COMPONENTES_RECEITA = Object.freeze(['fixo', 'comissao'])
export const MAX_MESES_RECEITAS = 36

const toNum = (v) => Number(v ?? 0)
const round2 = (v) => Math.round(toNum(v) * 100) / 100

function serviceError(message, code, statusCode = 400) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

const erroEncerrado = () => serviceError(
  'Título dado como perdido. Desfaça a perda/cancelamento antes de receber.', 'RECEITA_PERDIDA', 409,
)

/** Data de hoje (civil) em America/Sao_Paulo. */
export function hojeSaoPaulo(now = new Date()) {
  return saoPauloDateInput(now)
}

function dateKey(value) {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

function ultimoDiaDoMes(ano, mes) {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate()
}

/**
 * Vencimento = dia `dia` do mês (competência + offset). Dia maior que o último
 * dia do mês → último dia. `competencia` 'YYYY-MM' ou 'YYYY-MM-DD'.
 */
export function calcularVencimento(competencia, dia = 5, offset = 1) {
  const [ano, mes] = String(competencia).slice(0, 7).split('-').map(Number)
  const total = (mes - 1) + Number(offset ?? 0)
  const anoVenc = ano + Math.floor(total / 12)
  const mesVenc = (total % 12) + 1
  const diaVenc = Math.min(Math.max(1, Number(dia ?? 5)), ultimoDiaDoMes(anoVenc, mesVenc))
  return `${String(anoVenc).padStart(4, '0')}-${String(mesVenc).padStart(2, '0')}-${String(diaVenc).padStart(2, '0')}`
}

/**
 * Compõe fixo × comissão conforme tipo_cobranca, em títulos que SOMAM o total da regra:
 *   fixo_mais_comissao → fixo + comissão
 *   fixo_ou_comissao   → fixo (piso) + excedente da comissão sobre o fixo
 *                        (total = GREATEST(fixo, comissão), mesmo total do /resumo)
 */
export function comporReceitaMarca({ fixo = 0, comissao = 0, tipo_cobranca: tipo = 'fixo_mais_comissao' } = {}) {
  const f = round2(fixo)
  const c = round2(comissao)
  if (tipo === 'fixo_ou_comissao') {
    const excedente = round2(Math.max(0, c - f))
    return { fixo: f, comissao: excedente, total: round2(f + excedente), criterio_comissao: 'excedente_sobre_fixo' }
  }
  return { fixo: f, comissao: c, total: round2(f + c), criterio_comissao: 'gmv_x_pct' }
}

/** Normaliza período de competências: aceita 'YYYY-MM' ou 'YYYY-MM-DD'. */
export function resolverPeriodoCompetencia(inicio, fim = inicio) {
  const mesDe = (v, campo) => {
    const s = String(v ?? '')
    const m = s.match(/^(\d{4}-\d{2})(?:-\d{2})?$/)
    if (!m || !MONTH_RE.test(m[1])) throw serviceError(`${campo} deve estar no formato AAAA-MM`, 'INVALID_PERIOD')
    return m[1]
  }
  const ini = mesDe(inicio, 'inicio')
  const fi = mesDe(fim ?? inicio, 'fim')
  if (fi < ini) throw serviceError('fim deve ser maior ou igual a inicio', 'INVALID_PERIOD')
  const [iy, im] = ini.split('-').map(Number)
  const [fy, fm] = fi.split('-').map(Number)
  const meses = (fy - iy) * 12 + (fm - im) + 1
  if (meses > MAX_MESES_RECEITAS) throw serviceError(`Período máximo de ${MAX_MESES_RECEITAS} meses`, 'INVALID_PERIOD')
  return {
    startDate: `${ini}-01`,
    endDate: `${fi}-${String(ultimoDiaDoMes(fy, fm)).padStart(2, '0')}`,
    meses,
  }
}

function descricaoTitulo({ componente, marca_nome, competencia, tipo_cobranca }) {
  const mes = `${competencia.slice(5, 7)}/${competencia.slice(0, 4)}`
  if (componente === 'fixo') return `Fixo mensal — ${marca_nome} (${mes})`
  const sufixo = tipo_cobranca === 'fixo_ou_comissao' ? ' (excedente ao fixo)' : ''
  return `Comissão${sufixo} — ${marca_nome} (${mes})`
}

/**
 * Receita calculada pelo comercial no período [inicio, fim] (meses de competência).
 * Retorna um item por marca × competência × componente com valor > 0:
 * { marca_id, cliente_id, marca_nome, cliente_nome, competencia, componente, valor,
 *   tipo_cobranca, data_vencimento, condicao_id, memoria }
 */
export async function calcularReceitasComerciais(db, { tenantId, inicio, fim, fixo = 'vigencia' } = {}) {
  if (!tenantId) throw serviceError('tenantId é obrigatório', 'INVALID_SCOPE')
  const { startDate, endDate } = resolverPeriodoCompetencia(inicio, fim)
  const { rows } = await db.query(receitaMarcaMensalSql({ fixo }), [startDate, endDate, tenantId])
  const itens = []
  for (const r of rows) {
    const competencia = dateKey(r.competencia)
    const tipo = r.tipo_cobranca || 'fixo_mais_comissao'
    const comp = comporReceitaMarca({ fixo: r.fixo, comissao: r.comissao, tipo_cobranca: tipo })
    const base = {
      marca_id: r.marca_id,
      cliente_id: r.cliente_id ?? null,
      marca_nome: r.marca_nome,
      cliente_nome: r.cliente_nome ?? null,
      marca_tipo: r.marca_tipo,
      competencia,
      tipo_cobranca: tipo,
      condicao_id: r.condicao_id ?? null,
    }
    if (comp.fixo > 0) {
      itens.push({
        ...base,
        componente: 'fixo',
        valor: comp.fixo,
        data_vencimento: calcularVencimento(competencia, r.fixo_vencimento_dia, r.fixo_vencimento_mes_offset),
        memoria: {
          criterio: 'vigencia',
          fixo_mensal: round2(r.fixo_cheio),
          fator_rateio: Number(toNum(r.fator_meses).toFixed(6)),
          pct: toNum(r.comissao_franquia_pct),
        },
      })
    }
    if (comp.comissao > 0) {
      itens.push({
        ...base,
        componente: 'comissao',
        valor: comp.comissao,
        data_vencimento: calcularVencimento(competencia, r.comissao_vencimento_dia, r.comissao_vencimento_mes_offset),
        memoria: {
          criterio: comp.criterio_comissao,
          gmv: round2(r.gmv),
          pct: toNum(r.comissao_franquia_pct),
          comissao_bruta: round2(r.comissao),
          ...(tipo === 'fixo_ou_comissao' ? { fixo_comparado: round2(r.fixo) } : {}),
        },
      })
    }
  }
  return itens
}

const chave = (marcaId, competencia, componente) => `${marcaId}:${String(competencia).slice(0, 7)}:${componente}`

export function idVirtual({ marca_id, competencia, componente }) {
  return `calc:${marca_id}:${String(competencia).slice(0, 7)}:${componente}`
}

export function parseIdTitulo(id) {
  const text = String(id ?? '')
  if (UUID_RE.test(text)) return { tipo: 'materializado', id: text }
  const m = text.match(VIRTUAL_RE)
  if (m && UUID_RE.test(m[1]) && MONTH_RE.test(m[2])) {
    return { tipo: 'virtual', marca_id: m[1].toLowerCase(), mes: m[2], componente: m[3].toLowerCase() }
  }
  return null
}

function tituloPublico({ stored, calc, hoje }) {
  const src = stored ?? calc
  const competencia = dateKey(stored?.competencia ?? calc.competencia)
  const valorPrevisto = round2(stored ? stored.valor_previsto : calc.valor)
  const valorPago = round2(stored?.valor_pago ?? 0)
  const valorPerdido = stored?.valor_perdido == null
    ? (stored?.perdido_em ? round2(Math.max(0, valorPrevisto - valorPago)) : 0)
    : round2(stored.valor_perdido)
  const dataVencimento = dateKey(stored?.data_vencimento ?? calc.data_vencimento)
  const dataPagamento = dateKey(stored?.data_pagamento ?? null)
  const tipoCobranca = calc?.tipo_cobranca ?? stored?.tipo_cobranca ?? 'fixo_mais_comissao'
  const marcaNome = src.marca_nome ?? calc?.marca_nome ?? null
  const valorCalculado = round2(calc?.valor ?? 0)
  const item = {
    id: stored ? stored.id : idVirtual(calc),
    natureza: 'receita',
    origem: 'comercial',
    componente: src.componente,
    descricao: descricaoTitulo({ componente: src.componente, marca_nome: marcaNome ?? 'Marca', competencia, tipo_cobranca: tipoCobranca }),
    competencia,
    data_vencimento: dataVencimento,
    valor_previsto: valorPrevisto,
    valor_pago: valorPago,
    valor_perdido: valorPerdido,
    data_pagamento: dataPagamento,
    marca_id: src.marca_id,
    marca_nome: marcaNome,
    // 'cliente' gera receita; outro tipo só aparece por título materializado antigo
    // (antes do filtro de marcaGeraReceitaSql) — a tela sinaliza para revisão.
    marca_tipo: calc?.marca_tipo ?? stored?.marca_tipo ?? null,
    cliente_id: stored?.cliente_id ?? calc?.cliente_id ?? null,
    cliente_nome: src.cliente_nome ?? calc?.cliente_nome ?? null,
    tipo_cobranca: tipoCobranca,
    materializado: Boolean(stored),
    valor_calculado: valorCalculado,
    divergente: Boolean(stored) && Math.abs(valorCalculado - valorPrevisto) >= 0.01,
    observacao: stored?.observacao ?? null,
    memoria: calc?.memoria ?? null,
    perdido_em: timestampIso(stored?.perdido_em),
    perdido_motivo: stored?.perdido_motivo ?? null,
    perdido_por: stored?.perdido_por ?? null,
  }
  item.status = statusLancamento(item, hoje)
  if (stored?.valor_perdido != null && !stored.perdido_em && exactMoneyToCents(String(stored.valor_perdido)) > 0n &&
      exactMoneyToCents(String(stored.valor_pago)) + exactMoneyToCents(String(stored.valor_perdido)) >= exactMoneyToCents(String(stored.valor_previsto))) {
    item.status = 'perdido'
  }
  return item
}

async function listarMaterializados(db, { tenantId, startDate, endDate, marcaId = null, componente = null, id = null }) {
  const { rows } = await db.query(
    `SELECT rt.id, rt.tenant_id, rt.marca_id, rt.cliente_id, rt.competencia, rt.componente,
            rt.valor_previsto, rt.valor_pago, rt.data_vencimento, rt.data_pagamento, rt.observacao,
            rt.perdido_em, rt.perdido_motivo, rt.perdido_por, rt.valor_perdido,
            m.nome AS marca_nome, m.tipo AS marca_tipo, cl.nome AS cliente_nome, m.tipo_cobranca
       FROM receita_titulos rt
       JOIN marcas m ON m.id = rt.marca_id AND m.tenant_id = rt.tenant_id
       LEFT JOIN clientes cl ON cl.id = rt.cliente_id AND cl.tenant_id = rt.tenant_id
      WHERE rt.tenant_id = $1::uuid
        AND ($2::date IS NULL OR rt.competencia >= $2::date)
        AND ($3::date IS NULL OR rt.competencia <= $3::date)
        AND ($4::uuid IS NULL OR rt.marca_id = $4::uuid)
        AND ($5::text IS NULL OR rt.componente = $5::text)
        AND ($6::uuid IS NULL OR rt.id = $6::uuid)`,
    [tenantId, startDate, endDate, marcaId, componente, id],
  )
  return rows
}

/**
 * Títulos de receita do período: cálculo do comercial ∪ `receita_titulos`.
 * Título materializado prevalece (valor_previsto/vencimento/baixa gravados);
 * o valor recalculado fica em `valor_calculado` (+ `divergente`).
 * Filtros opcionais: status, marca_id, cliente_id, componente.
 */
export async function listarTitulosReceita(db, { tenantId, inicio, fim, hoje = hojeSaoPaulo(), status, marca_id: marcaId, cliente_id: clienteId, componente } = {}) {
  const { startDate, endDate } = resolverPeriodoCompetencia(inicio, fim)
  const [calculados, materializados] = await Promise.all([
    calcularReceitasComerciais(db, { tenantId, inicio: startDate, fim: endDate }),
    listarMaterializados(db, { tenantId, startDate, endDate }),
  ])
  const porChave = new Map(calculados.map((c) => [chave(c.marca_id, c.competencia, c.componente), c]))
  const itens = []
  for (const stored of materializados) {
    const key = chave(stored.marca_id, dateKey(stored.competencia), stored.componente)
    const calc = porChave.get(key) ?? null
    porChave.delete(key)
    if (round2(stored.valor_previsto) === 0 && round2(stored.valor_pago) === 0 && !calc) continue
    itens.push(tituloPublico({ stored, calc, hoje }))
  }
  for (const calc of porChave.values()) itens.push(tituloPublico({ stored: null, calc, hoje }))

  const filtrados = itens.filter((item) => (
    (!status || item.status === status)
    && (!marcaId || item.marca_id === marcaId)
    && (!clienteId || item.cliente_id === clienteId)
    && (!componente || item.componente === componente)
  ))
  filtrados.sort((a, b) => (
    String(a.data_vencimento).localeCompare(String(b.data_vencimento))
    || String(a.marca_nome ?? '').localeCompare(String(b.marca_nome ?? ''), 'pt-BR')
    || a.componente.localeCompare(b.componente)
  ))
  return filtrados
}

/**
 * Totais de uma listagem de títulos (previsto, pago, em aberto e por status).
 * `perdido` = saldo encerrado (previsto − pago) dos títulos perdidos; `em_aberto` o exclui.
 * `valor_previsto` NÃO desconta perdas (o previsto continua; a perda é linha própria).
 */
export function totalizarTitulos(itens = []) {
  const porStatus = {}
  let previsto = 0
  let pago = 0
  let perdido = 0
  for (const item of itens) {
    previsto += item.valor_previsto
    pago += item.valor_pago
    perdido += item.valor_perdido ?? saldoEncerrado(item)
    porStatus[item.status] = round2((porStatus[item.status] ?? 0) + item.valor_previsto)
  }
  return {
    valor_previsto: round2(previsto),
    valor_pago: round2(pago),
    em_aberto: round2(Math.max(0, previsto - pago - perdido)),
    perdido: round2(perdido),
    quantidade: itens.length,
    por_status: porStatus,
  }
}

/**
 * Cria/atualiza o título da chave (marca, competência, componente). Título PERDIDO é
 * preservado (nunca tem valor/vencimento atualizados): devolve { id, inserido:false, perdido:true }.
 */
async function upsertTitulo(db, { tenantId, calc, actorUserId }) {
  const { rows } = await db.query(
    `INSERT INTO receita_titulos (
       tenant_id, marca_id, cliente_id, competencia, componente,
       valor_previsto, data_vencimento, criado_por
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6, $7::date, $8::uuid)
     ON CONFLICT (tenant_id, marca_id, competencia, componente) DO UPDATE
       SET valor_previsto = EXCLUDED.valor_previsto,
           cliente_id = COALESCE(EXCLUDED.cliente_id, receita_titulos.cliente_id),
           -- vencimento só acompanha o comercial enquanto o título não teve baixa
           data_vencimento = CASE WHEN receita_titulos.valor_pago = 0 AND receita_titulos.data_pagamento IS NULL
                                  THEN EXCLUDED.data_vencimento ELSE receita_titulos.data_vencimento END,
           atualizado_em = NOW()
       WHERE receita_titulos.perdido_em IS NULL
         AND receita_titulos.valor_perdido IS NULL
     RETURNING id, (xmax = 0) AS inserido`,
    [tenantId, calc.marca_id, calc.cliente_id, calc.competencia, calc.componente, calc.valor, calc.data_vencimento, actorUserId ?? null],
  )
  if (rows[0]) return rows[0]
  // ON CONFLICT ... WHERE falso → título perdido existente, intocado.
  const existente = await db.query(
    `SELECT id FROM receita_titulos
      WHERE tenant_id = $1::uuid AND marca_id = $2::uuid AND competencia = $3::date AND componente = $4`,
    [tenantId, calc.marca_id, calc.competencia, calc.componente],
  )
  if (!existente.rows[0]) throw serviceError('Título de receita não encontrado', 'RECEITA_NOT_FOUND', 404)
  return { id: existente.rows[0].id, inserido: false, perdido: true }
}

async function lockReceitas(db, tenantId) {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('receita_titulos:' || $1::text))`, [tenantId])
}

/**
 * Materializa os títulos da competência `mes` (AAAA-MM) a partir do comercial:
 * cria os que faltam, atualiza valor previsto (e vencimento dos que não têm baixa)
 * e remove títulos sem baixa que o comercial não gera mais.
 * Título PERDIDO nunca é apagado nem tem valor/vencimento atualizados
 * (contado em `perdidos_preservados`).
 */
export async function gerarTitulosReceita(db, { tenantId, mes, actorUserId = null, hoje = hojeSaoPaulo() } = {}) {
  if (!MONTH_RE.test(String(mes ?? ''))) throw serviceError('mes deve estar no formato AAAA-MM', 'INVALID_PERIOD')
  await db.query('BEGIN')
  try {
    await lockReceitas(db, tenantId)
    const calculados = await calcularReceitasComerciais(db, { tenantId, inicio: mes, fim: mes })
    let criados = 0
    let atualizados = 0
    let perdidosPreservados = 0
    for (const calc of calculados) {
      const r = await upsertTitulo(db, { tenantId, calc, actorUserId })
      if (r?.perdido) perdidosPreservados += 1
      else if (r?.inserido) criados += 1
      else atualizados += 1
    }
    const manter = calculados.map((c) => `${c.marca_id}:${c.componente}`)
    const removidos = await db.query(
      `DELETE FROM receita_titulos
        WHERE tenant_id = $1::uuid AND competencia = $2::date
          AND valor_pago = 0 AND data_pagamento IS NULL AND perdido_em IS NULL
          AND valor_perdido IS NULL
          AND NOT ((marca_id::text || ':' || componente) = ANY($3::text[]))`,
      [tenantId, `${mes}-01`, manter],
    )
    await db.query('COMMIT')
    const itens = await listarTitulosReceita(db, { tenantId, inicio: mes, fim: mes, hoje })
    return { mes, criados, atualizados, removidos: removidos.rowCount ?? 0, perdidos_preservados: perdidosPreservados, itens }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {})
    throw error
  }
}

async function buscarTituloParaBaixa(db, { tenantId, ref, actorUserId }) {
  if (ref.tipo === 'virtual') {
    const calculados = await calcularReceitasComerciais(db, { tenantId, inicio: ref.mes, fim: ref.mes })
    const calc = calculados.find((c) => c.marca_id === ref.marca_id && c.componente === ref.componente)
    if (!calc) throw serviceError('Título de receita não encontrado', 'RECEITA_NOT_FOUND', 404)
    const { id } = await upsertTitulo(db, { tenantId, calc, actorUserId })
    ref = { tipo: 'materializado', id }
  }
  const { rows } = await db.query(
    `SELECT * FROM receita_titulos WHERE tenant_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
    [tenantId, ref.id],
  )
  if (!rows[0]) throw serviceError('Título de receita não encontrado', 'RECEITA_NOT_FOUND', 404)
  return rows[0]
}

async function tituloAtualizado(db, { tenantId, id, hoje }) {
  const [stored] = await listarMaterializados(db, { tenantId, startDate: null, endDate: null, id })
  if (!stored) return null
  const competencia = dateKey(stored.competencia)
  const calculados = await calcularReceitasComerciais(db, { tenantId, inicio: competencia, fim: competencia })
  const calc = calculados.find((c) => c.marca_id === stored.marca_id && c.componente === stored.componente) ?? null
  return tituloPublico({ stored, calc, hoje })
}

/**
 * Baixa (total ou parcial) de um título. `valorPago` é o total recebido
 * (default = valor previsto); `dataPagamento` default = hoje (SP).
 * Aceita id de título materializado (uuid) ou virtual (`calc:<marca>:<AAAA-MM>:<componente>`).
 */
export async function receberTitulo(db, { tenantId, id, valorPago, dataPagamento, observacao, hoje = hojeSaoPaulo(), actorUserId = null } = {}) {
  const ref = parseIdTitulo(id)
  if (!ref) throw serviceError('Título de receita não encontrado', 'RECEITA_NOT_FOUND', 404)
  if (dataPagamento != null && !DATE_RE.test(String(dataPagamento))) {
    throw serviceError('data_pagamento deve estar no formato AAAA-MM-DD', 'INVALID_PAYMENT')
  }
  await db.query('BEGIN')
  let tituloId
  try {
    await lockReceitas(db, tenantId)
    const titulo = await buscarTituloParaBaixa(db, { tenantId, ref, actorUserId })
    if (titulo.perdido_em && titulo.valor_perdido == null) throw erroEncerrado()
    const perdido = titulo.valor_perdido == null ? 0n : exactMoneyToCents(titulo.valor_perdido)
    const previsto = exactMoneyToCents(titulo.valor_previsto)
    const maximoRecebivel = previsto > perdido ? previsto - perdido : 0n
    if (maximoRecebivel <= exactMoneyToCents(titulo.valor_pago)) throw erroEncerrado()
    const valor = valorPago == null ? maximoRecebivel : exactMoneyToCents(round2(valorPago).toFixed(2))
    if (valor <= 0n) throw serviceError('valor_pago deve ser maior que zero', 'INVALID_PAYMENT')
    if (valor > maximoRecebivel) {
      throw serviceError('valor_pago excede o saldo após perdas', 'INVALID_PAYMENT', 409)
    }
    await db.query(
      `UPDATE receita_titulos
          SET valor_pago = $3::numeric, data_pagamento = $4::date,
              observacao = COALESCE($5, observacao), atualizado_em = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, titulo.id, centsToExactMoney(valor), dataPagamento ?? hoje, observacao ?? null],
    )
    tituloId = titulo.id
    await db.query('COMMIT')
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {})
    throw error
  }
  return tituloAtualizado(db, { tenantId, id: tituloId, hoje })
}

/** Desfaz a baixa: zera valor_pago e data_pagamento (o título volta a ser derivado). */
export async function desfazerRecebimento(db, { tenantId, id, hoje = hojeSaoPaulo() } = {}) {
  const ref = parseIdTitulo(id)
  if (!ref || ref.tipo !== 'materializado') throw serviceError('Título de receita não encontrado', 'RECEITA_NOT_FOUND', 404)
  const { rows } = await db.query(
    `UPDATE receita_titulos
        SET valor_pago = 0, data_pagamento = NULL,
            perdido_em = CASE WHEN valor_perdido IS NOT NULL AND valor_perdido < valor_previsto
                              THEN NULL ELSE perdido_em END,
            atualizado_em = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::uuid
      RETURNING id`,
    [tenantId, ref.id],
  )
  if (!rows[0]) throw serviceError('Título de receita não encontrado', 'RECEITA_NOT_FOUND', 404)
  return tituloAtualizado(db, { tenantId, id: ref.id, hoje })
}

// ─── Perda (cliente não vai pagar) ────────────────────────────────────────
//
// FIN-02: valor_perdido é a projeção líquida; eventos 181 são a trilha imutável.
// perdido_em continua como compatibilidade e só representa encerramento integral
// do saldo ainda não pago. valor_pago é sempre preservado.

function motivoPerdaObrigatorio(motivo) {
  const normalizado = normalizarMotivo(motivo)
  if (!normalizado) throw serviceError('motivo é obrigatório', 'INVALID_MOTIVO', 400)
  return normalizado
}

function centsTitulo(titulo) {
  return {
    previsto: exactMoneyToCents(titulo.valor_previsto),
    pago: exactMoneyToCents(titulo.valor_pago),
  }
}

function centsValorSolicitado(valor, campo) {
  let cents
  try {
    cents = exactMoneyToCents(valor)
  } catch {
    throw serviceError(`${campo} deve ser um valor monetário válido com até duas casas`, 'INVALID_PERDA_VALUE', 400)
  }
  if (cents <= 0n) throw serviceError(`${campo} deve ser maior que zero`, 'INVALID_PERDA_VALUE', 400)
  return cents
}

function atorEvento(actorType, actorId) {
  const id = String(actorId ?? '').trim()
  if (!id) throw serviceError('ator da perda é obrigatório', 'INVALID_PERDA_ACTOR', 500)
  return { tipo: String(actorType ?? 'usuario').trim() || 'usuario', id }
}

function centsPerdidosAtuais(titulo) {
  if (titulo.valor_perdido != null) return exactMoneyToCents(titulo.valor_perdido)
  if (!titulo.perdido_em) return 0n
  const { previsto, pago } = centsTitulo(titulo)
  return previsto > pago ? previsto - pago : 0n
}

function perdaLegada(titulo) {
  return Boolean(titulo.perdido_em) && titulo.valor_perdido == null
}

async function inserirEventoPerdaTitulo(db, {
  tenantId, titulo, tipo, valorCents, motivo, actorType, actorId, perdaOriginalId = null,
  chaveOperacao = null, requisicao = null,
}) {
  const ator = atorEvento(actorType, actorId)
  const { rows } = await db.query(
    `INSERT INTO financeiro_perdas_eventos (
       tenant_id, tipo, origem_tipo, origem_id, valor, motivo,
       ator_tipo, ator_id, competencia_obrigacao, perda_original_id, perda_original_tipo,
       chave_operacao, requisicao
     ) VALUES (
       $1::uuid, $2, 'receita_titulo', $3::uuid, $4::numeric, $5,
       $6, $7, $8::date, $9::uuid, CASE WHEN $2 = 'reversao' THEN 'perda' ELSE NULL END,
       $10::uuid, $11::jsonb
     )
     RETURNING id`,
    [
      tenantId, tipo, titulo.id, centsToExactMoney(valorCents), motivo,
      ator.tipo, ator.id, dateKey(titulo.competencia), perdaOriginalId,
      chaveOperacao, requisicao && JSON.stringify(requisicao),
    ],
  )
  return rows[0]
}

async function perdasReversiveisTitulo(db, { tenantId, titulo }) {
  const { rows } = await db.query(
    `SELECT p.id, p.valor::text AS valor,
            COALESCE(SUM(r.valor), 0)::text AS valor_revertido
       FROM financeiro_perdas_eventos p
       LEFT JOIN financeiro_perdas_eventos r
         ON r.tenant_id = p.tenant_id
        AND r.tipo = 'reversao'
        AND r.perda_original_id = p.id
      WHERE p.tenant_id = $1::uuid
        AND p.tipo = 'perda'
        AND p.origem_tipo = 'receita_titulo'
        AND p.origem_id = $2::uuid
        AND p.competencia_obrigacao = $3::date
      GROUP BY p.id, p.valor, p.registrado_em
     HAVING p.valor > COALESCE(SUM(r.valor), 0)
      ORDER BY p.registrado_em, p.id`,
    [tenantId, titulo.id, dateKey(titulo.competencia)],
  )
  return rows.map((row) => ({
    id: row.id,
    disponivel: exactMoneyToCents(row.valor) - exactMoneyToCents(row.valor_revertido),
  }))
}

/**
 * Dá o título como perdido. Aceita uuid ou id virtual `calc:` (materializa e marca).
 * Replay sem mudança real é idempotente: preserva data/autor/motivo e não duplica auditoria.
 */
export async function perderTitulo(db, {
  tenantId, id, motivo, valorPerda, chaveOperacao = null, actorUserId = null, actorId = actorUserId, actorType = 'usuario', hoje = hojeSaoPaulo(),
} = {}) {
  const ref = parseIdTitulo(id)
  if (!ref) throw serviceError('Título de receita não encontrado', 'RECEITA_NOT_FOUND', 404)
  const perdaSolicitada = valorPerda == null ? null : centsValorSolicitado(valorPerda, 'valor_perda')
  const requisicao = requisicaoPerda({ chaveOperacao, tipo: 'perda', origemTipo: 'receita_titulo', ref: id, motivo, valor: valorPerda })
  await db.query('BEGIN')
  let tituloId
  let jaPerdido = false
  try {
    await lockReceitas(db, tenantId)
    if (await perdaJaRegistrada(db, { tenantId, chaveOperacao, requisicao })) {
      await db.query('COMMIT')
      return { item: await tituloAtualizado(db, { tenantId, id, hoje }), ja_perdido: true }
    }
    const titulo = await buscarTituloParaBaixa(db, { tenantId, ref, actorUserId })
    const { previsto, pago } = centsTitulo(titulo)
    if (pago >= previsto) {
      throw serviceError('Título já recebido integralmente não pode ser dado como perdido', 'RECEITA_PAGA', 409)
    }
    if (perdaLegada(titulo)) {
      throw serviceError('Título possui perda legada sem evento FIN-02', 'RECEITA_PERDA_LEGADA', 409)
    }
    tituloId = titulo.id
    const perdidoAtual = centsPerdidosAtuais(titulo)
    jaPerdido = perdidoAtual > 0n
    const saldoDisponivel = previsto > pago + perdidoAtual ? previsto - pago - perdidoAtual : 0n
    if (saldoDisponivel === 0n && perdaSolicitada == null && perdidoAtual > 0n) {
      await db.query('COMMIT')
      return { item: await tituloAtualizado(db, { tenantId, id: tituloId, hoje }), ja_perdido: true }
    }
    const motivoNorm = motivoPerdaObrigatorio(motivo)
    const perdaCents = perdaSolicitada ?? saldoDisponivel
    if (perdaCents > saldoDisponivel) {
      throw serviceError('valor_perda excede o saldo disponível para perda', 'PERDA_MAIOR_QUE_SALDO', 409)
    }
    const novoPerdido = perdidoAtual + perdaCents
    const saldoOriginal = previsto > pago ? previsto - pago : 0n
    const encerraSaldo = novoPerdido >= saldoOriginal
    const atualizado = await db.query(
      `UPDATE receita_titulos
          SET valor_perdido = $3::numeric,
              perdido_em = CASE WHEN $4::boolean THEN COALESCE(perdido_em, NOW()) ELSE NULL END,
              perdido_por = $5::uuid, perdido_motivo = $6::text, atualizado_em = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
        RETURNING id`,
      [tenantId, titulo.id, centsToExactMoney(novoPerdido), encerraSaldo, actorUserId, motivoNorm],
    )
    if (!atualizado.rows[0]) throw serviceError('Título de receita não encontrado', 'RECEITA_NOT_FOUND', 404)
    await inserirEventoPerdaTitulo(db, {
      tenantId, titulo, tipo: 'perda', valorCents: perdaCents, motivo: motivoNorm, actorType, actorId,
      chaveOperacao, requisicao,
    })
    await db.query('COMMIT')
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {})
    throw error
  }
  const item = await tituloAtualizado(db, { tenantId, id: tituloId, hoje })
  return { item, ja_perdido: jaPerdido }
}

/**
 * Desfaz a perda (perdido_* → NULL). Aceita uuid ou `calc:`. Motivo da reversão é
 * obrigatório; a trilha preserva também o motivo original da perda. Replay sem
 * mudança real não grava outro evento.
 */
export async function desperderTitulo(db, {
  tenantId, id, motivo, valorReversao, chaveOperacao = null, actorUserId = null, actorId = actorUserId, actorType = 'usuario', hoje = hojeSaoPaulo(),
} = {}) {
  const ref = parseIdTitulo(id)
  if (!ref) throw serviceError('Título de receita não encontrado', 'RECEITA_NOT_FOUND', 404)
  const reversaoSolicitada = valorReversao == null ? null : centsValorSolicitado(valorReversao, 'valor_reversao')
  const requisicao = requisicaoPerda({ chaveOperacao, tipo: 'reversao', origemTipo: 'receita_titulo', ref: id, motivo, valor: valorReversao })
  await db.query('BEGIN')
  let tituloId = ref.id ?? null
  let estavaPerdido = false
  try {
    await lockReceitas(db, tenantId)
    if (await perdaJaRegistrada(db, { tenantId, chaveOperacao, requisicao })) {
      await db.query('COMMIT')
      return { item: await tituloAtualizado(db, { tenantId, id, hoje }), estava_perdido: true }
    }
    if (ref.tipo === 'virtual') {
      const { rows } = await db.query(
        `SELECT id FROM receita_titulos
          WHERE tenant_id = $1::uuid AND marca_id = $2::uuid AND competencia = $3::date AND componente = $4
          FOR UPDATE`,
        [tenantId, ref.marca_id, `${ref.mes}-01`, ref.componente],
      )
      tituloId = rows[0]?.id ?? null
      if (!tituloId) {
        await db.query('COMMIT')
        const itens = await listarTitulosReceita(db, {
          tenantId, inicio: ref.mes, fim: ref.mes, hoje, marca_id: ref.marca_id, componente: ref.componente,
        })
        if (!itens[0]) throw serviceError('Título de receita não encontrado', 'RECEITA_NOT_FOUND', 404)
        return { item: itens[0], estava_perdido: false }
      }
    }
    const atual = await db.query(
      `SELECT id, perdido_em, perdido_motivo, perdido_por, valor_previsto, valor_pago, valor_perdido,
              to_char(data_vencimento, 'YYYY-MM-DD') AS data_vencimento,
              to_char(competencia, 'YYYY-MM-DD') AS competencia
         FROM receita_titulos
        WHERE tenant_id = $1::uuid AND id = $2::uuid
        FOR UPDATE`,
      [tenantId, tituloId],
    )
    const titulo = atual.rows[0]
    if (!titulo) throw serviceError('Título de receita não encontrado', 'RECEITA_NOT_FOUND', 404)
    estavaPerdido = centsPerdidosAtuais(titulo) > 0n
    if (perdaLegada(titulo)) {
      throw serviceError('Perda legada sem evento FIN-02 exige reconciliação antes de reverter', 'RECEITA_PERDA_LEGADA', 409)
    } else if (estavaPerdido) {
      const motivoNorm = motivoPerdaObrigatorio(motivo)
      const perdidoAtual = centsPerdidosAtuais(titulo)
      const reversaoCents = reversaoSolicitada ?? perdidoAtual
      if (reversaoCents > perdidoAtual) {
        throw serviceError('valor_reversao excede a perda líquida atual', 'REVERSAO_MAIOR_QUE_PERDA', 409)
      }
      const perdas = await perdasReversiveisTitulo(db, { tenantId, titulo })
      const disponivelEventos = perdas.reduce((total, perda) => total + perda.disponivel, 0n)
      if (disponivelEventos < reversaoCents) {
        throw serviceError('Histórico FIN-02 insuficiente para vincular a reversão', 'PERDA_EVENTOS_INCONSISTENTES', 409)
      }
      const novoPerdido = perdidoAtual - reversaoCents
      const atualizado = await db.query(
        `UPDATE receita_titulos
            SET valor_perdido = $3::numeric,
                perdido_em = CASE WHEN $3::numeric > 0
                                      AND $3::numeric >= GREATEST(valor_previsto - valor_pago, 0)
                                  THEN perdido_em ELSE NULL END,
                perdido_motivo = CASE WHEN $3::numeric = 0 THEN NULL ELSE perdido_motivo END,
                perdido_por = CASE WHEN $3::numeric = 0 THEN NULL ELSE perdido_por END,
                atualizado_em = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::uuid
          RETURNING id`,
        [tenantId, tituloId, centsToExactMoney(novoPerdido)],
      )
      if (!atualizado.rows[0]) throw serviceError('Título de receita não encontrado', 'RECEITA_NOT_FOUND', 404)
      let restante = reversaoCents
      let primeiraParcela = true
      for (const perda of perdas) {
        if (restante <= 0n) break
        const parcela = perda.disponivel < restante ? perda.disponivel : restante
        await inserirEventoPerdaTitulo(db, {
          tenantId, titulo, tipo: 'reversao', valorCents: parcela, motivo: motivoNorm,
          actorType, actorId, perdaOriginalId: perda.id,
          chaveOperacao: primeiraParcela ? chaveOperacao : null,
          requisicao: primeiraParcela ? requisicao : null,
        })
        primeiraParcela = false
        restante -= parcela
      }
    } else if (reversaoSolicitada != null) {
      throw serviceError('Título não possui perda para reverter', 'REVERSAO_MAIOR_QUE_PERDA', 409)
    }
    await db.query('COMMIT')
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {})
    throw error
  }
  const item = await tituloAtualizado(db, { tenantId, id: tituloId, hoje })
  return { item, estava_perdido: estavaPerdido }
}

// ─── Receita mensal (aba Receita do Financeiro) ───────────────────────────
//
// GET /v1/financeiro/receita?mes=AAAA-MM. Duas visões do MESMO conjunto de itens:
//   competencia → o ganho do mês (títulos de marca + avulsas com competência no mês).
//                 total.previsto == DRE.receita.previsto do mês (aporte fica fora,
//                 em bloco próprio, como no DRE).
//   vencimento  → o que cai no caixa no mês (títulos/avulsas, aportes inclusive, com
//                 vencimento no mês). total.previsto == fluxo.totais.entradas.previsto.
// Título/avulsa PERDIDO: continua no previsto (competencia.total.previsto == DRE), mas
// seu saldo (previsto − pago) sai de `aberto`/`a_receber_mes` e vai para `perdido`.
// a_receber_mes = em aberto (previsto − pago) da visão vencimento (mesma regra do
// a_receber do /caixa). Corte: aplicarCorte/dentroDoCorte do agregador.

const addMes = (mes, n) => {
  const [y, m] = mes.split('-').map(Number)
  const total = y * 12 + (m - 1) + n
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`
}
const mesDeData = (d) => (d ? String(d).slice(0, 7) : null)
// `aberto` exclui o saldo de itens perdidos, que vai para `perdido`; `previsto` não muda.
const somaPrevistoPago = (itens) => {
  let previsto = 0
  let pago = 0
  let aberto = 0
  let perdido = 0
  for (const i of itens) {
    previsto += toNum(i.valor_previsto)
    pago += toNum(i.valor_pago)
    const saldo = Math.max(0, round2(i.valor_previsto) - round2(i.valor_pago))
    if (i.status === 'perdido') perdido += saldo
    else aberto += saldo
  }
  return { previsto: round2(previsto), pago: round2(pago), aberto: round2(aberto), perdido: round2(perdido) }
}

/** Título do comercial (listarTitulosReceita) → Titulo do contrato da aba Receita. */
function tituloContrato(t) {
  return { ...t, virtual: !t.materializado }
}

/**
 * Pura. Monta o contrato de GET /receita a partir de:
 *   titulos  — listarTitulosReceita das competências [mes-1, mes] (vencimento offset ≤ 1)
 *   avulsas  — listarReceitasAvulsas (item comum), qualquer competência que cubra vencimentos do mês
 *   linhasMarca — linhas de receitaMarcaMensalSql da competência `mes` (gmv, comissão bruta, pct)
 *   marcasVigentes — linhas de marcasCondicaoVigenteMesSql (marcas cliente com condição vigente)
 * Marca com condição vigente, pct > 0 e SEM título de comissão na competência aparece
 * com comissao:null e em_apuracao:true (se o vencimento que a comissão teria não for
 * anterior ao corte). Em fixo_ou_comissao o título de comissão é só o excedente sobre o
 * fixo; `comissao_bruta` = GMV × % do mês.
 */
export function montarReceitaMensal({
  mes, hoje = hojeSaoPaulo(), dataCorte = null,
  titulos = [], avulsas = [], linhasMarca = [], marcasVigentes = [],
}) {
  if (!MONTH_RE.test(String(mes ?? ''))) throw serviceError('mes deve estar no formato AAAA-MM', 'INVALID_PERIOD')
  const corte = dataCorte ? String(dataCorte).slice(0, 10) : null
  const titulosMes = titulos.map(tituloContrato)

  // ── competência ──
  const titulosCompTodos = titulosMes.filter((t) => mesDeData(t.competencia) === mes)
  const titulosComp = aplicarCorte(titulosCompTodos, corte)
  const avulsasComp = aplicarCorte(avulsas.filter((a) => mesDeData(a.competencia) === mes), corte)
  const avulsasOper = avulsasComp.filter((a) => !ehAporte(a))
  const aportes = avulsasComp.filter((a) => ehAporte(a))

  const linhaPorMarca = new Map(linhasMarca
    .filter((l) => mesDeData(dateKey(l.competencia)) === mes)
    .map((l) => [l.marca_id, l]))
  const vigentePorMarca = new Map(marcasVigentes.map((v) => [v.marca_id, v]))
  // em apuração é decidido ANTES do corte: título cortado não é "em apuração".
  const temComissao = new Set(titulosCompTodos.filter((t) => t.componente === 'comissao').map((t) => t.marca_id))

  const marcas = new Map()
  const marcaDe = (id, base) => {
    if (!marcas.has(id)) {
      const linha = linhaPorMarca.get(id)
      const vig = vigentePorMarca.get(id)
      const tipo = linha?.tipo_cobranca ?? vig?.tipo_cobranca ?? base.tipo_cobranca ?? 'fixo_mais_comissao'
      const pct = toNum(linha?.comissao_franquia_pct ?? vig?.comissao_franquia_pct ?? base.memoria?.pct ?? 0)
      marcas.set(id, {
        cliente_id: base.cliente_id ?? linha?.cliente_id ?? vig?.cliente_id ?? null,
        cliente_nome: base.cliente_nome ?? linha?.cliente_nome ?? vig?.cliente_nome ?? null,
        marca_id: id,
        marca_nome: base.marca_nome ?? linha?.marca_nome ?? vig?.marca_nome ?? null,
        marca_tipo: base.marca_tipo ?? linha?.marca_tipo ?? (vig ? 'cliente' : null), // vigentes = só tipo cliente
        tipo_cobranca: tipo,
        pct,
        janela_inicio_dia: Number(linha?.comissao_janela_inicio_dia ?? vig?.comissao_janela_inicio_dia ?? 1),
        gmv: round2(linha?.gmv ?? 0),
        comissao_bruta: round2(linha?.comissao ?? 0),
        em_apuracao: false,
        fixo: null,
        comissao: null,
      })
    }
    return marcas.get(id)
  }
  for (const t of titulosComp) marcaDe(t.marca_id, t)[t.componente] = t
  for (const v of marcasVigentes) {
    if (temComissao.has(v.marca_id) || !(toNum(v.comissao_franquia_pct) > 0)) continue
    const vencimento = calcularVencimento(mes, v.comissao_vencimento_dia, v.comissao_vencimento_mes_offset)
    const jaListada = marcas.has(v.marca_id)
    if (!jaListada && !dentroDoCorte({ valor_pago: 0, data_vencimento: vencimento, competencia: `${mes}-01` }, corte)) continue
    marcaDe(v.marca_id, v)
  }
  for (const m of marcas.values()) {
    m.em_apuracao = m.comissao == null && !temComissao.has(m.marca_id) && m.pct > 0
    const t = somaPrevistoPago([m.fixo, m.comissao].filter(Boolean))
    m.total = { previsto: t.previsto, pago: t.pago, perdido: t.perdido }
  }

  const clientes = new Map()
  for (const m of marcas.values()) {
    const key = m.cliente_id ?? `sem-cliente:${m.marca_id}`
    if (!clientes.has(key)) {
      clientes.set(key, { cliente_id: m.cliente_id, cliente_nome: m.cliente_nome ?? m.marca_nome, total: { previsto: 0, pago: 0, perdido: 0 }, marcas: [] })
    }
    const c = clientes.get(key)
    const { cliente_id: _cid, cliente_nome: _cn, ...marca } = m
    c.marcas.push(marca)
    c.total.previsto = round2(c.total.previsto + m.total.previsto)
    c.total.pago = round2(c.total.pago + m.total.pago)
    c.total.perdido = round2(c.total.perdido + m.total.perdido)
  }
  const porNome = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'pt-BR')
  const listaClientes = [...clientes.values()].sort((a, b) => porNome(a.cliente_nome, b.cliente_nome))
  for (const c of listaClientes) c.marcas.sort((a, b) => porNome(a.marca_nome, b.marca_nome))

  // ── vencimento ──
  const itensVenc = aplicarCorte([
    ...titulosMes,
    ...avulsas,
  ].filter((i) => mesDeData(vencimentoEfetivo(i)) === mes), corte)
    .map((i) => ({
      ...i,
      tipo: i.origem === 'avulsa' ? (ehAporte(i) ? 'aporte' : 'avulsa') : 'titulo',
      cliente_nome: i.cliente_nome ?? null,
      marca_nome: i.marca_nome ?? null,
      descricao: i.descricao ?? null,
    }))
    .sort((a, b) => (
      String(vencimentoEfetivo(a)).localeCompare(String(vencimentoEfetivo(b)))
      || porNome(a.cliente_nome ?? a.descricao, b.cliente_nome ?? b.descricao)
      || String(a.componente ?? '').localeCompare(String(b.componente ?? ''))
    ))
  const totalVenc = somaPrevistoPago(itensVenc)

  return {
    mes,
    hoje,
    corte: { data_corte: corte },
    competencia: {
      total: somaPrevistoPago([...titulosComp, ...avulsasOper]),
      clientes: listaClientes,
      avulsas: avulsasOper,
      aportes,
    },
    vencimento: { total: totalVenc, itens: itensVenc },
    a_receber_mes: totalVenc.aberto,
  }
}

/**
 * GET /receita: carrega as fontes (tenant explícito) e monta o contrato.
 * `dataCorte` undefined → lida da config do tenant.
 */
export async function consultarReceitaMensal(db, { tenantId, mes, hoje = hojeSaoPaulo(), dataCorte } = {}) {
  if (!tenantId) throw serviceError('tenantId é obrigatório', 'INVALID_SCOPE')
  if (!MONTH_RE.test(String(mes ?? ''))) throw serviceError('mes deve estar no formato AAAA-MM', 'INVALID_PERIOD')
  let corte = dataCorte
  if (corte === undefined) corte = (await buscarConfigFinanceiro(db, tenantId)).data_corte
  const { startDate, endDate } = resolverPeriodoCompetencia(mes, mes)
  const [titulos, avulsas, linhas, vigentes] = await Promise.all([
    // vencimento = competência + offset (0|1) → competências mes-1 e mes
    listarTitulosReceita(db, { tenantId, inicio: addMes(mes, -1), fim: mes, hoje }),
    // avulsa pode ter competência ≠ mês do vencimento: janela larga
    listarReceitasAvulsas(db, { tenantId, inicio: addMes(mes, -12), fim: addMes(mes, 12), hoje }),
    db.query(receitaMarcaMensalSql(), [startDate, endDate, tenantId]),
    db.query(marcasCondicaoVigenteMesSql(), [startDate, endDate, tenantId]),
  ])
  return montarReceitaMensal({
    mes, hoje, dataCorte: corte ?? null,
    titulos, avulsas, linhasMarca: linhas.rows, marcasVigentes: vigentes.rows,
  })
}
