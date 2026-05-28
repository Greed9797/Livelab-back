// Script one-off: roda commission-engine para lives status_publicacao='publicado'
// que não têm vendas_atribuidas. Causa: PATCH publicar antigo não chamava engine
// (fix em src/routes/lives.js do mesmo commit).
//
// Uso:
//   railway run node scripts/recalcular_lives_publicadas.js
//
// Idempotente: engine usa ON CONFLICT em vendas_atribuidas.

import pg from 'pg'
import 'dotenv/config'
import { calcularComissoesDaLive } from '../src/services/commission-engine.js'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

async function main() {
  console.log('[recalc-lives] Buscando lives publicadas sem vendas_atribuidas')

  const lookup = await pool.connect()
  let targets
  try {
    const r = await lookup.query(
      `SELECT l.id, l.tenant_id, l.marca_id,
              COALESCE(l.manual_gmv, l.fat_gerado, 0) AS gmv
         FROM lives l
        WHERE l.status_publicacao = 'publicado'
          AND l.marca_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM vendas_atribuidas va
             WHERE va.origem = 'live' AND va.origem_id = l.id
          )
        ORDER BY l.criado_em DESC
        LIMIT 500`,
    )
    targets = r.rows
  } finally {
    lookup.release()
  }

  console.log(`[recalc-lives] ${targets.length} lives candidatas`)

  let success = 0
  let semApresentadoras = 0
  let errors = 0

  for (const live of targets) {
    const client = await pool.connect()
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1::text, true)`, [live.tenant_id])
      const result = await calcularComissoesDaLive(client, {
        liveId: live.id,
        tenantId: live.tenant_id,
        gmv: Number(live.gmv),
      })
      if (Array.isArray(result) && result.length > 0) {
        console.log(`[recalc-lives] ${live.id} → ${result.length} vendas geradas (gmv R$${live.gmv})`)
        success += 1
      } else {
        semApresentadoras += 1
      }
    } catch (err) {
      errors += 1
      console.error(`[recalc-lives] ERRO live ${live.id}: ${err.message}`)
    } finally {
      client.release()
    }
  }

  console.log(`\n[recalc-lives] Concluído: ${success} processadas, ${semApresentadoras} sem apresentadoras, ${errors} erros.`)
  await pool.end()
}

main().catch((err) => {
  console.error('[recalc-lives] FATAL:', err)
  process.exit(1)
})
