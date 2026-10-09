// Custos manuais: lógica pura (datas, recorrência, parcelas) + SQL de listagem.
//
// Modelo:
//   - custos.valor = valor PREVISTO; valor_pago / data_pagamento = baixa.
//   - Status é sempre DERIVADO (src/lib/lancamento-status.js), nunca gravado.
//   - Recorrentes: o mês corrente/futuro aparece como item VIRTUAL (não materializado)
//     até ser gerado (POST /custos/gerar) ou baixado; unique (recorrente_id, competencia)
//     garante idempotência.
//   - Cancelamento (migration 173): cancelado_em/motivo/por; status derivado 'cancelado'.
//     A linha nunca é apagada; recorrente cancelado no mês continua materializado
//     (a geração idempotente não o recria).
// Datas trafegam como 'YYYY-MM-DD' / 'YYYY-MM' (sem Date) para evitar bugs de fuso.

import { normalizarMotivo, statusLancamento, timestampIso } from '../lib/lancamento-status.js'
import { classeDoItem } from '../lib/custo-classe.js'
import { randomUUID } from 'node:crypto'
import { centsToExactMoney, exactMoneyToCents } from '../lib/money.js'
import { registrarEstorno, registrarLiquidacao } from './financeiro-liquidacoes-command.js'
import { esperarLeiturasFinanceiras } from './financeiro-read-snapshot.js'

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
    cancelado_em: timestampIso(row.cancelado_em),
    cancelado_motivo: row.cancelado_motivo ?? null,
    cancelado_por: row.cancelado_por ?? null,
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
    cancelado_em: null,
    cancelado_motivo: null,
    cancelado_por: null,
  }
  item.classe = classeDoItem(item)
  item.status = statusLancamento(item, hoje)
  return item
}

export const CUSTO_COLS = `
  id, descricao, valor, tipo, grupo, to_char(competencia,'YYYY-MM-DD') AS competencia,
  to_char(data_vencimento,'YYYY-MM-DD') AS data_vencimento, valor_pago,
  to_char(data_pagamento,'YYYY-MM-DD') AS data_pagamento,
  parcela_grupo_id, parcela_num, parcelas_total, recorrente_id, observacao, classe_custo,
  cancelado_em, cancelado_motivo, cancelado_por`

export const RECORRENTE_COLS = `
  id, nome, descricao, grupo, valor, dia_vencimento, mes_offset,
  to_char(inicio,'YYYY-MM-DD') AS inicio, to_char(fim,'YYYY-MM-DD') AS fim, ativo, classe_custo`

/**
 * Custos do período (meses 'YYYY-MM' ou datas; usa os 7 primeiros chars):
 * materializados (manuais, parcelas, recorrentes já geradas) + recorrentes virtuais.
 */
