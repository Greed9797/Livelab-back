// Script one-off: reconcilia o GMV oficial das lives com vendas_atribuidas.
//
// Uso:
//   railway run node scripts/reconciliar_lives_gmv_financeiro.js
//   railway run node scripts/reconciliar_lives_gmv_financeiro.js --mes=2026-05
//   railway run node scripts/reconciliar_lives_gmv_financeiro.js --tenant=<uuid> --limit=100
//   railway run node scripts/reconciliar_lives_gmv_financeiro.js --dry-run
//
// Seguro para financeiro fechado: calcularComissoesDaLive não sobrescreve vendas
// com status_aprovacao='aprovada'. Essas lives são listadas como ignoradas.

import pg from 'pg'
import 'dotenv/config'
import { calcularComissoesDaLive } from '../src/services/commission-engine.js'

function readArg(name) {
  const prefix = `--${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function monthRange(mes) {
  if (!mes) return null
  if (!/^\d{4}-\d{2}$/.test(mes)) {
    throw new Error('--mes deve estar no formato YYYY-MM')
  }
  const [year, month] = mes.split('-').map(Number)
  const start = `${year}-${String(month).padStart(2, '0')}-01`
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
  return { start, end }
}

const mes = readArg('mes')
const tenantId = readArg('tenant')
const limit = Math.min(1000, Math.max(1, Number(readArg('limit') ?? 500)))
const dryRun = hasFlag('dry-run')
const range = monthRange(mes)

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

async function main() {
  const filters = [
    `l.status = 'encerrada'`,
    `l.marca_id IS NOT NULL`,
    `COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) > 0`,
  ]
  const params = []

  if (tenantId) {
    params.push(tenantId)
    filters.push(`l.tenant_id = $${params.length}::uuid`)
  }
  if (range) {
    params.push(range.start)
    filters.push(`(l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date >= $${params.length}::date`)
    params.push(range.end)
    filters.push(`(l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date <= $${params.length}::date`)
  }

  params.push(limit)
  const limitParam = params.length

  console.log('[reconciliar-gmv] Buscando lives com GMV financeiro divergente')
  if (mes) console.log(`[reconciliar-gmv] mes=${mes}`)
  if (tenantId) console.log(`[reconciliar-gmv] tenant=${tenantId}`)
  if (dryRun) console.log('[reconciliar-gmv] DRY RUN: nenhuma venda sera alterada')

  const lookup = await pool.connect()
  let targets
  try {
    const result = await lookup.query(
      `
      WITH live_totals AS (
        SELECT
          l.id,
          l.tenant_id,
          COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)::numeric AS official_gmv,
          COALESCE(SUM(va.gmv) FILTER (
            WHERE COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
          ), 0)::numeric AS financeiro_gmv,
          COUNT(va.id)::int AS vendas_count,
          COALESCE(BOOL_OR(va.status_aprovacao = 'aprovada'), false) AS has_approved
        FROM lives l
        LEFT JOIN vendas_atribuidas va
          ON va.tenant_id = l.tenant_id
         AND va.origem = 'live'
         AND va.origem_id = l.id
        WHERE ${filters.join(' AND ')}
        GROUP BY l.id, l.tenant_id, official_gmv
      )
      SELECT *
      FROM live_totals
      WHERE vendas_count = 0
         OR ABS(official_gmv - financeiro_gmv) > 0.01
      ORDER BY ABS(official_gmv - financeiro_gmv) DESC, id ASC
      LIMIT $${limitParam}
      `,
      params,
    )
    targets = result.rows
  } finally {
    lookup.release()
  }

  console.log(`[reconciliar-gmv] ${targets.length} lives candidatas`)

  let updated = 0
  let skippedApproved = 0
  let errors = 0

  for (const live of targets) {
    const delta = Number(live.official_gmv) - Number(live.financeiro_gmv)
    if (live.has_approved) {
      skippedApproved += 1
      console.log(`[reconciliar-gmv] SKIP aprovada ${live.id} delta=${delta.toFixed(2)}`)
      continue
    }

    if (dryRun) {
      console.log(`[reconciliar-gmv] DRY ${live.id} financeiro=${live.financeiro_gmv} oficial=${live.official_gmv}`)
      continue
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.tenant_id', $1::text, true)`, [live.tenant_id])
      const rows = await calcularComissoesDaLive(client, {
        liveId: live.id,
        tenantId: live.tenant_id,
        gmv: Number(live.official_gmv),
      })
      await client.query('COMMIT')
      updated += 1
      console.log(`[reconciliar-gmv] OK ${live.id} vendas=${rows.length} oficial=${live.official_gmv}`)
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      errors += 1
      console.error(`[reconciliar-gmv] ERRO ${live.id}: ${err.message}`)
    } finally {
      client.release()
    }
  }

  console.log(`\n[reconciliar-gmv] Finalizado: ${updated} atualizadas, ${skippedApproved} aprovadas ignoradas, ${errors} erros.`)
  await pool.end()
}

main().catch((err) => {
  console.error('[reconciliar-gmv] FATAL:', err)
  process.exit(1)
})
