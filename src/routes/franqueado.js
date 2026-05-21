const MASTER_PIPELINE_STAGES = [
  'Lead captado',
  'Qualificação',
  'Reunião agendada',
  'Negociação',
  'Contrato enviado',
  'Contrato pendente',
  'Fechado ganho',
  'Fechado perdido',
]

// Map crm_etapa enum (DB) → label PT-BR exibida no funil.
// Ordem é a ordem canônica do pipeline.
const CRM_STAGE_DEFS = [
  { id: 'lead_novo', label: 'Lead captado' },
  { id: 'contato_iniciado', label: 'Qualificação' },
  { id: 'reuniao_agendada', label: 'Reunião agendada' },
  { id: 'proposta_enviada', label: 'Negociação' },
  { id: 'em_negociacao', label: 'Contrato enviado' },
  { id: 'aguardando_assinatura', label: 'Contrato pendente' },
  { id: 'ganho', label: 'Fechado ganho' },
  { id: 'perdido', label: 'Fechado perdido' },
]

const MONTH_LABELS = [
  'Jan',
  'Fev',
  'Mar',
  'Abr',
  'Mai',
  'Jun',
  'Jul',
  'Ago',
  'Set',
  'Out',
  'Nov',
  'Dez',
]

function toMoney(value) {
  return Number(Number(value ?? 0).toFixed(2))
}

function toInt(value) {
  return Number.parseInt(String(value ?? 0), 10) || 0
}

function shiftPeriod(period, delta) {
  const [year, month] = period.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1 + delta, 1))
  const shiftedYear = date.getUTCFullYear()
  const shiftedMonth = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${shiftedYear}-${shiftedMonth}`
}

function periodStart(period) {
  return `${period}-01`
}

function formatPeriodLabel(period) {
  const [year, month] = period.split('-').map(Number)
  return `${MONTH_LABELS[month - 1]}/${String(year).slice(-2)}`
}

function listPeriods(period, count) {
  return Array.from({ length: count }, (_, index) =>
    shiftPeriod(period, index - (count - 1))
  )
}

function parsePeriod(rawPeriod) {
  const period =
    typeof rawPeriod === 'string' && /^\d{4}-\d{2}$/.test(rawPeriod)
      ? rawPeriod
      : new Date().toISOString().slice(0, 7)

  const previousPeriod = shiftPeriod(period, -1)
  const nextPeriod = shiftPeriod(period, 1)
  const historyPeriods = listPeriods(period, 6)

  return {
    period,
    previousPeriod,
    currentStart: periodStart(period),
    currentEnd: periodStart(nextPeriod),
    previousStart: periodStart(previousPeriod),
    previousEnd: periodStart(period),
    historyPeriods,
    historyStart: periodStart(historyPeriods[0]),
    historyEnd: periodStart(nextPeriod),
  }
}

function calculateGrowth(currentValue, previousValue) {
  const current = Number(currentValue ?? 0)
  const previous = Number(previousValue ?? 0)

  if (previous > 0) {
    return Number((((current - previous) / previous) * 100).toFixed(1))
  }

  if (current > 0) {
    return 100
  }

  return 0
}

function calculateRate(numerator, denominator) {
  const top = Number(numerator ?? 0)
  const base = Number(denominator ?? 0)

  if (base <= 0) {
    return 0
  }

  return Number(((top / base) * 100).toFixed(1))
}

function normalizeStatus(rawStatus) {
  const allowed = new Set(['todos', 'ativo', 'inadimplente', 'pendente', 'inativo'])
  return allowed.has(rawStatus) ? rawStatus : 'todos'
}

function formatCurrency(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(Number(value ?? 0))
}

function pluralize(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`
}

function labelContractStatus(status) {
  switch (status) {
    case 'rascunho':
      return 'rascunho'
    case 'enviado':
      return 'enviado'
    case 'em_analise':
      return 'análise'
    case 'ativo':
      return 'ativo'
    case 'cancelado':
      return 'cancelado'
    default:
      return status ?? 'desconhecido'
  }
}

function deriveUnitStatus(row) {
  if (!row.is_active_tenant) return 'inativo'
  if (row.franchisor_overdue > 0) return 'inadimplente'
  if (row.gross_revenue <= 0) return 'pendente'
  return 'ativo'
}

function buildExecutiveSummary(cards, alertCount) {
  return `Tenho ${pluralize(cards.unidades_ativas, 'unidade', 'unidades')}, ${pluralize(cards.clientes_ativos, 'cliente', 'clientes')}, ${formatCurrency(cards.faturamento_bruto_rede)} faturados na rede, minha receita líquida é ${formatCurrency(cards.receita_liquida_franqueadora)}, há ${pluralize(cards.contratos_pendentes, 'contrato pendente', 'contratos pendentes')} e ${pluralize(alertCount, 'alerta crítico', 'alertas críticos')}.`
}

async function fetchUnitSummaries(
  app,
  masterTenantId,
  periodInfo,
  status = 'todos',
  allowedTenantIds = null
) {
  const result = await app.db.query(
    `
      WITH clientes_ativos AS (
        SELECT
          tenant_id,
          COUNT(*) FILTER (WHERE status = 'ativo') AS active_clients
        FROM clientes
        WHERE criado_em < $4::date
        GROUP BY tenant_id
      ),
      contratos_resumo AS (
        SELECT
          tenant_id,
          COUNT(*) FILTER (WHERE status = 'ativo' AND criado_em < $4::date) AS active_contracts,
          COUNT(*) FILTER (WHERE status IN ('rascunho', 'enviado', 'em_analise') AND criado_em < $4::date) AS pending_contracts,
          COALESCE(AVG(comissao_pct) FILTER (WHERE status = 'ativo' AND criado_em < $4::date), 0) AS avg_contract_pct,
          COALESCE(SUM(valor_fixo) FILTER (
            WHERE COALESCE(ativado_em, assinado_em, criado_em) < $4::date
              AND (cancelado_em IS NULL OR cancelado_em >= $2::date)
              AND status != 'rascunho'
          ), 0) AS fixed_current,
          COALESCE(SUM(valor_fixo) FILTER (
            WHERE COALESCE(ativado_em, assinado_em, criado_em) < $5::date
              AND (cancelado_em IS NULL OR cancelado_em >= $3::date)
              AND status != 'rascunho'
          ), 0) AS fixed_previous
        FROM contratos
        GROUP BY tenant_id
      ),
      lives_current AS (
        SELECT
          l.tenant_id,
          COALESCE(SUM(l.fat_gerado), 0) AS gmv_current,
          COALESCE(SUM(l.fat_gerado * COALESCE(ct.comissao_pct, 0) / 100.0), 0) AS commission_current
        FROM lives l
        LEFT JOIN LATERAL (
          SELECT c.comissao_pct
          FROM contratos c
          WHERE c.tenant_id = l.tenant_id
            AND c.cliente_id = l.cliente_id
          ORDER BY CASE WHEN c.status = 'ativo' THEN 0 ELSE 1 END, c.criado_em DESC
          LIMIT 1
        ) ct ON TRUE
        WHERE COALESCE(l.encerrado_em, l.iniciado_em) >= $2::date
          AND COALESCE(l.encerrado_em, l.iniciado_em) < $4::date
        GROUP BY l.tenant_id
      ),
      lives_previous AS (
        SELECT
          l.tenant_id,
          COALESCE(SUM(l.fat_gerado * COALESCE(ct.comissao_pct, 0) / 100.0), 0) AS commission_previous
        FROM lives l
        LEFT JOIN LATERAL (
          SELECT c.comissao_pct
          FROM contratos c
          WHERE c.tenant_id = l.tenant_id
            AND c.cliente_id = l.cliente_id
          ORDER BY CASE WHEN c.status = 'ativo' THEN 0 ELSE 1 END, c.criado_em DESC
          LIMIT 1
        ) ct ON TRUE
        WHERE COALESCE(l.encerrado_em, l.iniciado_em) >= $3::date
          AND COALESCE(l.encerrado_em, l.iniciado_em) < $5::date
        GROUP BY l.tenant_id
      ),
      boletos_current AS (
        SELECT
          tenant_id,
          COALESCE(SUM(valor), 0) AS franchisor_current,
          COALESCE(SUM(valor) FILTER (WHERE status = 'pago'), 0) AS franchisor_received,
          COALESCE(SUM(valor) FILTER (
            WHERE status = 'vencido'
               OR (status = 'pendente' AND vencimento < CURRENT_DATE)
          ), 0) AS franchisor_overdue,
          COALESCE(SUM(valor) FILTER (
            WHERE status = 'pendente' AND vencimento >= CURRENT_DATE
          ), 0) AS franchisor_pending
        FROM boletos
        WHERE competencia >= $2::date
          AND competencia < $4::date
        GROUP BY tenant_id
      )
      SELECT
        t.id,
        t.nome,
        t.ativo,
        COALESCE(ca.active_clients, 0) AS active_clients,
        COALESCE(cr.active_contracts, 0) AS active_contracts,
        COALESCE(cr.pending_contracts, 0) AS pending_contracts,
        COALESCE(cr.avg_contract_pct, 0) AS avg_contract_pct,
        COALESCE(cr.fixed_current, 0) AS fixed_current,
        COALESCE(cr.fixed_previous, 0) AS fixed_previous,
        COALESCE(lc.gmv_current, 0) AS gmv_current,
        COALESCE(lc.commission_current, 0) AS commission_current,
        COALESCE(lp.commission_previous, 0) AS commission_previous,
        COALESCE(bc.franchisor_current, 0) AS franchisor_current,
        COALESCE(bc.franchisor_received, 0) AS franchisor_received,
        COALESCE(bc.franchisor_overdue, 0) AS franchisor_overdue,
        COALESCE(bc.franchisor_pending, 0) AS franchisor_pending
      FROM tenants t
      LEFT JOIN clientes_ativos ca ON ca.tenant_id = t.id
      LEFT JOIN contratos_resumo cr ON cr.tenant_id = t.id
      LEFT JOIN lives_current lc ON lc.tenant_id = t.id
      LEFT JOIN lives_previous lp ON lp.tenant_id = t.id
      LEFT JOIN boletos_current bc ON bc.tenant_id = t.id
      WHERE t.id <> $1
        AND t.criado_em < $4::date
        AND ($6::uuid[] IS NULL OR t.id = ANY($6::uuid[]))
      ORDER BY (COALESCE(cr.fixed_current, 0) + COALESCE(lc.commission_current, 0)) DESC, t.nome ASC
    `,
    [
      masterTenantId,
      periodInfo.currentStart,
      periodInfo.previousStart,
      periodInfo.currentEnd,
      periodInfo.previousEnd,
      allowedTenantIds,
    ]
  )

  const mapped = result.rows.map((row) => {
    const fixedCurrent = toMoney(row.fixed_current)
    const fixedPrevious = toMoney(row.fixed_previous)
    const commissionCurrent = toMoney(row.commission_current)
    const commissionPrevious = toMoney(row.commission_previous)
    const grossRevenue = toMoney(fixedCurrent + commissionCurrent)
    const previousGrossRevenue = toMoney(fixedPrevious + commissionPrevious)
    const franchisorRevenue = toMoney(row.franchisor_current)
    const unitNetRevenue = toMoney(Math.max(grossRevenue - franchisorRevenue, 0))
    const growthPct = calculateGrowth(grossRevenue, previousGrossRevenue)
    const takeRate = calculateRate(franchisorRevenue, grossRevenue)
    const mappedRow = {
      id: row.id,
      name: row.nome,
      is_active_tenant: Boolean(row.ativo),
      active_clients: toInt(row.active_clients),
      active_contracts: toInt(row.active_contracts),
      pending_contracts: toInt(row.pending_contracts),
      contract_pct: Number(Number(row.avg_contract_pct ?? 0).toFixed(1)),
      fixed_revenue: fixedCurrent,
      commission_revenue: commissionCurrent,
      gmv_current: toMoney(row.gmv_current),
      gross_revenue: grossRevenue,
      previous_gross_revenue: previousGrossRevenue,
      unit_net_revenue: unitNetRevenue,
      franchisor_revenue: franchisorRevenue,
      franchisor_received: toMoney(row.franchisor_received),
      franchisor_overdue: toMoney(row.franchisor_overdue),
      franchisor_pending: toMoney(row.franchisor_pending),
      growth_pct: growthPct,
      take_rate: takeRate,
    }

    return {
      ...mappedRow,
      status: deriveUnitStatus(mappedRow),
    }
  })

  if (status === 'todos') {
    return mapped
  }

  return mapped.filter((unit) => unit.status === status)
}

