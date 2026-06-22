// Recalcula comissão de TODAS as lives finalizadas, sob as regras novas
// (marca sempre resolve; sem gate de status). One-off / idempotente.
//
// Usa:
//   - commission-engine.calcularComissoesDaLive  (idempotente: ON CONFLICT em vendas_atribuidas;
//     nunca recalcula linhas status_aprovacao='aprovada')
//   - metric-sql.liveGmvSql  (COALESCE ads_gmv, manual_gmv, fat_gerado, 0)
//   - padrão RLS: BEGIN + set_config('app.tenant_id',...,true) por transação
//     (ver src/jobs/recalcular_comissoes.js:62-64 e scripts/backfill_comissoes_unificacao.js:52-53)
//
// ⚠️  NÃO executar sem DATABASE_URL configurado. O script conecta ao banco e
//     altera vendas_atribuidas/lives (idempotente, mas irreversível pra linhas
//     que não estavam aprovadas). Use `node --check` para validar sintaxe sem
//     conectar.
//
// Uso em produção (após deploy da Task 6):
//   railway run node scripts/reprocessar_todas_comissoes.js
//
// Status esperado: "reprocessamento: N ok, 0 falhas"
// Falhas listam o live_id para investigação manual.

import pg from 'pg'
import 'dotenv/config'
import { calcularComissoesDaLive } from '../src/services/commission-engine.js'
import { liveGmvSql, liveOrdersSql } from '../src/lib/metric-sql.js'
import { resolveDbSslConfig } from '../src/utils/db-ssl.js'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveDbSslConfig(process.env.DATABASE_URL),
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
})

async function main() {
  console.log('[reprocessar-comissoes] buscando todas as lives encerradas')

  // Busca todas as lives com status='encerrada' (Fase 2 mudará isso para outro status)
  const lookup = await pool.connect()
  let targets
  try {
    const r = await lookup.query(
      `SELECT l.id,
              l.tenant_id,
              ${liveGmvSql('l')}      AS gmv,
              ${liveOrdersSql('l')}   AS pedidos
         FROM lives l
        WHERE l.status = 'encerrada'
        ORDER BY l.encerrado_em ASC NULLS LAST`,
    )
    targets = r.rows
  } finally {
    lookup.release()
  }

  console.log(`[reprocessar-comissoes] ${targets.length} lives para reprocessar`)

  let ok = 0
  const failIds = []

  for (const live of targets) {
    const client = await pool.connect()
    try {
      // BEGIN garante que set_config(..., true) (transaction-local) preserve o RLS
      // durante TODAS as queries do engine. Padrão do cron recalcular_comissoes.js:62-64
      // e de backfill_comissoes_unificacao.js:52-53.
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.tenant_id', $1::text, true)`, [live.tenant_id])
      await calcularComissoesDaLive(client, {
        liveId: live.id,
        tenantId: live.tenant_id,
        gmv: Number(live.gmv),
        pedidos: Number(live.pedidos),
      })
      await client.query('COMMIT')
      ok += 1
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      failIds.push(live.id)
      console.error(`[reprocessar-comissoes] FALHA live ${live.id}: ${err.message}`)
    } finally {
      client.release()
    }
  }

  console.log(`\nreprocessamento: ${ok} ok, ${failIds.length} falhas`)
  if (failIds.length > 0) {
    console.error('[reprocessar-comissoes] lives com falha:', failIds.join(', '))
  }

  await pool.end()
}

main().catch((err) => {
  console.error('[reprocessar-comissoes] FATAL:', err)
  process.exit(1)
})
