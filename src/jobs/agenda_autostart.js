// Job: auto-start de agenda planejada quando bate o horário.
//
// Contexto: agenda_eventos (tipo='live', status='planejado') ficavam paradas
// indefinidamente — não havia processo que transicionasse pra 'ao_vivo'.
// Lucas reportou cabine com agenda 08-14 que não iniciou sozinha.
//
// Estratégia: a cada 30s, varre eventos vencidos (NOW dentro do slot,
// live_id IS NULL), pra cada um:
//   1) SELECT FOR UPDATE no agenda_eventos (lock pessimista vs clique manual)
//   2) Re-check live_id IS NULL dentro da transação
//   3) INSERT lives (status_publicacao='rascunho', origem_dados='api')
//   4) UPDATE agenda_eventos status='ao_vivo', live_id
//   5) UPDATE cabines status='ao_vivo', live_atual_id
//   6) Audit log
//
// Janela de tolerância: ignora eventos com data_inicio < NOW() - 1h
// (não auto-start agenda esquecida há horas — só warning no log).
//
// TikTok connector é pego automaticamente por connectorManager.syncLives()
// (server.js:88) que roda a cada 60s.

import { withAdvisoryLock } from './advisory_lock.js'
import { scanPorTenant } from './tenant_scan.js'

const AUTOSTART_INTERVAL_MS = 30_000
const STALE_THRESHOLD_MINUTES = 60
const LOCK_KEY = 7421900119911238n

let _running = false

export async function runAgendaAutostartTick(app) {
  if (_running) {
    app.log?.warn?.('[agenda autostart] tick anterior em andamento, pulando')
    return { skipped: true }
  }
  _running = true
  const results = { started: 0, skipped: 0, stale: 0, errors: 0 }

  try {
    // Busca eventos candidatos tenant a tenant, cada varredura com seu contexto
    // RLS (ver src/jobs/tenant_scan.js). Um SELECT cross-tenant via app.db
    // devolveria zero linhas assim que a RLS for aplicada, em silêncio.
    // LIMIT abaixo é POR TENANT.
    const candidates = await scanPorTenant(
      app,
      `SELECT id, tenant_id, cabine_id, marca_id, apresentadora_id,
              data_inicio, data_fim,
              EXTRACT(EPOCH FROM (NOW() - data_inicio)) / 60 AS minutos_atraso
         FROM agenda_eventos
        WHERE tipo = 'live'
          AND status = 'planejado'
          AND live_id IS NULL
          AND data_inicio <= NOW()
          AND data_fim > NOW()
        ORDER BY data_inicio ASC
        LIMIT 50`,
      [],
      '[agenda autostart]',
    )

    for (const ev of candidates) {
      if (Number(ev.minutos_atraso) > STALE_THRESHOLD_MINUTES) {
        app.log?.warn?.({
          agenda_evento_id: ev.id,
          minutos_atraso: Number(ev.minutos_atraso).toFixed(0),
        }, '[agenda autostart] evento stale (>1h atraso) — pulando, requer ação manual')
        results.stale += 1
        continue
      }

      try {
        const r = await startOneEvent(app, ev)
        if (r?.liveId) results.started += 1
        else results.skipped += 1
      } catch (err) {
        results.errors += 1
        app.log?.error?.({ err, agenda_evento_id: ev.id, cabine_id: ev.cabine_id },
          '[agenda autostart] falha ao iniciar evento')
      }
    }
  } catch (err) {
    app.log?.error?.({ err }, '[agenda autostart] tick falhou')
    results.errors += 1
  } finally {
    _running = false
  }

  if (results.started > 0 || results.errors > 0 || results.stale > 0) {
    app.log?.info?.({ ...results }, '[agenda autostart] tick concluído')
  }
  return results
}