async function fetchHistoryRows(app, masterTenantId, periodInfo, allowedTenantIds = null) {
  const result = await app.db.query(
    `
      WITH months AS (
        SELECT generate_series(
          date_trunc('month', $2::date),
          date_trunc('month', ($3::date - interval '1 month')),
          interval '1 month'
        ) AS month_start
      ),
      tenant_months AS (
        SELECT
          t.id AS tenant_id,
          t.nome AS tenant_name,
          m.month_start
        FROM tenants t
        CROSS JOIN months m
        WHERE t.id <> $1
          AND ($4::uuid[] IS NULL OR t.id = ANY($4::uuid[]))
      ),
      fixed_revenue AS (
        SELECT
          tm.tenant_id,
          tm.month_start,
          COALESCE(SUM(c.valor_fixo) FILTER (
            WHERE COALESCE(c.ativado_em, c.assinado_em, c.criado_em) < (tm.month_start + interval '1 month')
              AND (c.cancelado_em IS NULL OR c.cancelado_em >= tm.month_start)
              AND c.status != 'rascunho'
          ), 0) AS fixed_revenue
        FROM tenant_months tm
        LEFT JOIN contratos c ON c.tenant_id = tm.tenant_id
        GROUP BY tm.tenant_id, tm.month_start
      ),
      commission_revenue AS (
        SELECT
          tm.tenant_id,
          tm.month_start,
          COALESCE(SUM(l.fat_gerado * COALESCE(ct.comissao_pct, 0) / 100.0), 0) AS commission_revenue
        FROM tenant_months tm
        LEFT JOIN lives l
          ON l.tenant_id = tm.tenant_id
         AND COALESCE(l.encerrado_em, l.iniciado_em) >= tm.month_start
         AND COALESCE(l.encerrado_em, l.iniciado_em) < (tm.month_start + interval '1 month')
        LEFT JOIN LATERAL (
          SELECT c.comissao_pct
          FROM contratos c
          WHERE c.tenant_id = tm.tenant_id
            AND c.cliente_id = l.cliente_id
          ORDER BY CASE WHEN c.status = 'ativo' THEN 0 ELSE 1 END, c.criado_em DESC
          LIMIT 1
        ) ct ON TRUE
        GROUP BY tm.tenant_id, tm.month_start
      ),
      franchisor_revenue AS (
        SELECT
          tm.tenant_id,
          tm.month_start,
          COALESCE(SUM(b.valor), 0) AS franchisor_revenue
        FROM tenant_months tm
        LEFT JOIN boletos b
          ON b.tenant_id = tm.tenant_id
         AND b.competencia >= tm.month_start
         AND b.competencia < (tm.month_start + interval '1 month')
        GROUP BY tm.tenant_id, tm.month_start
      )
      SELECT
        tm.tenant_id,
        tm.tenant_name,
        to_char(tm.month_start, 'YYYY-MM') AS period,
        COALESCE(fr.fixed_revenue, 0) AS fixed_revenue,
        COALESCE(cr.commission_revenue, 0) AS commission_revenue,
        COALESCE(br.franchisor_revenue, 0) AS franchisor_revenue
      FROM tenant_months tm
      LEFT JOIN fixed_revenue fr
        ON fr.tenant_id = tm.tenant_id
       AND fr.month_start = tm.month_start
      LEFT JOIN commission_revenue cr
        ON cr.tenant_id = tm.tenant_id
       AND cr.month_start = tm.month_start
      LEFT JOIN franchisor_revenue br
        ON br.tenant_id = tm.tenant_id
       AND br.month_start = tm.month_start
      ORDER BY tm.month_start ASC, tm.tenant_name ASC
    `,
    [masterTenantId, periodInfo.historyStart, periodInfo.historyEnd, allowedTenantIds]
  )

  return result.rows.map((row) => ({
    unit_id: row.tenant_id,
    unit_name: row.tenant_name,
    period: row.period,
    label: formatPeriodLabel(row.period),
    gross_revenue: toMoney(toMoney(row.fixed_revenue) + toMoney(row.commission_revenue)),
    franchisor_revenue: toMoney(row.franchisor_revenue),
  }))
}

