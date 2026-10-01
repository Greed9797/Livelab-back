// Custos manuais: lógica pura (datas, recorrência, parcelas) + SQL de listagem.
//
// Modelo:
//   - custos.valor = valor PREVISTO; valor_pago / data_pagamento = baixa.
//   - Status é sempre DERIVADO (src/lib/lancamento-status.js), nunca gravado.
//   - Recorrentes: o mês corrente/futuro aparece como item VIRTUAL (não materializado)
//     até ser gerado (POST /custos/gerar) ou baixado; unique (recorrente_id, competencia)
//     garante idempotência.
// Datas trafegam como 'YYYY-MM-DD' / 'YYYY-MM' (sem Date) para evitar bugs de fuso.

import { statusLancamento } from '../lib/lancamento-status.js'
import { classeDoItem } from '../lib/custo-classe.js'

export const GRUPOS_CUSTO = [
  'operacional', 'estrutural', 'diversos', 'investimento', 'prolabore',
  'marketing', 'ferramentas', 'cartao', 'aporte', 'outros',
]

export const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100
const RE_MES = /^\d{4}-(0[1-9]|1[0-2])$/

export const mesValido = (m) => typeof m === 'string' && RE_MES.test(m)
export const mesDe = (data) => (data ? String(data).slice(0, 7) : null)
export const diaStr = (data) => (data ? String(data).slice(0, 10) : null)
export const primeiroDia = (mes) => `${mes}-01`

