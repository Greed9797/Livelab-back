import { buscarConfigFinanceiro, dataValida, hojeSaoPaulo, listarLancamentos, MAX_MESES_AGREGADOR } from './financeiro-agregador.js'
import { addMeses, mesesEntre } from './custos-plano.js'
import { exactMoneyToCents } from '../lib/money.js'
import { inicioContratoSql, marcaGeraReceitaSql } from '../lib/receita-marca-sql.js'

/** Shared exact residual for operational cash and its due-date drill-down. */
export function valoresObrigacao(item) {
  const cents = value => {
    try { return exactMoneyToCents(String(value)) } catch {
      throw Object.assign(new Error('Valor monetário ausente ou inválido na fonte financeira'), { statusCode: 422, code: 'INVALID_FINANCIAL_AMOUNT' })
    }
  }
  const original = cents(item.valor_previsto_original ?? item.valor_previsto)
  const pago = cents(item.valor_pago)
  let encerrado = item.natureza === 'receita' && item.valor_perdido != null ? cents(item.valor_perdido) : 0n
  if (item.cancelado_em || item.suspensao_comercial?.ativa || (item.perdido_em && item.valor_perdido == null)) {
    encerrado = original > pago ? original - pago : 0n
  }
  return { original, pago, encerrado, aberto: original - pago - encerrado }
}

/** Natural identity survives materialization and a manually changed due date. */
export function identidadeObrigacao(item) {
  const mes = String(item.competencia ?? '').slice(0, 7)
  if (item.marca_id && ['marca_fixo', 'marca_comissao'].includes(item.origem)) return `marca:${item.marca_id}:${mes}:${item.componente}`
  if (item.recorrente_id) return `recorrente:${item.recorrente_id}:${mes}`
  if (item.origem === 'apresentadora') return `apresentadora:${item.apresentadora_id}:${mes}:${item.componente}`
  if (item.origem === 'imposto') return `imposto:${mes}`
  return `${item.origem}:${item.id}`
}

/** Shared obligation/event reference; presenter API ids are composite, not storage UUIDs. */
export function referenciaFinanceira(item) {
  if (item.origem_tipo === 'apresentadora_pagamento' || item.origem === 'apresentadora') {
    return `apresentadora:${item.apresentadora_id}:${String(item.competencia ?? '').slice(0, 7)}:${item.componente}`
  }
  if (item.origem_tipo) return `${item.origem_tipo}:${item.origem_id}`
  if (['marca_fixo', 'marca_comissao'].includes(item.origem)) return `receita_titulo:${item.id}`
  if (item.origem === 'avulsa') return `receita_avulsa:${item.id}`
  return `${item.origem === 'imposto' ? 'imposto' : 'custo'}:${item.custo_id ?? item.id}`
}

/**
 * Historical virtual obligations have no row to find by due date. Discover their
 * earliest tenant-backed competence before asking the existing month engines.
 * A missing presenter start is not evidence of a zero debt (nor of an unlimited
 * fixed contract): retain the known records and expose the missing history.
 */
export async function buscarHistoricoObrigacoes(db, { tenantId, ate }) {
  const { rows } = await db.query(`
    WITH evidencias_apresentadora AS (
      SELECT apresentadora_id, competencia AS data, componente
        FROM apresentadora_pagamentos
       WHERE tenant_id = $1::uuid AND competencia <= $2::date
      UNION ALL
      SELECT apresentadora_id, data, 'variavel' AS componente
        FROM vendas_atribuidas
       WHERE tenant_id = $1::uuid AND data <= $2::date AND apresentadora_id IS NOT NULL
      UNION ALL
      SELECT apresentadora_id, competencia AS data, 'variavel' AS componente
        FROM apresentadora_remuneracao_adicionais
       WHERE tenant_id = $1::uuid AND competencia <= $2::date AND cancelado_em IS NULL
    ), primeiro_registro AS (
      SELECT apresentadora_id, MIN(data) AS inicio, BOOL_OR(componente = 'fixo') AS fixo_registrado
        FROM evidencias_apresentadora GROUP BY apresentadora_id
    )
    SELECT 'apresentadora' AS origem, a.id::text AS id,
           a.data_inicio::text AS inicio_contrato,
           LEAST(a.data_inicio, p.inicio)::text AS inicio_conhecido,
           (a.ativo IS TRUE AND COALESCE(a.arquivada, false) = false) AS fixo_calculavel,
           COALESCE(p.fixo_registrado, false) AS fixo_registrado
      FROM apresentadoras a
      LEFT JOIN primeiro_registro p ON p.apresentadora_id = a.id
     WHERE a.tenant_id = $1::uuid
       AND ((a.ativo IS TRUE AND COALESCE(a.arquivada, false) = false AND a.data_inicio IS NULL)
             OR a.data_inicio <= $2::date OR p.inicio IS NOT NULL)
    UNION ALL
    SELECT 'recorrente' AS origem, id::text, inicio::text, inicio::text, NULL::boolean, NULL::boolean
      FROM custos_recorrentes
     WHERE tenant_id = $1::uuid AND ativo IS TRUE AND inicio <= $2::date
    UNION ALL
    SELECT 'marca', m.id::text, vig.inicio::text, vig.inicio::text,
           (m.status NOT IN ('inativa','arquivada') OR m.data_fim IS NOT NULL), false
      FROM marcas m
      CROSS JOIN LATERAL (SELECT ${inicioContratoSql('m')} AS inicio) vig
     WHERE m.tenant_id = $1::uuid AND ${marcaGeraReceitaSql('m')}
       AND (vig.inicio IS NULL OR vig.inicio <= $2::date)
    UNION ALL
    -- Commission windows can start in the month preceding an activity date.
    SELECT 'atividade_comercial', NULL::text, NULL::text,
           (date_trunc('month', MIN(data)) - INTERVAL '1 month')::date::text, NULL::boolean, NULL::boolean
      FROM (
        SELECT data::date FROM vendas_atribuidas WHERE tenant_id = $1::uuid AND data <= $2::date
        UNION ALL
        SELECT (iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date
          FROM lives WHERE tenant_id = $1::uuid
            AND (iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date <= $2::date
      ) atividades
  `, [tenantId, ate])
  const apresentadoras = rows.filter(r => r.origem === 'apresentadora')
  const marcas = rows.filter(r => r.origem === 'marca')
  const inicios = rows.map(r => r.inicio_conhecido?.slice(0, 7)).filter(Boolean).sort()
  return {
    competencia_inicio: inicios[0] ?? null,
    apresentadoras,
    marcas,
    pendencias: [...apresentadoras, ...marcas].flatMap(r => {
      // The canonical remuneration engine cannot reconstruct inactive/archived
      // fixed pay. Recorded payables make that limitation concrete, not zero.
      const motivo = !r.fixo_calculavel && (r.fixo_registrado || r.inicio_contrato) ? 'fixo_historico_indisponivel'
        : !r.inicio_contrato ? 'inicio_historico_desconhecido' : null
      return motivo ? [{ origem: r.origem, id: r.id, componente: 'fixo', motivo, valor: null }] : []
    }),
  }
}