async function fetchUnitClients(app, masterTenantId, periodInfo, allowedTenantIds = null) {
  const mapRows = (rows) =>
    rows.map((row) => {
      const monthlyFee = toMoney(row.monthly_fee)
      const liveRevenue = toMoney(row.live_revenue)
      const grossRevenue = toMoney(monthlyFee + liveRevenue)
      const contractStatus = row.contract_status ?? 'sem_contrato'
      const clientStatus = row.client_status ?? 'negociacao'
      const notes = [
        `Cliente ${clientStatus}`,
        row.contract_id ? `Contrato ${contractStatus}` : 'Sem contrato ativo',
      ].join(' · ')

      return {
        unit_id: row.tenant_id,
        id: row.client_id,
        name: row.client_name,
        status: clientStatus,
        gross_revenue: grossRevenue,
        contract_pct: Number(Number(row.contract_pct ?? 0).toFixed(1)),
        franchisor_revenue: toMoney(row.franchisor_revenue),
        monthly_fee: monthlyFee,
        live_gmv: toMoney(row.live_gmv),
        notes,
      }
    })

  try {
    const result = await app.db.query(
      `
        WITH client_lives AS (
          SELECT
            l.tenant_id,
            l.cliente_id,
            COALESCE(SUM(l.fat_gerado), 0) AS live_gmv,
            COALESCE(SUM(l.fat_gerado * COALESCE(ct.comissao_pct, 0) / 100.0), 0) AS live_revenue
          FROM lives l
          LEFT JOIN LATERAL (
            SELECT c.comissao_pct
            FROM contratos c
            WHERE c.tenant_id = l.tenant_id
              AND c.cliente_id = l.cliente_id
            ORDER BY CASE WHEN c.status = 'ativo' THEN 0 ELSE 1 END, c.criado_em DESC
            LIMIT 1
          ) ct ON TRUE
          WHERE COALESCE(l.encerrado_em, l.iniciado_em) >= $2::date
            AND COALESCE(l.encerrado_em, l.iniciado_em) < $3::date
          GROUP BY l.tenant_id, l.cliente_id
        ),
        client_boletos AS (
          SELECT
            tenant_id,
            cliente_id,
            COALESCE(SUM(valor), 0) AS franchisor_revenue
          FROM boletos
          WHERE competencia >= $2::date
            AND competencia < $3::date
          GROUP BY tenant_id, cliente_id
        )
        SELECT
          cl.tenant_id,
          cl.id AS client_id,
          cl.nome AS client_name,
          cl.status AS client_status,
          ct.id AS contract_id,
          ct.status AS contract_status,
          COALESCE(ct.comissao_pct, 0) AS contract_pct,
          COALESCE(ct.valor_fixo, 0) AS monthly_fee,
          COALESCE(lv.live_gmv, 0) AS live_gmv,
          COALESCE(lv.live_revenue, 0) AS live_revenue,
          COALESCE(cb.franchisor_revenue, 0) AS franchisor_revenue
        FROM clientes cl
        LEFT JOIN LATERAL (
          SELECT id, status, comissao_pct, valor_fixo
          FROM contratos c
          WHERE c.tenant_id = cl.tenant_id
            AND c.cliente_id = cl.id
          ORDER BY
            CASE
              WHEN c.status = 'ativo' THEN 0
              WHEN c.status = 'em_analise' THEN 1
              WHEN c.status = 'enviado' THEN 2
              ELSE 3
            END,
            c.criado_em DESC
          LIMIT 1
        ) ct ON TRUE
        LEFT JOIN client_lives lv
          ON lv.tenant_id = cl.tenant_id
         AND lv.cliente_id = cl.id
        LEFT JOIN client_boletos cb
          ON cb.tenant_id = cl.tenant_id
         AND cb.cliente_id = cl.id
        WHERE cl.tenant_id <> $1
          AND ($4::uuid[] IS NULL OR cl.tenant_id = ANY($4::uuid[]))
        ORDER BY cl.tenant_id, (COALESCE(ct.valor_fixo, 0) + COALESCE(lv.live_revenue, 0)) DESC, cl.nome ASC
      `,
      [masterTenantId, periodInfo.currentStart, periodInfo.currentEnd, allowedTenantIds]
    )

    return mapRows(result.rows)
  } catch (err) {
    app.log.warn({ err }, 'master/unidades: fallback sem boletos por cliente')

    const fallback = await app.db.query(
      `
        WITH client_lives AS (
          SELECT
            l.tenant_id,
            l.cliente_id,
            COALESCE(SUM(l.fat_gerado), 0) AS live_gmv,
            COALESCE(SUM(l.fat_gerado * COALESCE(ct.comissao_pct, 0) / 100.0), 0) AS live_revenue
          FROM lives l
          LEFT JOIN LATERAL (
            SELECT c.comissao_pct
            FROM contratos c
            WHERE c.tenant_id = l.tenant_id
              AND c.cliente_id = l.cliente_id
            ORDER BY CASE WHEN c.status = 'ativo' THEN 0 ELSE 1 END, c.criado_em DESC
            LIMIT 1
          ) ct ON TRUE
          WHERE COALESCE(l.encerrado_em, l.iniciado_em) >= $2::date
            AND COALESCE(l.encerrado_em, l.iniciado_em) < $3::date
          GROUP BY l.tenant_id, l.cliente_id
        )
        SELECT
          cl.tenant_id,
          cl.id AS client_id,
          cl.nome AS client_name,
          cl.status AS client_status,
          ct.id AS contract_id,
          ct.status AS contract_status,
          COALESCE(ct.comissao_pct, 0) AS contract_pct,
          COALESCE(ct.valor_fixo, 0) AS monthly_fee,
          COALESCE(lv.live_gmv, 0) AS live_gmv,
          COALESCE(lv.live_revenue, 0) AS live_revenue,
          0 AS franchisor_revenue
        FROM clientes cl
        LEFT JOIN LATERAL (
          SELECT id, status, comissao_pct, valor_fixo
          FROM contratos c
          WHERE c.tenant_id = cl.tenant_id
            AND c.cliente_id = cl.id
          ORDER BY
            CASE
              WHEN c.status = 'ativo' THEN 0
              WHEN c.status = 'em_analise' THEN 1
              WHEN c.status = 'enviado' THEN 2
              ELSE 3
            END,
            c.criado_em DESC
          LIMIT 1
        ) ct ON TRUE
        LEFT JOIN client_lives lv
          ON lv.tenant_id = cl.tenant_id
         AND lv.cliente_id = cl.id
        WHERE cl.tenant_id <> $1
          AND ($4::uuid[] IS NULL OR cl.tenant_id = ANY($4::uuid[]))
        ORDER BY cl.tenant_id, (COALESCE(ct.valor_fixo, 0) + COALESCE(lv.live_revenue, 0)) DESC, cl.nome ASC
      `,
      [masterTenantId, periodInfo.currentStart, periodInfo.currentEnd, allowedTenantIds]
    )

    return mapRows(fallback.rows)
  }
}

async function fetchStalledContracts(app, masterTenantId, periodInfo, allowedTenantIds = null) {
  const result = await app.db.query(
    `
      SELECT
        t.id AS unit_id,
        t.nome AS unit_name,
        c.id AS contract_id,
        c.status,
        cl.nome AS client_name,
        COALESCE(c.assinado_em, c.criado_em) AS reference_date
      FROM contratos c
      JOIN tenants t ON t.id = c.tenant_id
      LEFT JOIN clientes cl ON cl.id = c.cliente_id
      WHERE c.tenant_id <> $1
        AND ($3::uuid[] IS NULL OR c.tenant_id = ANY($3::uuid[]))
        AND c.status IN ('rascunho', 'enviado', 'em_analise')
        AND c.criado_em < $2::date
        AND COALESCE(c.assinado_em, c.criado_em) < $2::date - interval '7 days'
      ORDER BY reference_date ASC
      LIMIT 5
    `,
    [masterTenantId, periodInfo.currentEnd, allowedTenantIds]
  )

  return result.rows.map((row) => ({
    unit_id: row.unit_id,
    unit_name: row.unit_name,
    contract_id: row.contract_id,
    contract_status: row.status,
    client_name: row.client_name,
    reference_date: row.reference_date,
  }))
}