export function addMeses(mes, n) {
  const [y, m] = mes.split('-').map(Number)
  const total = y * 12 + (m - 1) + n
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`
}

export function mesesEntre(inicio, fim) {
  const out = []
  for (let m = inicio; m <= fim; m = addMeses(m, 1)) out.push(m)
  return out
}

export function diasNoMes(mes) {
  const [y, m] = mes.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export const ultimoDia = (mes) => `${mes}-${String(diasNoMes(mes)).padStart(2, '0')}`

/** Vencimento no mês; dia > último dia do mês => último dia. */
export function vencimentoNoMes(mes, dia) {
  const d = Math.min(Math.max(1, Number(dia) || 1), diasNoMes(mes))
  return `${mes}-${String(d).padStart(2, '0')}`
}

export function recorrenteVigenteNoMes(rec, mes) {
  if (rec.ativo === false) return false
  const inicio = diaStr(rec.inicio)
  const fim = diaStr(rec.fim)
  if (!inicio || inicio > ultimoDia(mes)) return false
  return !fim || fim >= primeiroDia(mes)
}

/** Vencimento do recorrente para a competência `mes` (mes_offset 0 = mesmo mês, 1 = seguinte). */
export function vencimentoRecorrente(rec, mes) {
  return vencimentoNoMes(addMeses(mes, Number(rec.mes_offset ?? 0)), rec.dia_vencimento ?? 5)
}

export function idVirtual(recorrenteId, mes) {
  return `rec:${recorrenteId}:${mes}`
}

const RE_VIRTUAL = /^rec:([0-9a-fA-F-]{36}):(\d{4}-(?:0[1-9]|1[0-2]))$/
export function parseIdVirtual(id) {
  const m = RE_VIRTUAL.exec(String(id ?? ''))
  return m ? { recorrente_id: m[1], mes: m[2] } : null
}

/**
 * Divide `total` em `n` parcelas em centavos; a diferença de arredondamento vai na última.
 * Retorna array de n valores cuja soma é exatamente r2(total).
 */
export function dividirEmParcelas(total, n) {
  const cents = Math.round(Number(total) * 100)
  const base = Math.floor(cents / n)
  const out = Array(n).fill(base)
  out[n - 1] += cents - base * n
  return out.map((c) => c / 100)
}

/**
 * Plano de parcelas: competência e vencimento avançam 1 mês por parcela
 * (dia do vencimento original preservado, limitado ao último dia de cada mês).
 * { valores:[...] } OU { valor_total } OU { valor_parcela } definem os valores.
 */
export function planejarParcelas({ n, valor_total, valor_parcela, competencia, data_vencimento }) {
  if (!Number.isInteger(n) || n < 1 || n > 120) throw new Error('parcelas deve ser inteiro entre 1 e 120')
  const valores = valor_parcela != null && valor_total == null
    ? Array(n).fill(r2(valor_parcela))
    : dividirEmParcelas(valor_total, n)
  const mesBase = mesDe(competencia ?? data_vencimento)
  const diaBase = data_vencimento ? Number(diaStr(data_vencimento).slice(8, 10)) : 1
  const mesVencBase = data_vencimento ? mesDe(data_vencimento) : mesBase
  return valores.map((valor, i) => ({
    parcela_num: i + 1,
    parcelas_total: n,
    valor,
    competencia: primeiroDia(addMeses(mesBase, i)),
    data_vencimento: vencimentoNoMes(addMeses(mesVencBase, i), diaBase),
  }))
}

/** Recorrentes que ainda não têm linha materializada no mês → linhas a inserir. */
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
      competencia: primeiroDia(mes),
      data_vencimento: vencimentoRecorrente(rec, mes),
    })
  }
  return { inserir }
}

function origemDe(row) {
  if (row.parcela_grupo_id) return 'parcela'
  if (row.recorrente_id) return 'recorrente'
  return 'manual'
}

/** Linha de `custos` → item do contrato comum de lançamentos. */
export function custoParaItem(row, hoje) {
  const item = {
    id: row.id,
    natureza: 'custo',
    origem: origemDe(row),
    descricao: row.descricao,
    competencia: diaStr(row.competencia),
    data_vencimento: diaStr(row.data_vencimento),
    valor_previsto: r2(row.valor),
    valor_pago: row.valor_pago == null ? null : r2(row.valor_pago),
    data_pagamento: diaStr(row.data_pagamento),
    grupo: row.grupo,
    tipo: row.tipo,
    observacao: row.observacao ?? null,
    recorrente_id: row.recorrente_id ?? null,
    parcela_grupo_id: row.parcela_grupo_id ?? null,
    parcela_num: row.parcela_num ?? null,
    parcelas_total: row.parcelas_total ?? null,
    // override da classe (migration 171): do lançamento e, se houver, do recorrente de origem
    classe_custo: row.classe_custo ?? null,
    classe_custo_recorrente: row.classe_custo_recorrente ?? null,
    virtual: false,
  }
  item.classe = classeDoItem(item)
  item.status = statusLancamento(item, hoje)
  return item
}

export function recorrenteParaItemVirtual(rec, mes, hoje) {
  const item = {
    id: idVirtual(rec.id, mes),
    natureza: 'custo',
    origem: 'recorrente',
    descricao: rec.nome,
    competencia: primeiroDia(mes),
    data_vencimento: vencimentoRecorrente(rec, mes),
    valor_previsto: r2(rec.valor),
    valor_pago: null,
    data_pagamento: null,
    grupo: rec.grupo,
    tipo: 'recorrente',
    observacao: rec.descricao ?? null,
    recorrente_id: rec.id,
    parcela_grupo_id: null,
    parcela_num: null,
    parcelas_total: null,
    classe_custo: null,
    classe_custo_recorrente: rec.classe_custo ?? null,
    virtual: true,
  }
  item.classe = classeDoItem(item)
  item.status = statusLancamento(item, hoje)
  return item
}

export const CUSTO_COLS = `
  id, descricao, valor, tipo, grupo, to_char(competencia,'YYYY-MM-DD') AS competencia,
  to_char(data_vencimento,'YYYY-MM-DD') AS data_vencimento, valor_pago,
  to_char(data_pagamento,'YYYY-MM-DD') AS data_pagamento,
  parcela_grupo_id, parcela_num, parcelas_total, recorrente_id, observacao, classe_custo`

export const RECORRENTE_COLS = `
  id, nome, descricao, grupo, valor, dia_vencimento, mes_offset,
  to_char(inicio,'YYYY-MM-DD') AS inicio, to_char(fim,'YYYY-MM-DD') AS fim, ativo, classe_custo`

/**
 * Custos do período (meses 'YYYY-MM' ou datas; usa os 7 primeiros chars):
 * materializados (manuais, parcelas, recorrentes já geradas) + recorrentes virtuais.
 */
export async function listarCustos(db, { tenantId, inicio, fim, hoje }) {
  const mi = mesDe(inicio)
  const mf = mesDe(fim ?? inicio)
  if (!mesValido(mi) || !mesValido(mf) || mf < mi) throw new Error('período inválido')

  const [custos, recs] = await Promise.all([
    db.query(
      `SELECT ${CUSTO_COLS}
         FROM custos
        WHERE tenant_id = $1::uuid
          AND competencia >= $2::date AND competencia <= $3::date
        ORDER BY data_vencimento NULLS LAST, competencia, criado_em`,
      [tenantId, primeiroDia(mi), ultimoDia(mf)],
    ),
    db.query(
      `SELECT ${RECORRENTE_COLS}
         FROM custos_recorrentes
        WHERE tenant_id = $1::uuid AND ativo
          AND inicio <= $3::date AND (fim IS NULL OR fim >= $2::date)`,
      [tenantId, primeiroDia(mi), ultimoDia(mf)],
    ),
  ])

  // Override de classe herdado do recorrente de origem (1 consulta extra, só para
  // recorrentes fora da lista vigente — ex.: inativados — nunca por item).
  const classeRec = new Map(recs.rows.map((r) => [r.id, r.classe_custo ?? null]))
  const faltam = [...new Set(custos.rows.map((r) => r.recorrente_id).filter((id) => id && !classeRec.has(id)))]
  if (faltam.length) {
    const extra = await db.query(
      'SELECT id, classe_custo FROM custos_recorrentes WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])',
      [tenantId, faltam],
    )
    for (const r of extra.rows) classeRec.set(r.id, r.classe_custo ?? null)
  }
  const itens = custos.rows.map((r) => custoParaItem({ ...r, classe_custo_recorrente: classeRec.get(r.recorrente_id) ?? null }, hoje))
  const materializados = new Set(
    custos.rows.filter((r) => r.recorrente_id).map((r) => `${r.recorrente_id}:${mesDe(r.competencia)}`),
  )
  for (const mes of mesesEntre(mi, mf)) {
    for (const rec of recs.rows) {
      if (!recorrenteVigenteNoMes(rec, mes) || materializados.has(`${rec.id}:${mes}`)) continue
      itens.push(recorrenteParaItemVirtual(rec, mes, hoje))
    }
  }
  itens.sort((a, b) => (a.data_vencimento ?? '9999').localeCompare(b.data_vencimento ?? '9999')
    || a.descricao.localeCompare(b.descricao))
  return itens
}

/** Materializa (idempotente) os recorrentes do mês. Retorna { criados, ja_existiam }. */
export async function gerarCustosDoMes(db, { tenantId, mes }) {
  const [recs, existentes] = await Promise.all([
    db.query(
      `SELECT ${RECORRENTE_COLS} FROM custos_recorrentes WHERE tenant_id = $1::uuid AND ativo`,
      [tenantId],
    ),
    db.query(
      `SELECT recorrente_id, to_char(competencia,'YYYY-MM-DD') AS competencia
         FROM custos
        WHERE tenant_id = $1::uuid AND recorrente_id IS NOT NULL
          AND competencia = $2::date`,
      [tenantId, primeiroDia(mes)],
    ),
  ])
  const { inserir } = planejarGeracaoCustos({ mes, recorrentes: recs.rows, existentes: existentes.rows })
  let criados = 0
  for (const c of inserir) {
    const r = await db.query(
      `INSERT INTO custos (tenant_id, descricao, valor, tipo, grupo, competencia, data_vencimento,
                           recorrente_id, observacao)
       VALUES ($1::uuid,$2,$3,'recorrente',$4,$5::date,$6::date,$7::uuid,$8)
       ON CONFLICT (recorrente_id, competencia) DO NOTHING
       RETURNING id`,
      [tenantId, c.descricao, c.valor, c.grupo, c.competencia, c.data_vencimento, c.recorrente_id, c.observacao],
    )
    criados += r.rowCount ?? r.rows.length
  }
  return { mes, criados, ja_existiam: Math.max(0, existentes.rows.length) }
}

/** Materializa um item virtual (se ainda não existir) e devolve o id real. */
export async function materializarVirtual(db, { tenantId, recorrente_id, mes }) {
  const rec = await db.query(
    `SELECT ${RECORRENTE_COLS} FROM custos_recorrentes WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [recorrente_id, tenantId],
  )
  const r = rec.rows[0]
  if (!r || !recorrenteVigenteNoMes(r, mes)) return null
  await db.query(
    `INSERT INTO custos (tenant_id, descricao, valor, tipo, grupo, competencia, data_vencimento,
                         recorrente_id, observacao)
     VALUES ($1::uuid,$2,$3,'recorrente',$4,$5::date,$6::date,$7::uuid,$8)
     ON CONFLICT (recorrente_id, competencia) DO NOTHING`,
    [tenantId, r.nome, r2(r.valor), r.grupo, primeiroDia(mes), vencimentoRecorrente(r, mes), r.id, r.descricao ?? null],
  )
  const got = await db.query(
    `SELECT id FROM custos WHERE tenant_id = $1::uuid AND recorrente_id = $2::uuid AND competencia = $3::date`,
    [tenantId, r.id, primeiroDia(mes)],
  )
  return got.rows[0]?.id ?? null
}