export async function listarCustos(db, { tenantId, inicio, fim, hoje, vencimentoAte, incluirSemData = false }) {
  const mi = mesDe(inicio)
  const mf = mesDe(fim ?? inicio)
  if (!mesValido(mi) || !mesValido(mf) || mf < mi) throw new Error('período inválido')
  if (vencimentoAte && !/^\d{4}-\d{2}-\d{2}$/.test(vencimentoAte)) throw new Error('vencimento inválido')
  const params = [tenantId, primeiroDia(mi), ultimoDia(mf)]
  if (vencimentoAte) params.push(vencimentoAte)
  // Preserve the legacy predicate verbatim. Only the operational selector opts
  // into undated historical rows; ordinary month lists retain their scope.
  let periodo = vencimentoAte
    ? '((competencia >= $2::date AND competencia <= $3::date) OR data_vencimento <= $4::date)'
    : 'competencia >= $2::date AND competencia <= $3::date'
  if (incluirSemData) periodo = `((${periodo}) OR (data_vencimento IS NULL AND competencia <= $3::date))`

  const [custos, recs] = await esperarLeiturasFinanceiras([
    db.query(
      `SELECT ${CUSTO_COLS}
         FROM custos
        WHERE tenant_id = $1::uuid
          AND ${periodo}
        ORDER BY data_vencimento NULLS LAST, competencia, criado_em`,
      params,
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

const erroCusto = (message, statusCode, code) => Object.assign(new Error(message), { statusCode, code })

const erroCustoNaoEncontrado = () => erroCusto('Custo não encontrado', 404, 'CUSTO_NAO_ENCONTRADO')
const erroCustoDivergente = () => erroCusto(
  'Baixa legada sem fatos equivalentes; revisão necessária', 409, 'CUSTO_LIQUIDACAO_DIVERGENTE',
)

function centsCusto(value, field) {
  try {
    return exactMoneyToCents(String(value))
  } catch {
    throw erroCusto(`${field} deve ser texto decimal exato com até duas casas`, 400, 'CUSTO_VALOR_INVALIDO')
  }
}

async function custoAtual(db, tenantId, id, lock = false) {
  const { rows } = await db.query(
    `SELECT ${CUSTO_COLS
      .replace('descricao, valor,', 'descricao, valor::text AS valor,')
      .replace('valor_pago,', 'valor_pago::text AS valor_pago,')
      .replace('id,', 'id, tenant_id,')}
       FROM custos WHERE id = $1::uuid AND tenant_id = $2::uuid${lock ? ' FOR UPDATE' : ''}`,
    [id, tenantId],
  )
  return rows[0] ?? null
}

async function totalLiquidoCanonico(db, tenantId, id) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(l.valor), 0)::text AS liquidado,
            COALESCE(SUM(e.total), 0)::text AS estornado
       FROM financeiro_liquidacoes l
       LEFT JOIN LATERAL (
         SELECT SUM(valor) AS total FROM financeiro_estornos
          WHERE tenant_id = l.tenant_id AND liquidacao_id = l.id
       ) e ON true
      WHERE l.tenant_id = $1::uuid AND l.origem_tipo = 'custo' AND l.origem_id = $2::uuid`,
    [tenantId, id],
  )
  return centsCusto(rows[0].liquidado, 'liquidado') - centsCusto(rows[0].estornado, 'estornado')
}

/**
 * Baixa de custo no contrato legado: valorPago é o TOTAL acumulado, enquanto
 * FIN-03A recebe somente o delta. Todas as comparações monetárias são em
 * centavos e a compatibilidade com valor_pago é confirmada sob lock.
 */
export async function pagarCusto(db, {
  tenantId, id: rawId, valorPago, valorIncremental, dataPagamento, hoje, ator,
  chaveOperacao = randomUUID(), retornarLiquidacao = false,
} = {}) {
  if (valorPago != null && valorIncremental != null) {
    throw erroCusto('Informe valorPago acumulado ou valorIncremental, não ambos', 400, 'CUSTO_VALOR_INVALIDO')
  }
  let id = rawId
  const virtual = parseIdVirtual(rawId)
  if (virtual) id = await materializarVirtual(db, { tenantId, ...virtual })
  if (!id) throw erroCustoNaoEncontrado()

  const atual = await custoAtual(db, tenantId, id)
  if (!atual) throw erroCustoNaoEncontrado()
  if (atual.cancelado_em) throw erroCustoCancelado()

  const previsto = centsCusto(atual.valor, 'valor')
  const pagoAtual = centsCusto(atual.valor_pago ?? '0', 'valor_pago')
  const liquidoAtual = await totalLiquidoCanonico(db, tenantId, id)
  if (liquidoAtual !== pagoAtual) throw erroCustoDivergente()

  const { rows: anteriores } = await db.query(
    `SELECT valor::text AS valor, to_char(data_liquidacao, 'YYYY-MM-DD') AS data,
            idempotencia_payload
       FROM financeiro_liquidacoes
      WHERE tenant_id = $1::uuid AND idempotencia_chave = $2`,
    [tenantId, chaveOperacao],
  )
  const anterior = anteriores[0]
  const incremento = valorIncremental == null ? null : centsCusto(valorIncremental, 'valor_operacao')
  const alvo = incremento === null ? (valorPago == null ? previsto : centsCusto(valorPago, 'valor_pago')) : null
  if (alvo !== null && alvo > previsto) throw erroCusto('valor_pago excede o valor previsto', 409, 'CUSTO_VALOR_EXCEDENTE')
  const delta = anterior ? centsCusto(anterior.valor, 'valor') : incremento ?? (alvo - pagoAtual)
  if (!anterior && delta <= 0n) throw erroCusto('Custo já pago neste valor', 409, 'CUSTO_SEM_SALDO')
  const data = dataPagamento ?? anterior?.data ?? hoje
  const motivo = JSON.stringify(incremento === null
    ? { alvo: centsToExactMoney(alvo), operacao: 'baixa_total_legada' }
    : { valor_operacao: centsToExactMoney(incremento), operacao: 'incremental' })

  const liquidacao = await registrarLiquidacao(db, {
    tenantId, origemTipo: 'custo', origemId: id, valor: centsToExactMoney(delta), data,
    ator, idempotenciaChave: chaveOperacao, comandoOrigem: 'custos.pagar', motivo,
    validarOrigemParaUpdate: async (tx) => {
      const custo = await custoAtual(tx, tenantId, id, true)
      if (!custo) return null
      if (custo.cancelado_em) throw erroCustoCancelado()
      const valor = centsCusto(custo.valor, 'valor')
      const pago = centsCusto(custo.valor_pago ?? '0', 'valor_pago')
      const liquido = await totalLiquidoCanonico(tx, tenantId, id)
      if (liquido !== pago) throw erroCustoDivergente()
      if (alvo !== null && alvo !== pago + delta) {
        throw erroCusto('valor_pago mudou durante a baixa; tente novamente', 409, 'CUSTO_PAGAMENTO_CONCORRENTE')
      }
      const saldo = valor - pago
      if (saldo <= 0n) throw erroCusto('Custo sem saldo disponível', 409, 'CUSTO_SEM_SALDO')
      return { tenantId: custo.tenant_id, natureza: 'custo', saldoElegivel: centsToExactMoney(saldo) }
    },
    aplicarProjecao: async (tx, evento) => {
      await tx.query(
        `UPDATE custos SET valor_pago = COALESCE(valor_pago, 0) + $3::numeric,
                data_pagamento = $4::date, atualizado_em = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [tenantId, id, evento.valor, data],
      )
    },
  })
  const item = custoParaItem(await custoAtual(db, tenantId, id), hoje)
  return retornarLiquidacao ? { item, liquidacao } : item
}