async function fetchCrmSnapshot(
  app,
  masterTenantId,
  periodInfo = null,
  options = {}
) {
  const { isMaster = false, allowedTenantIds = null } = options
  // Master agrega cross-tenant. Não-master limita por franqueadora_id == tenant.
  // allowedTenantIds (gerente_regional) restringe master a um subset.
  // baseParams = filtros de tenant (sem date). dateParams adiciona corte temporal opcional.
  const baseParams = []
  const baseConditions = []

  if (isMaster) {
    if (Array.isArray(allowedTenantIds) && allowedTenantIds.length > 0) {
      baseParams.push(allowedTenantIds)
      baseConditions.push(`franqueadora_id = ANY($${baseParams.length}::uuid[])`)
    }
    // sem allowedTenantIds → vê todos os tenants
  } else {
    baseParams.push(masterTenantId)
    baseConditions.push(`franqueadora_id = $${baseParams.length}`)
  }

  const baseWhere =
    baseConditions.length > 0 ? `WHERE ${baseConditions.join(' AND ')}` : ''

  // Params/where com filtro de data — usado em summary + stage agg (pipeline histórico).
  const params = [...baseParams]
  let dateFilter = ''
  if (periodInfo?.currentEnd) {
    params.push(periodInfo.currentEnd)
    dateFilter = `AND criado_em < $${params.length}::date`
  }
  const baseWhereWithDate = baseConditions.length > 0
    ? `WHERE ${baseConditions.join(' AND ')} ${dateFilter}`.trim()
    : (dateFilter ? `WHERE 1=1 ${dateFilter}` : '')

  // 1. Resumo legado (mantém retrocompatibilidade da UI antiga).
  const summaryResult = await app.db.query(
    `
      SELECT
        COUNT(*) AS total_leads,
        COALESCE(SUM(fat_estimado), 0) AS estimated_value,
        COUNT(*) FILTER (WHERE status = 'disponivel') AS lead_pool,
        COUNT(*) FILTER (WHERE status = 'pego') AS engaged_leads,
        COUNT(*) FILTER (WHERE status = 'expirado') AS expired_leads
      FROM leads
      ${baseWhereWithDate}
    `,
    params
  )
  const summaryRow = summaryResult.rows[0] ?? {}

  // 2. Agregação por etapa (exclui status 'expirado' — pipeline ativo).
  // Usa apenas baseParams (sem corte de data — pipeline reflete estado atual).
  const stageWhere = baseConditions.length > 0
    ? `WHERE ${baseConditions.join(' AND ')} AND status <> 'expirado'`
    : `WHERE status <> 'expirado'`
  const stageResult = await app.db.query(
    `
      SELECT
        crm_etapa AS stage,
        COUNT(*)::int AS count,
        COALESCE(SUM(valor_oportunidade), 0)::numeric AS value
      FROM leads
      ${stageWhere}
      GROUP BY crm_etapa
    `,
    baseParams
  )

  const stageMap = new Map(
    stageResult.rows.map((row) => [
      row.stage,
      { count: toInt(row.count), value: toMoney(row.value) },
    ])
  )

  // 3. Top 5 unidades por etapa (apenas master cross-tenant).
  let perTenantByStage = new Map()
  if (isMaster) {
    // Aliased conditions: baseConditions usam 'franqueadora_id' direto;
    // aqui precisamos qualificar pra l.franqueadora_id (JOIN com tenants).
    const aliasedConditions = baseConditions.map((c) =>
      c.replace(/\bfranqueadora_id\b/g, 'l.franqueadora_id')
    )
    const perTenantWhere =
      aliasedConditions.length > 0
        ? `WHERE ${aliasedConditions.join(' AND ')} AND l.status <> 'expirado'`
        : `WHERE l.status <> 'expirado'`

    const perTenantResult = await app.db.query(
      `
        SELECT
          l.crm_etapa AS stage,
          t.id AS tenant_id,
          t.nome AS tenant_nome,
          COUNT(*)::int AS count,
          COALESCE(SUM(l.valor_oportunidade), 0)::numeric AS value
        FROM leads l
        JOIN tenants t ON t.id = l.franqueadora_id
        ${perTenantWhere}
        GROUP BY l.crm_etapa, t.id, t.nome
        HAVING COUNT(*) > 0
        ORDER BY l.crm_etapa, count DESC
      `,
      baseParams
    )
    for (const row of perTenantResult.rows) {
      const list = perTenantByStage.get(row.stage) ?? []
      if (list.length < 5) {
        list.push({
          tenant_id: row.tenant_id,
          tenant_nome: row.tenant_nome,
          count: toInt(row.count),
          value: toMoney(row.value),
        })
      }
      perTenantByStage.set(row.stage, list)
    }
  }

  // 4. Pipeline final — todos os 8 stages, mesmo se count=0.
  const pipeline = CRM_STAGE_DEFS.map((def) => {
    const agg = stageMap.get(def.id) ?? { count: 0, value: 0 }
    return {
      stage: def.label, // mantém label PT-BR consumido pela UI antiga
      stage_id: def.id, // expõe o enum para drill-down e tooltip
      label: def.label,
      count: agg.count,
      value: agg.value,
      por_tenant: isMaster ? perTenantByStage.get(def.id) ?? [] : [],
    }
  })

  // 5. Totals agregados (cross-tenant ou per-tenant conforme isMaster).
  const totalsResult = await app.db.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE status <> 'expirado')::int AS leads_total,
        COALESCE(
          SUM(valor_oportunidade) FILTER (WHERE status <> 'expirado'),
          0
        )::numeric AS valor_total,
        COUNT(*) FILTER (WHERE criado_em >= NOW() - INTERVAL '7 days')::int AS leads_ultimos_7d,
        COUNT(*) FILTER (
          WHERE crm_etapa = 'ganho'
            AND ganho_em IS NOT NULL
            AND ganho_em >= NOW() - INTERVAL '30 days'
        )::int AS ganhos_30d,
        COUNT(*) FILTER (WHERE criado_em >= NOW() - INTERVAL '30 days')::int AS leads_30d
      FROM leads
      ${baseWhere}
    `,
    baseParams
  )
  const totalsRow = totalsResult.rows[0] ?? {}
  const leads30d = toInt(totalsRow.leads_30d)
  const ganhos30d = toInt(totalsRow.ganhos_30d)

  // 6. Motivo de perda mais frequente (top 1).
  const motivoWhere = baseConditions.length > 0
    ? `WHERE ${baseConditions.join(' AND ')} AND crm_etapa = 'perdido'`
    : `WHERE crm_etapa = 'perdido'`
  const motivoResult = await app.db.query(
    `
      SELECT motivo_perda, COUNT(*)::int AS qtd
      FROM leads
      ${motivoWhere}
        AND motivo_perda IS NOT NULL
        AND length(trim(motivo_perda)) > 0
      GROUP BY motivo_perda
      ORDER BY qtd DESC
      LIMIT 1
    `,
    baseParams
  )
  const motivoTop = motivoResult.rows[0]?.motivo_perda ?? null

  return {
    is_placeholder: false,
    summary: {
      total_leads: toInt(summaryRow.total_leads),
      estimated_value: toMoney(summaryRow.estimated_value),
      lead_pool: toInt(summaryRow.lead_pool),
      engaged_leads: toInt(summaryRow.engaged_leads),
      expired_leads: toInt(summaryRow.expired_leads),
    },
    pipeline,
    totals: {
      leads_total: toInt(totalsRow.leads_total),
      valor_total: toMoney(totalsRow.valor_total),
      leads_ultimos_7d: toInt(totalsRow.leads_ultimos_7d),
      taxa_ganhos_30d:
        leads30d > 0 ? Number(((ganhos30d / leads30d) * 100).toFixed(2)) : 0,
      ganhos_30d: ganhos30d,
      leads_30d: leads30d,
      motivo_perda_top: motivoTop,
    },
    recommended_fields: [
      'Nome do lead',
      'Tipo do lead',
      'Origem',
      'Responsável',
      'Estágio',
      'Valor potencial',
      'Próxima ação',
      'Data de follow-up',
      'Observações',
    ],
    message: isMaster
      ? 'CRM master agregado cross-tenant. Drill-down disponível por unidade em cada etapa.'
      : 'CRM da unidade — pipeline real conectado ao banco de leads.',
  }
}

function buildHistoryMaps(historyRows, unitIds, periods) {
  const networkByPeriod = new Map(
    periods.map((period) => [
      period,
      {
        period,
        label: formatPeriodLabel(period),
        gross_revenue: 0,
        franchisor_revenue: 0,
      },
    ])
  )

  const unitHistoryMap = new Map(
    unitIds.map((unitId) => [
      unitId,
      periods.map((period) => ({
        period,
        label: formatPeriodLabel(period),
        gross_revenue: 0,
        franchisor_revenue: 0,
      })),
    ])
  )

  for (const row of historyRows) {
    const networkPoint = networkByPeriod.get(row.period)
    if (networkPoint) {
      networkPoint.gross_revenue = toMoney(networkPoint.gross_revenue + row.gross_revenue)
      networkPoint.franchisor_revenue = toMoney(
        networkPoint.franchisor_revenue + row.franchisor_revenue
      )
    }

    const unitHistory = unitHistoryMap.get(row.unit_id)
    if (!unitHistory) continue

    const index = unitHistory.findIndex((point) => point.period === row.period)
    if (index >= 0) {
      unitHistory[index] = {
        period: row.period,
        label: row.label,
        gross_revenue: row.gross_revenue,
        franchisor_revenue: row.franchisor_revenue,
      }
    }
  }

  return {
    networkHistory: periods.map((period) => networkByPeriod.get(period)),
    unitHistoryMap,
  }
}

function buildAlerts(units, stalledContracts) {
  const alerts = []

  for (const unit of units.filter((item) => item.gross_revenue <= 0).slice(0, 3)) {
    alerts.push({
      type: 'unit_without_sales',
      severity: 'alta',
      unit_id: unit.id,
      unit_name: unit.name,
      title: 'Unidade sem venda no período',
      description: `${unit.name} ainda não registrou faturamento no período selecionado.`,
    })
  }

  for (const unit of units.filter((item) => item.growth_pct <= -20).slice(0, 3)) {
    alerts.push({
      type: 'revenue_drop',
      severity: 'alta',
      unit_id: unit.id,
      unit_name: unit.name,
      title: 'Queda forte de receita',
      description: `${unit.name} caiu ${Number(unit.growth_pct.toFixed(1))}% versus o mês anterior.`,
    })
  }

  for (const unit of units.filter((item) => item.franchisor_overdue > 0).slice(0, 3)) {
    alerts.push({
      type: 'delinquency',
      severity: 'alta',
      unit_id: unit.id,
      unit_name: unit.name,
      title: 'Inadimplência na unidade',
      description: `${unit.name} tem ${formatCurrency(unit.franchisor_overdue)} em aberto com a franqueadora.`,
    })
  }

  for (const contract of stalledContracts) {
    alerts.push({
      type: 'stalled_contract',
      severity: 'media',
      unit_id: contract.unit_id,
      unit_name: contract.unit_name,
      title: 'Contrato parado na pipeline',
      description: `${contract.client_name ?? 'Contrato sem cliente'} está em ${labelContractStatus(contract.contract_status)} há mais de 7 dias.`,
    })
  }

  return alerts.slice(0, 8)
}

function findTopBottomUnit(units) {
  const ranked = [...units]
    .filter((unit) => unit.gross_revenue > 0)
    .sort((a, b) => b.gross_revenue - a.gross_revenue)
  if (ranked.length === 0) {
    return { top: null, bottom: null }
  }
  const top = ranked[0]
  const bottom = ranked[ranked.length - 1]
  return {
    top: top
      ? { tenant_id: top.id, nome: top.name, gmv: top.gross_revenue }
      : null,
    bottom: bottom && bottom !== top
      ? { tenant_id: bottom.id, nome: bottom.name, gmv: bottom.gross_revenue }
      : null,
  }
}

function buildUnidadesEmRisco(units) {
  return units
    .filter((unit) => unit.growth_pct <= -30 && unit.previous_gross_revenue > 0)
    .slice(0, 5)
    .map((unit) => ({
      tenant_id: unit.id,
      nome: unit.name,
      gmv: unit.gross_revenue,
      queda_pct: Math.abs(Number(unit.growth_pct.toFixed(1))),
    }))
}

async function fetchMasterTotals(app, masterTenantId, periodInfo, allowedTenantIds = null) {
  const result = await app.db.query(
    `
      WITH lives_periodo AS (
        SELECT tenant_id, COUNT(*)::int AS total_lives,
               COALESCE(SUM(fat_gerado), 0) AS gmv_total
        FROM lives
        WHERE tenant_id <> $1
          AND ($5::uuid[] IS NULL OR tenant_id = ANY($5::uuid[]))
          AND COALESCE(encerrado_em, iniciado_em) >= $2::date
          AND COALESCE(encerrado_em, iniciado_em) < $3::date
        GROUP BY tenant_id
      ),
      lives_anterior AS (
        SELECT COALESCE(SUM(fat_gerado), 0) AS gmv_total
        FROM lives
        WHERE tenant_id <> $1
          AND ($5::uuid[] IS NULL OR tenant_id = ANY($5::uuid[]))
          AND COALESCE(encerrado_em, iniciado_em) >= $4::date
          AND COALESCE(encerrado_em, iniciado_em) < $2::date
      )
      SELECT
        COALESCE(SUM(lp.total_lives), 0)::int AS total_lives_mes,
        COALESCE(SUM(lp.gmv_total), 0) AS gmv_total_mes,
        (SELECT gmv_total FROM lives_anterior) AS gmv_total_mes_anterior
      FROM lives_periodo lp
    `,
    [
      masterTenantId,
      periodInfo.currentStart,
      periodInfo.currentEnd,
      periodInfo.previousStart,
      allowedTenantIds,
    ]
  )
  const row = result.rows[0] ?? {}
  return {
    total_lives_mes: toInt(row.total_lives_mes),
    gmv_total_mes: toMoney(row.gmv_total_mes),
    gmv_total_mes_anterior: toMoney(row.gmv_total_mes_anterior),
  }
}

function buildDashboardPayload(units, historyRows, periodInfo, crmSnapshot, stalledContracts, totals = null) {
  const periods = periodInfo.historyPeriods
  const { networkHistory } = buildHistoryMaps(
    historyRows,
    units.map((unit) => unit.id),
    periods
  )

  const faturamentoBruto = toMoney(
    units.reduce((sum, unit) => sum + unit.gross_revenue, 0)
  )
  const receitaFranqueadora = toMoney(
    units.reduce((sum, unit) => sum + unit.franchisor_revenue, 0)
  )
  const unidadesAtivas = units.filter((unit) => unit.status !== 'inativo').length
  const clientesAtivos = units.reduce((sum, unit) => sum + unit.active_clients, 0)
  const contratosPendentes = units.reduce((sum, unit) => sum + unit.pending_contracts, 0)
  const faturamentoAnterior = toMoney(
    units.reduce((sum, unit) => sum + unit.previous_gross_revenue, 0)
  )
  const crescimentoPct = calculateGrowth(faturamentoBruto, faturamentoAnterior)
  const inadimplenciaValor = toMoney(
    units.reduce((sum, unit) => sum + unit.franchisor_overdue, 0)
  )
  const inadimplenciaPct = calculateRate(inadimplenciaValor, receitaFranqueadora)
  const ticketMedio = unidadesAtivas > 0 ? toMoney(faturamentoBruto / unidadesAtivas) : 0
  const alerts = buildAlerts(units, stalledContracts)
  const uniqueAlertUnits = new Set(alerts.map((alert) => alert.unit_id).filter(Boolean)).size

  const cards = {
    unidades_ativas: unidadesAtivas,
    clientes_ativos: clientesAtivos,
    faturamento_bruto_rede: faturamentoBruto,
    receita_liquida_franqueadora: receitaFranqueadora,
    contratos_pendentes: contratosPendentes,
    crescimento_percentual: crescimentoPct,
    inadimplencia_valor: inadimplenciaValor,
    inadimplencia_percentual: inadimplenciaPct,
    ticket_medio_unidade: ticketMedio,
  }

  const { top: unidadeTop, bottom: unidadePior } = findTopBottomUnit(units)
  const unidadesEmRisco = buildUnidadesEmRisco(units)
  const totalsResolved = totals ?? {
    gmv_total_mes: faturamentoBruto,
    gmv_total_mes_anterior: faturamentoAnterior,
    total_lives_mes: 0,
  }
  const gmvCrescimentoPct = calculateGrowth(
    totalsResolved.gmv_total_mes,
    totalsResolved.gmv_total_mes_anterior
  )

  return {
    periodo: periodInfo.period,
    periodo_anterior: periodInfo.previousPeriod,
    cards,
    // Campos top-level F3 (Dashboard Master cross-tenant)
    gmv_total_mes: toMoney(totalsResolved.gmv_total_mes),
    gmv_crescimento_pct: gmvCrescimentoPct,
    royalties_total_mes: receitaFranqueadora,
    total_unidades_ativas: unidadesAtivas,
    total_lives_mes: totalsResolved.total_lives_mes,
    total_clientes_ativos: clientesAtivos,
    unidade_top_gmv: unidadeTop,
    unidade_pior_gmv: unidadePior,
    unidades_em_risco: unidadesEmRisco,
    resumo_executivo: buildExecutiveSummary(cards, uniqueAlertUnits),
    rankings: {
      faturamento: [...units]
        .sort((a, b) => b.gross_revenue - a.gross_revenue)
        .slice(0, 5)
        .map((unit) => ({
          unit_id: unit.id,
          unit_name: unit.name,
          gross_revenue: unit.gross_revenue,
          growth_pct: unit.growth_pct,
        })),
      crescimento: [...units]
        .sort((a, b) => b.growth_pct - a.growth_pct)
        .slice(0, 5)
        .map((unit) => ({
          unit_id: unit.id,
          unit_name: unit.name,
          gross_revenue: unit.gross_revenue,
          growth_pct: unit.growth_pct,
        })),
    },
    alertas: alerts,
    historico_rede: networkHistory,
    crescimento_unidades: [...units]
      .sort((a, b) => b.growth_pct - a.growth_pct)
      .slice(0, 8)
      .map((unit) => ({
        unit_id: unit.id,
        unit_name: unit.name,
        growth_pct: unit.growth_pct,
        gross_revenue: unit.gross_revenue,
        previous_gross_revenue: unit.previous_gross_revenue,
      })),
    crm_pipeline: crmSnapshot.pipeline,
    comissionamento: {
      previsto: receitaFranqueadora,
      recebido: toMoney(units.reduce((sum, unit) => sum + unit.franchisor_received, 0)),
      pendente: toMoney(units.reduce((sum, unit) => sum + unit.franchisor_pending, 0)),
      inadimplente: inadimplenciaValor,
    },
  }
}

async function fetchNetworkRanking(app, {
  excludeTenantId = null,
  periodInfo,
  allowedTenantIds = null,
  limit = null,
  publicOnly = false,
}) {
  return app.db.query(
    `
      WITH lives_atual AS (
        SELECT tenant_id,
               COUNT(*)::int AS total_lives,
               COALESCE(SUM(fat_gerado), 0) AS gmv_mes
        FROM lives
        WHERE ($1::uuid IS NULL OR tenant_id <> $1::uuid)
          AND COALESCE(encerrado_em, iniciado_em) >= $2::date
          AND COALESCE(encerrado_em, iniciado_em) < $3::date
        GROUP BY tenant_id
      ),
      lives_anterior AS (
        SELECT tenant_id,
               COALESCE(SUM(fat_gerado), 0) AS gmv_mes_anterior
        FROM lives
        WHERE ($1::uuid IS NULL OR tenant_id <> $1::uuid)
          AND COALESCE(encerrado_em, iniciado_em) >= $4::date
          AND COALESCE(encerrado_em, iniciado_em) < $2::date
        GROUP BY tenant_id
      ),
      clientes_ativos AS (
        SELECT tenant_id, COUNT(*)::int AS total_clientes
        FROM clientes
        WHERE status = 'ativo'
          AND criado_em < $3::date
        GROUP BY tenant_id
      ),
      clientes_anterior AS (
        SELECT tenant_id, COUNT(*)::int AS total_clientes_ant
        FROM clientes
        WHERE status = 'ativo'
          AND criado_em < $2::date
        GROUP BY tenant_id
      )
      SELECT
        t.id,
        COALESCE(t.ranking_publico_nome, t.nome) AS nome,
        COALESCE(t.ranking_publico_logo_url, t.logo_url) AS logo_url,
        COALESCE(t.ranking_publico_cidade, t.cidade) AS cidade,
        COALESCE(t.ranking_publico_uf, t.uf) AS uf,
        t.ranking_publico_meta_gmv,
        COALESCE(la.gmv_mes, 0) AS gmv_mes,
        COALESCE(lp.gmv_mes_anterior, 0) AS gmv_mes_anterior,
        COALESCE(la.total_lives, 0) AS total_lives,
        COALESCE(ca.total_clientes, 0) AS total_clientes_ativos,
        COALESCE(cant.total_clientes_ant, 0) AS total_clientes_ant
      FROM tenants t
      LEFT JOIN lives_atual la ON la.tenant_id = t.id
      LEFT JOIN lives_anterior lp ON lp.tenant_id = t.id
      LEFT JOIN clientes_ativos ca ON ca.tenant_id = t.id
      LEFT JOIN clientes_anterior cant ON cant.tenant_id = t.id
      WHERE ($1::uuid IS NULL OR t.id <> $1::uuid)
        AND ($5::uuid[] IS NULL OR t.id = ANY($5::uuid[]))
        AND t.criado_em < $3::date
        AND (t.ranking_publico_ativo IS DISTINCT FROM FALSE OR $5::uuid[] IS NOT NULL)
        AND (
          $7::boolean IS FALSE
          OR (
            t.ranking_publico_ativo IS TRUE
            AND NULLIF(TRIM(t.ranking_publico_nome), '') IS NOT NULL
            AND CONCAT_WS(' ', t.nome, t.ranking_publico_nome) !~* '(teste|test|dev|homolog|staging|qa[_ -]?release|release[_ -]?react|teseste|t[e3][^[:alpha:]]*st[e3])'
          )
        )
      ORDER BY COALESCE(la.gmv_mes, 0) DESC, t.nome ASC
      LIMIT COALESCE($6::int, 2147483647)
    `,
    [
      excludeTenantId,
      periodInfo.currentStart,
      periodInfo.currentEnd,
      periodInfo.previousStart,
      allowedTenantIds,
      limit,
      publicOnly,
    ]
  )
}

function mapNetworkRanking(rows, { publicOnly = false } = {}) {
  return rows.map((row, index) => {
    const gmvMes = toMoney(row.gmv_mes)
    const gmvMesAnt = toMoney(row.gmv_mes_anterior)
    const totalClientesAtuais = toInt(row.total_clientes_ativos)
    const totalClientesAnt = toInt(row.total_clientes_ant)
    let taxaRetencao = 0
    if (totalClientesAnt > 0) {
      taxaRetencao = Number(
        ((Math.min(totalClientesAtuais, totalClientesAnt) / totalClientesAnt) * 100).toFixed(1)
      )
    } else if (totalClientesAtuais > 0) {
      taxaRetencao = 100
    }

    const base = {
      posicao: index + 1,
      nome: row.nome,
      logo_url: row.logo_url ?? null,
      cidade: row.cidade ?? null,
      uf: row.uf ?? null,
      meta_gmv: row.ranking_publico_meta_gmv == null ? null : toMoney(row.ranking_publico_meta_gmv),
      gmv_mes: gmvMes,
      crescimento_pct: calculateGrowth(gmvMes, gmvMesAnt),
      total_lives: toInt(row.total_lives),
      total_clientes_ativos: totalClientesAtuais,
    }

    if (publicOnly) return base

    return {
      ...base,
      tenant_id: row.id,
      tenant_nome: row.nome,
      gmv_mes_anterior: gmvMesAnt,
      taxa_retencao: taxaRetencao,
    }
  })
}

export async function franqueadoRoutes(app) {
  // masterAccess: aceita franqueador_master OU gerente_regional.
  // requireTenantAccess injeta:
  //   request.isMaster = true        → vê todas as unidades (legado)
  //   request.isMaster = false       → gerente_regional, vê só
  //   request.allowedTenantIds = []  → subset configurado em user_tenant_access
  const masterAccess = {
    onRequest: [
      app.authenticate,
      app.requirePapel(['franqueador_master', 'gerente_regional']),
      app.requireTenantAccess,
    ],
  }

  // Compatibilidade com a tela antiga do franqueador.
  app.get(
    '/v1/franqueado/unidades',
    masterAccess,
    async (req, reply) => {
      try {
        const { rows } = await app.db.query(
          `
            SELECT
              t.id,
              t.nome,
              COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'ativo') AS clientes_count,
              COALESCE(SUM(l.fat_gerado), 0) AS fat_mes,
              COUNT(DISTINCT ct.id) FILTER (
                WHERE ct.status IN ('gerado', 'enviado', 'em_analise')
              ) AS contratos_pendentes,
              CASE WHEN COUNT(DISTINCT u.id) > 0 THEN 'ativo' ELSE 'inativo' END AS status
            FROM tenants t
            LEFT JOIN users u ON u.tenant_id = t.id AND u.ativo = TRUE
            LEFT JOIN clientes c ON c.tenant_id = t.id
            LEFT JOIN contratos ct ON ct.tenant_id = t.id
            LEFT JOIN lives l
              ON l.tenant_id = t.id
             AND date_trunc('month', l.iniciado_em) = date_trunc('month', NOW())
            WHERE t.id != $1
              AND ($2::uuid[] IS NULL OR t.id = ANY($2::uuid[]))
            GROUP BY t.id, t.nome
            ORDER BY fat_mes DESC
          `,
          [req.user.tenant_id, req.allowedTenantIds]
        )

        const unidades = rows.map((row) => ({
          ...row,
          fat_mes: Number(row.fat_mes ?? 0),
          clientes_count: Number(row.clientes_count ?? 0),
          contratos_pendentes: Number(row.contratos_pendentes ?? 0),
        }))

        return reply.send(unidades)
      } catch (err) {
        req.log.error({ err }, 'franqueado/unidades: erro')
        throw err
      }
    }
  )

  app.get('/v1/master/dashboard', masterAccess, async (request, reply) => {
    try {
      const periodInfo = parsePeriod(request.query?.periodo)
      const allowed = request.allowedTenantIds
      const units = await fetchUnitSummaries(app, request.user.tenant_id, periodInfo, 'todos', allowed)
      const historyRows = await fetchHistoryRows(app, request.user.tenant_id, periodInfo, allowed)
      const crmSnapshot = await fetchCrmSnapshot(
        app,
        request.user.tenant_id,
        periodInfo,
        { isMaster: true, allowedTenantIds: allowed }
      )
      const stalledContracts = await fetchStalledContracts(app, request.user.tenant_id, periodInfo, allowed)
      const totals = await fetchMasterTotals(app, request.user.tenant_id, periodInfo, allowed)

      return reply.send(
        buildDashboardPayload(
          units,
          historyRows,
          periodInfo,
          crmSnapshot,
          stalledContracts,
          totals
        )
      )
    } catch (err) {
      request.log.error({ err }, 'master/dashboard: erro')
      throw err
    }
  })

  // Ranking público cross-tenant com payload sanitizado.
  // Exclui o master tenant (franqueadora) — ranking só de franqueados.
  app.get('/v1/public/ranking', async (request, reply) => {
    try {
      const periodInfo = parsePeriod(request.query?.periodo)
      const rawLimit = Number(request.query?.limit ?? 10)
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.trunc(rawLimit), 1), 20)
        : 10
      // MASTER_TENANT_ID: defined in migrations/001_create_users.sql
      const MASTER_TENANT_ID = '00000000-0000-0000-0000-000000000001'
      const result = await fetchNetworkRanking(app, {
        periodInfo,
        limit,
        excludeTenantId: MASTER_TENANT_ID,
        publicOnly: true,
      })

      return reply.send(mapNetworkRanking(result.rows, { publicOnly: true }))
    } catch (err) {
      request.log.error({ err }, 'public/ranking: erro')
      throw err
    }
  })

  // F3 — Ranking de unidades cross-tenant
  app.get('/v1/master/ranking', masterAccess, async (request, reply) => {
    try {
      const periodInfo = parsePeriod(request.query?.periodo)
      const result = await fetchNetworkRanking(app, {
        excludeTenantId: request.user.tenant_id,
        periodInfo,
        allowedTenantIds: request.allowedTenantIds,
      })

      return reply.send(mapNetworkRanking(result.rows))
    } catch (err) {
      request.log.error({ err }, 'master/ranking: erro')
      throw err
    }
  })

  // F3 — Histórico de uma unidade (últimos 6 meses)
  app.get('/v1/master/unidade/:tenantId/historico', masterAccess, async (request, reply) => {
    try {
      const { tenantId } = request.params
      if (!tenantId || typeof tenantId !== 'string' || tenantId.length < 8) {
        return reply.code(400).send({ error: 'tenantId inválido' })
      }
      // Master só pode consultar tenants diferentes do dele.
      if (tenantId === request.user.tenant_id) {
        return reply.code(400).send({ error: 'tenantId deve ser de uma unidade da rede' })
      }
      // gerente_regional: precisa ter o tenant na lista permitida.
      if (
        !request.isMaster &&
        Array.isArray(request.allowedTenantIds) &&
        !request.allowedTenantIds.includes(tenantId)
      ) {
        return reply.code(403).send({ error: 'Acesso não autorizado a esta unidade' })
      }
      const result = await app.db.query(
        `
          WITH meses AS (
            SELECT generate_series(
              date_trunc('month', NOW()) - interval '5 months',
              date_trunc('month', NOW()),
              interval '1 month'
            )::date AS mes_inicio
          ),
          agregados AS (
            SELECT
              date_trunc('month', COALESCE(l.encerrado_em, l.iniciado_em))::date AS mes_inicio,
              COUNT(*)::int AS lives,
              COALESCE(SUM(l.fat_gerado), 0) AS gmv
            FROM lives l
            WHERE l.tenant_id = $1
              AND COALESCE(l.encerrado_em, l.iniciado_em) >= date_trunc('month', NOW()) - interval '5 months'
              AND COALESCE(l.encerrado_em, l.iniciado_em) < date_trunc('month', NOW()) + interval '1 month'
            GROUP BY 1
          )
          SELECT
            to_char(m.mes_inicio, 'YYYY-MM') AS mes,
            COALESCE(a.gmv, 0) AS gmv,
            COALESCE(a.lives, 0)::int AS lives
          FROM meses m
          LEFT JOIN agregados a ON a.mes_inicio = m.mes_inicio
          ORDER BY m.mes_inicio ASC
        `,
        [tenantId]
      )
      return reply.send(
        result.rows.map((row) => ({
          mes: row.mes,
          gmv: toMoney(row.gmv),
          lives: toInt(row.lives),
        }))
      )
    } catch (err) {
      request.log.error({ err }, 'master/unidade/historico: erro')
      throw err
    }
  })

  // F3 — Alertas operacionais cross-tenant
  app.get('/v1/master/alertas', masterAccess, async (request, reply) => {
    try {
      const periodInfo = parsePeriod(request.query?.periodo)
      const allowed = request.allowedTenantIds
      const params = [
        request.user.tenant_id,
        periodInfo.currentStart,
        periodInfo.previousStart,
        allowed,
      ]

      // 1. GMV queda >= 30% vs mês anterior
      const gmvQuedaQuery = app.db.query(
        `
          WITH atual AS (
            SELECT tenant_id, COALESCE(SUM(fat_gerado), 0) AS gmv
            FROM lives
            WHERE tenant_id <> $1
              AND ($4::uuid[] IS NULL OR tenant_id = ANY($4::uuid[]))
              AND COALESCE(encerrado_em, iniciado_em) >= $2::date
            GROUP BY tenant_id
          ),
          anterior AS (
            SELECT tenant_id, COALESCE(SUM(fat_gerado), 0) AS gmv
            FROM lives
            WHERE tenant_id <> $1
              AND ($4::uuid[] IS NULL OR tenant_id = ANY($4::uuid[]))
              AND COALESCE(encerrado_em, iniciado_em) >= $3::date
              AND COALESCE(encerrado_em, iniciado_em) < $2::date
            GROUP BY tenant_id
          )
          SELECT t.id AS tenant_id, t.nome,
                 COALESCE(a.gmv, 0) AS gmv_atual,
                 COALESCE(p.gmv, 0) AS gmv_anterior
          FROM tenants t
          LEFT JOIN atual a ON a.tenant_id = t.id
          LEFT JOIN anterior p ON p.tenant_id = t.id
          WHERE t.id <> $1
            AND ($4::uuid[] IS NULL OR t.id = ANY($4::uuid[]))
            AND COALESCE(p.gmv, 0) > 0
            AND COALESCE(a.gmv, 0) <= COALESCE(p.gmv, 0) * 0.7
          ORDER BY (COALESCE(p.gmv, 0) - COALESCE(a.gmv, 0)) DESC
          LIMIT 10
        `,
        params
      )

      // 2. Sem lives nos últimos 7 dias
      const semLivesQuery = app.db.query(
        `
          SELECT t.id AS tenant_id, t.nome,
                 MAX(COALESCE(l.encerrado_em, l.iniciado_em)) AS ultima_live
          FROM tenants t
          LEFT JOIN lives l ON l.tenant_id = t.id
          WHERE t.id <> $1
            AND ($2::uuid[] IS NULL OR t.id = ANY($2::uuid[]))
            AND t.ativo = TRUE
          GROUP BY t.id, t.nome
          HAVING MAX(COALESCE(l.encerrado_em, l.iniciado_em)) IS NULL
              OR MAX(COALESCE(l.encerrado_em, l.iniciado_em)) < NOW() - interval '7 days'
          ORDER BY ultima_live ASC NULLS FIRST
          LIMIT 10
        `,
        [request.user.tenant_id, allowed]
      )

      // 3. Boletos vencidos (status='vencido' OU pendente com vencimento < hoje)
      const boletosVencidosQuery = app.db.query(
        `
          SELECT t.id AS tenant_id, t.nome,
                 COUNT(b.id)::int AS total_vencidos,
                 COALESCE(SUM(b.valor), 0) AS valor_total
          FROM boletos b
          JOIN tenants t ON t.id = b.tenant_id
          WHERE b.tenant_id <> $1
            AND ($2::uuid[] IS NULL OR b.tenant_id = ANY($2::uuid[]))
            AND (b.status = 'vencido'
                 OR (b.status = 'pendente' AND b.vencimento < CURRENT_DATE))
          GROUP BY t.id, t.nome
          ORDER BY valor_total DESC
          LIMIT 10
        `,
        [request.user.tenant_id, allowed]
      )

      // 4. Contratos expirando em até 30 dias (ativos com fim próximo)
      const contratosExpirandoQuery = app.db.query(
        `
          SELECT t.id AS tenant_id, t.nome,
                 c.id AS contrato_id,
                 cl.nome AS cliente_nome,
                 c.fim
          FROM contratos c
          JOIN tenants t ON t.id = c.tenant_id
          LEFT JOIN clientes cl ON cl.id = c.cliente_id
          WHERE c.tenant_id <> $1
            AND ($2::uuid[] IS NULL OR c.tenant_id = ANY($2::uuid[]))
            AND c.status = 'ativo'
            AND c.fim IS NOT NULL
            AND c.fim >= CURRENT_DATE
            AND c.fim <= CURRENT_DATE + interval '30 days'
          ORDER BY c.fim ASC
          LIMIT 10
        `,
        [request.user.tenant_id, allowed]
      )

      const [gmvQuedaRes, semLivesRes, boletosRes, contratosRes] = await Promise.all([
        gmvQuedaQuery.catch((err) => {
          request.log.warn({ err }, 'master/alertas: falha gmv_queda')
          return { rows: [] }
        }),
        semLivesQuery.catch((err) => {
          request.log.warn({ err }, 'master/alertas: falha sem_lives')
          return { rows: [] }
        }),
        boletosVencidosQuery.catch((err) => {
          request.log.warn({ err }, 'master/alertas: falha boletos')
          return { rows: [] }
        }),
        contratosExpirandoQuery.catch((err) => {
          request.log.warn({ err }, 'master/alertas: falha contratos')
          return { rows: [] }
        }),
      ])

      const alertas = []

      for (const row of gmvQuedaRes.rows) {
        const atual = toMoney(row.gmv_atual)
        const anterior = toMoney(row.gmv_anterior)
        const queda = anterior > 0 ? Math.round(((anterior - atual) / anterior) * 100) : 0
        alertas.push({
          tenant_id: row.tenant_id,
          nome: row.nome,
          tipo_alerta: 'gmv_queda_30pct',
          detalhe: `GMV de ${formatCurrency(atual)} vs ${formatCurrency(anterior)} no mês anterior (queda ${queda}%)`,
        })
      }

      for (const row of semLivesRes.rows) {
        const ultima = row.ultima_live
          ? new Date(row.ultima_live).toLocaleDateString('pt-BR')
          : 'nunca'
        alertas.push({
          tenant_id: row.tenant_id,
          nome: row.nome,
          tipo_alerta: 'sem_lives_7dias',
          detalhe: `Última live em ${ultima}`,
        })
      }

      for (const row of boletosRes.rows) {
        alertas.push({
          tenant_id: row.tenant_id,
          nome: row.nome,
          tipo_alerta: 'boleto_vencido',
          detalhe: `${toInt(row.total_vencidos)} boleto(s) vencido(s) — ${formatCurrency(toMoney(row.valor_total))} em aberto`,
        })
      }

      for (const row of contratosRes.rows) {
        const fim = row.fim ? new Date(row.fim).toLocaleDateString('pt-BR') : ''
        const cliente = row.cliente_nome ? ` (${row.cliente_nome})` : ''
        alertas.push({
          tenant_id: row.tenant_id,
          nome: row.nome,
          tipo_alerta: 'contrato_expirando_30dias',
          detalhe: `Contrato${cliente} expira em ${fim}`,
        })
      }

      return reply.send(alertas)
    } catch (err) {
      request.log.error({ err }, 'master/alertas: erro')
      throw err
    }
  })

  app.get('/v1/master/unidades', masterAccess, async (request, reply) => {
    try {
      const periodInfo = parsePeriod(request.query?.periodo)
      const status = normalizeStatus(request.query?.status)
      const allowed = request.allowedTenantIds
      const units = await fetchUnitSummaries(app, request.user.tenant_id, periodInfo, status, allowed)
      const historyRows = await fetchHistoryRows(app, request.user.tenant_id, periodInfo, allowed)
      const unitClients = await fetchUnitClients(app, request.user.tenant_id, periodInfo, allowed)
      const { unitHistoryMap } = buildHistoryMaps(
        historyRows,
        units.map((unit) => unit.id),
        periodInfo.historyPeriods
      )
      const clientsByUnit = new Map()

      for (const client of unitClients) {
        const collection = clientsByUnit.get(client.unit_id) ?? []
        collection.push({
          id: client.id,
          name: client.name,
          status: client.status,
          gross_revenue: client.gross_revenue,
          contract_pct: client.contract_pct,
          franchisor_revenue: client.franchisor_revenue,
          monthly_fee: client.monthly_fee,
          live_gmv: client.live_gmv,
          notes: client.notes,
        })
        clientsByUnit.set(client.unit_id, collection)
      }

      const payloadUnits = units.map((unit) => ({
        id: unit.id,
        name: unit.name,
        status: unit.status,
        region: null,
        active_clients: unit.active_clients,
        gross_revenue: unit.gross_revenue,
        unit_net_revenue: unit.unit_net_revenue,
        franchisor_revenue: unit.franchisor_revenue,
        growth_pct: unit.growth_pct,
        contract_pct: unit.contract_pct,
        pending_contracts: unit.pending_contracts,
        take_rate: unit.take_rate,
        history: unitHistoryMap.get(unit.id) ?? [],
        clients: clientsByUnit.get(unit.id) ?? [],
      }))

      return reply.send({
        periodo: periodInfo.period,
        status,
        summary: {
          total_unidades: payloadUnits.length,
          clientes_ativos: payloadUnits.reduce((sum, unit) => sum + unit.active_clients, 0),
          faturamento_bruto: toMoney(
            payloadUnits.reduce((sum, unit) => sum + unit.gross_revenue, 0)
          ),
          receita_franqueadora: toMoney(
            payloadUnits.reduce((sum, unit) => sum + unit.franchisor_revenue, 0)
          ),
        },
        units: payloadUnits,
      })
    } catch (err) {
      request.log.error({ err }, 'master/unidades: erro')
      throw err
    }
  })

  app.get('/v1/master/consolidado', masterAccess, async (request, reply) => {
    try {
      const periodInfo = parsePeriod(request.query?.periodo)
      const status = normalizeStatus(request.query?.status)
      const allowed = request.allowedTenantIds
      const units = await fetchUnitSummaries(app, request.user.tenant_id, periodInfo, status, allowed)
      const historyRows = await fetchHistoryRows(app, request.user.tenant_id, periodInfo, allowed)
      const { networkHistory } = buildHistoryMaps(
        historyRows,
        units.map((unit) => unit.id),
        periodInfo.historyPeriods
      )

      const grossRevenue = toMoney(units.reduce((sum, unit) => sum + unit.gross_revenue, 0))
      const previousGross = toMoney(
        units.reduce((sum, unit) => sum + unit.previous_gross_revenue, 0)
      )
      const franchisorRevenue = toMoney(
        units.reduce((sum, unit) => sum + unit.franchisor_revenue, 0)
      )
      const fixedRevenue = toMoney(units.reduce((sum, unit) => sum + unit.fixed_revenue, 0))
      const commissionRevenue = toMoney(
        units.reduce((sum, unit) => sum + unit.commission_revenue, 0)
      )
      const overdueRevenue = toMoney(
        units.reduce((sum, unit) => sum + unit.franchisor_overdue, 0)
      )
      const pendingRevenue = toMoney(
        units.reduce((sum, unit) => sum + unit.franchisor_pending, 0)
      )

      return reply.send({
        periodo: periodInfo.period,
        status,
        overview: {
          faturamento_bruto_rede: grossRevenue,
          receita_franqueadora: franchisorRevenue,
          receita_mensalidade: fixedRevenue,
          receita_comissao: commissionRevenue,
          receita_outros: 0,
          crescimento_percentual: calculateGrowth(grossRevenue, previousGross),
          mrr_rede: fixedRevenue,
          take_rate_medio: calculateRate(franchisorRevenue, grossRevenue),
          previsao_recebimento: toMoney(pendingRevenue + overdueRevenue),
          inadimplencia_valor: overdueRevenue,
          inadimplencia_percentual: calculateRate(overdueRevenue, franchisorRevenue),
          comparativo_valor: toMoney(grossRevenue - previousGross),
        },
        historico: networkHistory,
        units: units.map((unit) => ({
          id: unit.id,
          name: unit.name,
          status: unit.status,
          gross_revenue: unit.gross_revenue,
          contract_pct: unit.contract_pct,
          franchisor_revenue: unit.franchisor_revenue,
          growth_pct: unit.growth_pct,
          take_rate: unit.take_rate,
        })),
      })
    } catch (err) {
      request.log.error({ err }, 'master/consolidado: erro')
      throw err
    }
  })

  app.get('/v1/master/crm', masterAccess, async (request, reply) => {
    try {
      const allowed = request.allowedTenantIds
      // gerente_regional: isMaster=false na semantica de visão (só seus tenants),
      // mas o snapshot precisa agregar cross-tenant pelo allowedTenantIds.
      // Tratamos ambos como cross-tenant aqui — diferença é o filtro de array.
      const crmSnapshot = await fetchCrmSnapshot(
        app,
        request.user.tenant_id,
        null,
        { isMaster: true, allowedTenantIds: allowed }
      )
      const units = await fetchUnitSummaries(
        app,
        request.user.tenant_id,
        parsePeriod(request.query?.periodo),
        'todos',
        allowed
      )

      return reply.send({
        ...crmSnapshot,
        summary: {
          ...crmSnapshot.summary,
          contratos_pendentes: units.reduce((sum, unit) => sum + unit.pending_contracts, 0),
        },
      })
    } catch (err) {
      request.log.error({ err }, 'master/crm: erro')
      throw err
    }
  })

}