async function startOneEvent(app, ev) {
  const client = await app.db.pool.connect()
  try {
    await client.query('BEGIN')
    // Tenant context pra RLS dentro da transação (cabines + lives + agenda_eventos).
    await client.query(`SELECT set_config('app.tenant_id', $1::text, true)`, [ev.tenant_id])

    // Re-check com lock pessimista contra race com POST /v1/lives manual.
    const lockQ = await client.query(
      `SELECT id, live_id, cabine_id, marca_id, apresentadora_id, data_fim
         FROM agenda_eventos
        WHERE id = $1::uuid AND tenant_id = $2::uuid
        FOR UPDATE`,
      [ev.id, ev.tenant_id],
    )
    const locked = lockQ.rows[0]
    if (!locked || locked.live_id) {
      await client.query('ROLLBACK')
      return { skipped: true }
    }

    // Cabine deve existir, ativa, e não estar em outra live em_andamento.
    const cabQ = await client.query(
      `SELECT id, status, ativo, live_atual_id, contrato_id
         FROM cabines
        WHERE id = $1::uuid AND tenant_id = $2::uuid
        FOR UPDATE`,
      [locked.cabine_id, ev.tenant_id],
    )
    const cab = cabQ.rows[0]
    if (!cab || cab.ativo === false) {
      await client.query('ROLLBACK')
      app.log?.warn?.({ agenda_evento_id: ev.id, cabine_id: locked.cabine_id },
        '[agenda autostart] cabine inativa ou inexistente, pulando')
      return { skipped: true }
    }
    if (cab.live_atual_id) {
      // Já tem live ativa nessa cabine — não substituir, deixar humano resolver.
      await client.query('ROLLBACK')
      app.log?.warn?.({ agenda_evento_id: ev.id, cabine_id: cab.id, live_atual_id: cab.live_atual_id },
        '[agenda autostart] cabine já tem live ativa, pulando')
      return { skipped: true }
    }

    // Resolve marca → cliente_id e apresentador_user_id (apresentadora.user_id).
    let clienteId = null
    if (locked.marca_id) {
      const mQ = await client.query(
        `SELECT cliente_id FROM marcas WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [locked.marca_id, ev.tenant_id],
      )
      clienteId = mQ.rows[0]?.cliente_id ?? null
    }

    if (!locked.marca_id) {
      await client.query('ROLLBACK')
      app.log?.warn?.({ agenda_evento_id: ev.id, cabine_id: cab.id },
        '[agenda autostart] evento de live sem marca — live NÃO criada (marca obrigatória)')
      return { skipped: true, reason: 'sem_marca' }
    }

    let apresentadorUserId = null
    if (locked.apresentadora_id) {
      const apQ = await client.query(
        `SELECT user_id FROM apresentadoras WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [locked.apresentadora_id, ev.tenant_id],
      )
      apresentadorUserId = apQ.rows[0]?.user_id ?? null
    }

    const liveQ = await client.query(
      `INSERT INTO lives
        (tenant_id, cabine_id, cliente_id, apresentador_id, tipo,
         status_publicacao, origem_dados, agenda_evento_id, previsto_fim, marca_id)
       -- origem_dados só aceita 'manual'|'api' (lives_origem_dados_check). Gravar
       -- 'auto_agenda' fazia TODO insert deste job falhar em silêncio — nenhuma live
       -- chegou a ser aberta automaticamente. Quem veio da agenda já é identificável
       -- por agenda_evento_id IS NOT NULL, então 'api' basta.
       -- tipo só aceita 'cliente'|'afiliado'|'teste' (lives_tipo_check); 'live' não
       -- existe e derrubava o insert junto com origem_dados.
       VALUES ($1::uuid, $2::uuid, $3, $4, 'cliente',
               'rascunho', 'api', $5::uuid, $6::timestamptz, $7)
       RETURNING id`,
      [
        ev.tenant_id,
        locked.cabine_id,
        clienteId,
        apresentadorUserId,
        locked.id,
        locked.data_fim,
        locked.marca_id,
      ],
    )
    const liveId = liveQ.rows[0].id

    await client.query(
      `UPDATE agenda_eventos
          SET status = 'ao_vivo', live_id = $1::uuid, atualizado_em = NOW()
        WHERE id = $2::uuid AND tenant_id = $3::uuid`,
      [liveId, locked.id, ev.tenant_id],
    )

    if (locked.apresentadora_id) {
      await client.query(
        `INSERT INTO live_apresentadoras_v2 (tenant_id, live_id, apresentadora_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid)
           ON CONFLICT (live_id, apresentadora_id) DO NOTHING`,
        [ev.tenant_id, liveId, locked.apresentadora_id],
      )
    }

    await client.query(
      `UPDATE cabines
          SET status = 'ao_vivo', live_atual_id = $1::uuid
        WHERE id = $2::uuid AND tenant_id = $3::uuid`,
      [liveId, locked.cabine_id, ev.tenant_id],
    )

    // Audit log (best effort — não bloqueia se tabela ausente).
    try {
      await client.query(
        // audit_log usa user_id (actor_user_id é de cabine_eventos/contrato_eventos).
        // Com o nome errado o INSERT falhava e abortava a transação inteira, revertendo
        // a live que o job acabara de abrir.
        `INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, metadata)
           VALUES ($1::uuid, NULL, 'live.iniciada_auto', 'lives', $2::uuid, $3::jsonb)`,
        [ev.tenant_id, liveId, JSON.stringify({ agenda_evento_id: locked.id, source: 'agenda_autostart' })],
      )
    } catch (auditErr) {
      app.log?.warn?.({ err: auditErr }, '[agenda autostart] audit_log falhou (não-bloqueante)')
    }

    await client.query('COMMIT')
    app.log?.info?.({
      agenda_evento_id: locked.id,
      live_id: liveId,
      cabine_id: locked.cabine_id,
    }, '[agenda autostart] live iniciada automaticamente')
    return { liveId }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export function startAgendaAutostart(app, cron) {
  cron.schedule('*/30 * * * * *', async () => {
    // Advisory lock além da flag _running: com 2 réplicas a flag não vê a outra.
    // O try/catch não é decorativo: o pool.connect() dentro de withAdvisoryLock fica
    // fora do try dele, então quando o pool está esgotado a rejeição sai daqui. O
    // node-cron a engole no console e ela nunca chega no pino nem no Sentry — o tick
    // some sem deixar rastro. Pior neste job: STALE_THRESHOLD_MINUTES é 60, então uma
    // indisponibilidade de pool maior que 1h deixa dano permanente na agenda (evento
    // vira stale e passa a ser pulado de vez).
    try {
      await withAdvisoryLock(app.db.pool, LOCK_KEY, '[agenda autostart]', app.log, () =>
        runAgendaAutostartTick(app))
    } catch (err) {
      app.log?.error?.({ err }, '[agenda autostart] tick falhou')
    }
  })
  app.log?.info?.({ interval_ms: AUTOSTART_INTERVAL_MS },
    '[agenda autostart] cron registrado (cada 30s)')
}