/** Estorno simples: somente uma liquidação ativa equivalente ao total legado. */
export async function desfazerBaixaCusto(db, {
  tenantId, id: rawId, hoje, ator, chaveOperacao = randomUUID(),
} = {}) {
  let id = rawId
  const virtual = parseIdVirtual(rawId)
  if (virtual) id = await materializarVirtual(db, { tenantId, ...virtual })
  if (!id) throw erroCustoNaoEncontrado()
  const atual = await custoAtual(db, tenantId, id)
  if (!atual) throw erroCustoNaoEncontrado()

  const { rows: estornosAnteriores } = await db.query(
    `SELECT liquidacao_id, valor::text AS valor, to_char(data_estorno, 'YYYY-MM-DD') AS data
       FROM financeiro_estornos WHERE tenant_id = $1::uuid AND idempotencia_chave = $2`,
    [tenantId, chaveOperacao],
  )
  const anterior = estornosAnteriores[0]
  if (!anterior) {
    const { rows: fatos } = await db.query(
      `SELECT l.id, (l.valor - COALESCE(SUM(e.valor), 0))::text AS saldo
         FROM financeiro_liquidacoes l
         LEFT JOIN financeiro_estornos e ON e.tenant_id = l.tenant_id AND e.liquidacao_id = l.id
        WHERE l.tenant_id = $1::uuid AND l.origem_tipo = 'custo' AND l.origem_id = $2::uuid
        GROUP BY l.id, l.valor HAVING l.valor > COALESCE(SUM(e.valor), 0)
        ORDER BY l.id`,
      [tenantId, id],
    )
    const pago = centsCusto(atual.valor_pago ?? '0', 'valor_pago')
    const total = fatos.reduce((sum, fato) => sum + centsCusto(fato.saldo, 'saldo'), 0n)
    if (total !== pago) throw erroCustoDivergente()
    if (fatos.length === 0) return custoParaItem(atual, hoje)
    if (fatos.length > 1) {
      throw erroCusto('Múltiplas liquidações exigem estorno granular', 409, 'CUSTO_ESTORNO_GRANULAR_NECESSARIO')
    }
    estornosAnteriores[0] = { liquidacao_id: fatos[0].id, valor: fatos[0].saldo, data: hoje }
  }
  const fato = estornosAnteriores[0]
  await registrarEstorno(db, {
    tenantId, liquidacaoId: fato.liquidacao_id, valor: fato.valor, data: fato.data,
    ator, idempotenciaChave: chaveOperacao, comandoOrigem: 'custos.desfazer', motivo: 'Desfazer pagamento de custo',
    aplicarProjecao: async (tx, evento) => {
      if (evento.natureza !== 'custo' || evento.origemTipo !== 'custo' || evento.origemId !== id) {
        throw erroCusto('Liquidação não pertence ao custo', 409, 'CUSTO_LIQUIDACAO_DIVERGENTE')
      }
      const { rows } = await tx.query(
        `UPDATE custos SET valor_pago = NULL, data_pagamento = NULL, atualizado_em = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::uuid AND valor_pago = $3::numeric
          RETURNING id`,
        [tenantId, id, evento.valor],
      )
      if (!rows[0]) throw erroCusto('Pagamento mudou durante o estorno; revisão necessária', 409, 'CUSTO_ESTORNO_CONCORRENTE')
    },
  })
  return custoParaItem(await custoAtual(db, tenantId, id), hoje)
}

