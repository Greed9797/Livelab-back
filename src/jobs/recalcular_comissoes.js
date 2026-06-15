// Job: recalcula a cada 10min vendas_atribuidas com comissao_apresentadora=0
// mas gmv>0 no mês corrente. Mitiga gap onde commission-engine só roda em
// /v1/lives/:id/encerrar — vendas via webhook ou snapshot pós-encerramento
// ficavam zeradas indefinidamente.
//
// Reusa recalcularVendasAtribuidasApresentadora (src/routes/vendas_atribuidas.js)
// que filtra status_aprovacao='pendente_aprovacao' — não toca aprovadas.

import { recalcularVendasAtribuidasApresentadora } from '../routes/vendas_atribuidas.js'
import { calcularComissoesDaLive } from '../services/commission-engine.js'

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
        // set_config(..., true) é transaction-local; sem BEGIN a GUC reverte
        // antes do recalc e o contexto RLS é descartado. Envolver em transação
        // (padrão de encerrar_lives_zumbi.js) garante o tenant_id sob RLS.
        await client.query('BEGIN')
        await client.query(`SELECT set_config('app.tenant_id', $1::text, true)`, [tenant_id])
        const res = await recalcularVendasAtribuidasApresentadora(client, {
          tenantId: tenant_id,
          apresentadoraId: apresentadora_id,
        })
        await client.query('COMMIT')
        const updated = res?.updated ?? 0
        if (updated > 0) {
          results.vendas += updated
          results.apresentadoras += 1
          seenTenants.add(tenant_id)
        }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        results.errors += 1
        app.log?.warn?.({ err, tenant_id, apresentadora_id },
          '[recalc comissoes] falha em apresentadora')
      } finally {
        client.release()
      }
    }
    results.tenants = seenTenants.size

    // Etapa 2: lives publicadas órfãs (sem vendas_atribuidas).
    // Cobre lives publicadas antes do fix em lives.js PATCH publicar.
    try {
      const livesOrfas = await app.db.query(
        `SELECT l.id, l.tenant_id, l.marca_id,
                COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) AS gmv
           FROM lives l
          WHERE l.status_publicacao = 'publicado'
            AND l.marca_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM vendas_atribuidas va
               WHERE va.origem = 'live' AND va.origem_id = l.id
            )
          LIMIT 50`,
      )
      for (const live of livesOrfas.rows) {
        const lc = await app.db.pool.connect()
        try {
          // Mesma transação local para preservar o contexto RLS (ver acima).
          await lc.query('BEGIN')
          await lc.query(`SELECT set_config('app.tenant_id', $1::text, true)`, [live.tenant_id])
          const r = await calcularComissoesDaLive(lc, {
            liveId: live.id,
            tenantId: live.tenant_id,
            gmv: Number(live.gmv),
          })
          await lc.query('COMMIT')
          if (Array.isArray(r) && r.length > 0) {
            results.livesOrfasProcessadas = (results.livesOrfasProcessadas ?? 0) + 1
            results.vendas += r.length
          }
        } catch (err) {
          await lc.query('ROLLBACK').catch(() => {})
          results.errors += 1
          app.log?.warn?.({ err, liveId: live.id }, '[recalc comissoes] live orfã falhou')
        } finally {
          lc.release()
        }
      }
    } catch (err) {
      app.log?.warn?.({ err }, '[recalc comissoes] varredura lives orfãs falhou')
    }

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