/**
 * One selector for forecast, due-date list and its CSV. The currently supported
 * commercial, recurring and presenter offsets are 0/1 (migrations 164/165/172).
 * Loading one preceding competence covers those offsets; persisted obligations
 * are additionally selected by due date, without any historical competence cap.
 * Long cutoff histories use bounded engine batches, never an arbitrary lookback.
 */
export async function selecionarObrigacoesPorVencimento(db, {
  tenantId, de, ate, hoje = hojeSaoPaulo(), config, incluirSemData = false, incluirVencidos = false, historico,
} = {}) {
  if (!tenantId || !dataValida(de) || !dataValida(ate) || de > ate) {
    throw Object.assign(new Error('Período de vencimento inválido'), { statusCode: 400, code: 'INVALID_PERIOD' })
  }
  const cfg = config ?? await buscarConfigFinanceiro(db, tenantId)
  const contexto = incluirVencidos ? historico ?? await buscarHistoricoObrigacoes(db, { tenantId, ate }) : null
  const inicioPeriodo = addMeses(de.slice(0, 7), -1)
  const inicio = contexto?.competencia_inicio && contexto.competencia_inicio < inicioPeriodo ? contexto.competencia_inicio : inicioPeriodo
  const competencias = mesesEntre(inicio, ate.slice(0, 7))
  // A cash cutoff is not a contract start. With no known start/record, the
  // existing current/future fixed forecast stays visible, but past debt is unknown.
  const inicioPorApresentadora = new Map((contexto?.apresentadoras ?? []).map(a => [a.id, a.inicio_conhecido?.slice(0, 7) ?? hoje.slice(0, 7)]))
  const inicioPorMarca = new Map((contexto?.marcas ?? []).map(m => [m.id, m.inicio_conhecido?.slice(0, 7) ?? hoje.slice(0, 7)]))
  const porIdentidade = new Map()
  for (let offset = 0; offset < competencias.length; offset += MAX_MESES_AGREGADOR) {
    const lote = competencias.slice(offset, offset + MAX_MESES_AGREGADOR)
    const itens = await listarLancamentos(db, {
      tenantId, inicio: lote[0], fim: lote.at(-1), hoje,
      aliquota: cfg.aliquota_imposto_pct, dataCorte: cfg.data_corte,
      // Opening/cutoff scopes cash events; it does not settle unpaid older debt.
      // Historic virtual sources use the same bounded month engines above.
      vencimentoDe: incluirVencidos ? '0001-01-01' : de, vencimentoAte: ate, incluirSemData, regraCorte: 'nenhum',
    })
    for (const item of itens) {
      if (contexto && item.origem === 'apresentadora' && item.componente === 'fixo' && item.virtual
        && String(item.competencia).slice(0, 7) < (inicioPorApresentadora.get(item.apresentadora_id) ?? hoje.slice(0, 7))) continue
      if (contexto && item.origem === 'marca_fixo' && item.virtual
        && String(item.competencia).slice(0, 7) < (inicioPorMarca.get(item.marca_id) ?? hoje.slice(0, 7))) continue
      const key = identidadeObrigacao(item)
      const atual = porIdentidade.get(key)
      if (!atual || (atual.virtual && !item.virtual)) porIdentidade.set(key, item)
    }
  }
  // Apply dates AFTER precedence. A materialized title moved out of the range
  // still suppresses its old virtual due date; it must not come back as a forecast.
  return [...porIdentidade.values()].filter((item) => {
    const vencimento = item.data_vencimento
    if (!vencimento) return incluirSemData
    return vencimento <= ate && (vencimento >= de || (incluirVencidos && vencimento < hoje))
  }).sort((a, b) => String(a.data_vencimento ?? '9999').localeCompare(String(b.data_vencimento ?? '9999'))
    || identidadeObrigacao(a).localeCompare(identidadeObrigacao(b)))
}
