// Script one-off: recalcula vendas_atribuidas com comissao_apresentadora=0
// mas gmv>0. Causa: commission-engine só rodava em /v1/lives/:id/encerrar;
// vendas inseridas via webhook ou snapshot pós-encerramento ficavam zeradas.
//
// Uso:
//   railway run node scripts/recalcular_vendas_zeradas.js
//   railway run node scripts/recalcular_vendas_zeradas.js --mes=2026-05
//
// Idempotente: roda recalcularVendasAtribuidasApresentadora (já filtra
// status_aprovacao='pendente_aprovacao' — não toca vendas aprovadas).

import pg from 'pg'
import 'dotenv/config'
import { recalcularVendasAtribuidasApresentadora } from '../src/routes/vendas_atribuidas.js'

function parseMes(arg) {
  if (arg && /^--mes=\d{4}-\d{2}$/.test(arg)) return arg.slice(6)
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

const mes = parseMes(process.argv[2])
const [y, m] = mes.split('-').map(Number)
const inicio = `${y}-${String(m).padStart(2, '0')}-01`
const fimMes = new Date(y, m, 0).getDate()
const fim = `${y}-${String(m).padStart(2, '0')}-${String(fimMes).padStart(2, '0')}`

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

async function main() {
  console.log(`[recalc] Recalculando vendas zeradas no período ${inicio} a ${fim}`)

  const client = await pool.connect()
  let totalApresentadoras = 0
  let totalVendasAfetadas = 0

  try {
    const targets = await client.query(
      `SELECT DISTINCT va.tenant_id, va.apresentadora_id, a.nome
         FROM vendas_atribuidas va
         JOIN apresentadoras a ON a.id = va.apresentadora_id
        WHERE va.gmv > 0
          AND COALESCE(va.comissao_apresentadora, 0) = 0
          AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') = 'pendente_aprovacao'
          AND va.data >= $1::date
          AND va.data <= $2::date
        ORDER BY a.nome`,
      [inicio, fim],
    )

    console.log(`[recalc] ${targets.rows.length} apresentadoras com vendas zeradas`)

    for (const { tenant_id, apresentadora_id, nome } of targets.rows) {
      // Contexto RLS dentro de transação por apresentadora
      const apClient = await pool.connect()
      try {
        await apClient.query(`SELECT set_config('app.tenant_id', $1::text, true)`, [tenant_id])
        const res = await recalcularVendasAtribuidasApresentadora(apClient, {
          tenantId: tenant_id,
          apresentadoraId: apresentadora_id,
        })
        const updated = res?.updated ?? 0
        if (updated > 0) {
          console.log(`[recalc] ${nome.padEnd(30)} → ${updated} vendas atualizadas`)
          totalVendasAfetadas += updated
          totalApresentadoras += 1
        }
      } catch (err) {
        console.error(`[recalc] ERRO em ${nome}: ${err.message}`)
      } finally {
        apClient.release()
      }
    }
  } finally {
    client.release()
  }

  console.log(`\n[recalc] Finalizado: ${totalApresentadoras} apresentadoras, ${totalVendasAfetadas} vendas recalculadas.`)
  await pool.end()
}

main().catch((err) => {
  console.error('[recalc] FATAL:', err)
  process.exit(1)
})
