// One-shot (2ª onda — unificação da comissão): reprocessa TODAS as lives
// encerradas/publicadas com a regra ÚNICA do commission-engine:
//   comissao_franquia = MAX(marca.valor_fixo_minimo, gmv * marca.comissao_franquia_pct/100)
// Também grava pedidos reais e persiste lives.comissao_calculada = Σ vendas_atribuidas.comissao_franquia
// (invariante Financeiro == Comissões). Idempotente: ON CONFLICT em vendas_atribuidas e
// NÃO recalcula linhas já 'aprovada'.
//
// ⚠️ Altera comissões já gravadas (inclusive do mês corrente — escada da apresentadora).
//    Rodar de forma controlada e conferir antes/depois.
//
// Uso:
//   railway run node scripts/backfill_comissoes_unificacao.js
//
import pg from 'pg'
import 'dotenv/config'
import { calcularComissoesDaLive } from '../src/services/commission-engine.js'
import { resolveDbSslConfig } from '../src/utils/db-ssl.js'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveDbSslConfig(process.env.DATABASE_URL),
})

async function main() {
  console.log('[backfill-comissoes] buscando lives encerradas/publicadas')
  const lookup = await pool.connect()
  let targets
  try {
    const r = await lookup.query(
      `SELECT l.id, l.tenant_id,
              COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)      AS gmv,
              COALESCE(l.manual_orders, l.final_orders_count, 0)      AS pedidos
         FROM lives l
        WHERE l.status = 'encerrada' OR l.status_publicacao = 'publicado'
        ORDER BY l.criado_em ASC`,
    )
    targets = r.rows
  } finally {
    lookup.release()
  }

  console.log(`[backfill-comissoes] ${targets.length} lives para reprocessar`)
  let ok = 0
  let semComissao = 0
  let errors = 0

  for (const live of targets) {
    const client = await pool.connect()
    try {
      // BEGIN garante que set_config(..., true) (transaction-local) preserve o RLS
      // durante TODAS as queries do engine. Mesmo padrão do cron recalcular_comissoes.js.
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.tenant_id', $1::text, true)`, [live.tenant_id])
      const result = await calcularComissoesDaLive(client, {
        liveId: live.id,
        tenantId: live.tenant_id,
        gmv: Number(live.gmv),
        pedidos: Number(live.pedidos),
      })
      await client.query('COMMIT')
      if (Array.isArray(result) && result.length > 0) ok += 1
      else semComissao += 1
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      errors += 1
      console.error(`[backfill-comissoes] ERRO live ${live.id}: ${err.message}`)
    } finally {
      client.release()
    }
  }

  console.log(`\n[backfill-comissoes] concluído: ${ok} processadas, ${semComissao} sem comissão (marca/apresentadora não resolvida), ${errors} erros`)
  await pool.end()
}

main().catch((err) => {
  console.error('[backfill-comissoes] FATAL:', err)
  process.exit(1)
})