/** 409 ao pagar custo cancelado. */
export const erroCustoCancelado = () => erroCusto(
  'Custo cancelado. Desfaça a perda/cancelamento antes de pagar.', 409, 'CUSTO_CANCELADO',
)

/**
 * Cancela o custo (não será pago: cancelado/perdoado/duplicado). `id` é o uuid REAL
 * (item virtual `rec:` já materializado pela rota — só aquele mês). A linha é preservada.
 * Custo 100% pago → 409. Idempotente: já cancelado mantém cancelado_em/cancelado_por;
 * `motivo` informado substitui o anterior. Retorna { row, ja_cancelado } ou null (404).
 */
export async function cancelarCusto(db, { tenantId, id, motivo, actorUserId = null }) {
  const motivoNorm = normalizarMotivo(motivo)
  const atual = await db.query(
    `SELECT id, valor, valor_pago, cancelado_em FROM custos WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [id, tenantId],
  )
  const a = atual.rows[0]
  if (!a) return null
  if (Number(a.valor_pago) > 0 && Number(a.valor_pago) >= Number(a.valor)) {
    throw erroCusto('Custo já pago integralmente não pode ser cancelado', 409, 'CUSTO_PAGO')
  }
  const r = await db.query(
    `UPDATE custos
        SET cancelado_em = COALESCE(cancelado_em, NOW()),
            cancelado_por = CASE WHEN cancelado_em IS NULL THEN $3::uuid ELSE cancelado_por END,
            cancelado_motivo = CASE WHEN cancelado_em IS NULL THEN $4::text ELSE COALESCE($4::text, cancelado_motivo) END,
            atualizado_em = NOW()
      WHERE id = $1::uuid AND tenant_id = $2::uuid
      RETURNING ${CUSTO_COLS}`,
    [id, tenantId, actorUserId ?? null, motivoNorm],
  )
  return r.rows[0] ? { row: r.rows[0], ja_cancelado: Boolean(a.cancelado_em) } : null
}

/** Reativa (desfaz o cancelamento: cancelado_* → NULL). Idempotente. { row, estava_cancelado } ou null. */
export async function reativarCusto(db, { tenantId, id }) {
  const atual = await db.query(
    `SELECT ${CUSTO_COLS} FROM custos WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [id, tenantId],
  )
  const a = atual.rows[0]
  if (!a) return null
  if (!a.cancelado_em) return { row: a, estava_cancelado: false }
  const r = await db.query(
    `UPDATE custos SET cancelado_em = NULL, cancelado_motivo = NULL, cancelado_por = NULL, atualizado_em = NOW()
      WHERE id = $1::uuid AND tenant_id = $2::uuid
      RETURNING ${CUSTO_COLS}`,
    [id, tenantId],
  )
  return r.rows[0] ? { row: r.rows[0], estava_cancelado: true } : null
}
