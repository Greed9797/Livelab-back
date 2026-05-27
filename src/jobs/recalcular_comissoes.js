// Job: recalcula a cada 10min vendas_atribuidas com comissao_apresentadora=0
// mas gmv>0 no mês corrente. Mitiga gap onde commission-engine só roda em
// /v1/lives/:id/encerrar — vendas via webhook ou snapshot pós-encerramento
// ficavam zeradas indefinidamente.
//
// Reusa recalcularVendasAtribuidasApresentadora (src/routes/vendas_atribuidas.js)
// que filtra status_aprovacao='pendente_aprovacao' — não toca aprovadas.

import { recalcularVendasAtribuidasApresentadora } from '../routes/vendas_atribuidas.js'

const TICK_CRON = '*/10 * * * *' // a cada 10 minutos

let _running = false

function currentMonthRange() {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  const mm = String(m).padStart(2, '0')
  const fimMes = new Date(y, m, 0).getDate()
  return {
    inicio: `${y}-${mm}-01`,
    fim: `${y}-${mm}-${String(fimMes).padStart(2, '0')}`,
  }
}

export async function runRecalcularComissoesTick(app) {
  if (_running) {
    app.log?.warn?.('[recalc comissoes] tick anterior em andamento, pulando')
    return { skipped: true }
  }
  _running = true
  const results = { tenants: 0, apresentadoras: 0, vendas: 0, errors: 0 }

  try {
    const { inicio, fim } = currentMonthRange()

    const targets = await app.db.query(
      `SELECT DISTINCT va.tenant_id, va.apresentadora_id
         FROM vendas_atribuidas va
        WHERE va.gmv > 0
          AND COALESCE(va.comissao_apresentadora, 0) = 0
          AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') = 'pendente_aprovacao'
          AND va.data >= $1::date
          AND va.data <= $2::date
        LIMIT 200`,
      [inicio, fim],
    )

    if (targets.rows.length === 0) {
      _running = false
      return results
    }

    const seenTenants = new Set()
    for (const { tenant_id, apresentadora_id } of targets.rows) {
      const client = await app.db.pool.connect()
      try {
        await client.query(`SELECT set_config('app.tenant_id', $1::text, true)`, [tenant_id])
        const res = await recalcularVendasAtribuidasApresentadora(client, {
          tenantId: tenant_id,
          apresentadoraId: apresentadora_id,
        })
        const updated = res?.updated ?? 0
        if (updated > 0) {
          results.vendas += updated
          results.apresentadoras += 1
          seenTenants.add(tenant_id)
        }
      } catch (err) {
        results.errors += 1
        app.log?.warn?.({ err, tenant_id, apresentadora_id },
          '[recalc comissoes] falha em apresentadora')
      } finally {
        client.release()
      }
    }
    results.tenants = seenTenants.size

    if (results.vendas > 0 || results.errors > 0) {
      app.log?.info?.({ ...results }, '[recalc comissoes] tick concluído')
    }
  } catch (err) {
    app.log?.error?.({ err }, '[recalc comissoes] tick falhou')
    results.errors += 1
  } finally {
    _running = false
  }
  return results
}

export function startRecalcularComissoes(app, cron) {
  cron.schedule(TICK_CRON, async () => {
    await runRecalcularComissoesTick(app)
  })
  app.log?.info?.({ schedule: TICK_CRON }, '[recalc comissoes] cron registrado (10min)')
}
