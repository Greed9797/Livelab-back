function liveStatusToAgendaStatus(status) {
  if (status === 'encerrada') return 'concluido'
  if (status === 'cancelada') return 'cancelado'
  if (status === 'em_andamento') return 'ao_vivo'
  return 'planejado'
}

function safeAgendaEnd(dataInicio, dataFim) {
  const inicio = new Date(dataInicio)
  const fim = dataFim ? new Date(dataFim) : null
  if (!Number.isNaN(inicio.getTime()) && fim && !Number.isNaN(fim.getTime()) && fim > inicio) return dataFim
  return new Date(inicio.getTime() + 4 * 60 * 60 * 1000).toISOString()
}


export async function syncAgendaEventForLive(db, {
  tenantId,
  liveId,
  agendaEventoId,
  cabineId,
  marcaId,
  apresentadoraId,
  dataInicio,
  dataFim,
  status,
  observacoes,
  criadoPor,
}) {
  if (!tenantId || !liveId || !marcaId || !dataInicio) return null

  const agendaStatus = liveStatusToAgendaStatus(status)
  const agendaFim = safeAgendaEnd(dataInicio, dataFim)
  let eventId = agendaEventoId ?? null

  if (!eventId) {
    const existing = await db.query(
      `SELECT ae.id
       FROM agenda_eventos ae
       WHERE ae.tenant_id = $1::uuid
         AND ae.tipo = 'live'
         AND ae.status <> 'cancelado'
         AND (
           ae.live_id = $2::uuid
           OR (
             ae.live_id IS NULL
             AND ae.marca_id = $3::uuid
             AND ae.cabine_id IS NOT DISTINCT FROM $4::uuid
             AND ae.data_inicio < $6::timestamptz
             AND ae.data_fim > $5::timestamptz
           )
         )
       ORDER BY (ae.live_id = $2::uuid) DESC,
                ABS(EXTRACT(EPOCH FROM (ae.data_inicio - $5::timestamptz)))
       LIMIT 1`,
      [tenantId, liveId, marcaId, cabineId ?? null, dataInicio, agendaFim],
    )
    eventId = existing.rows[0]?.id ?? null
  }

  if (eventId) {
    const updated = await db.query(
      `UPDATE agenda_eventos
       SET tipo = 'live',
           marca_id = $3::uuid,
           cabine_id = $4::uuid,
           -- O sync roda em QUALQUER patch de live com marca e só conhece a apresentadora
           -- escalar. Com turnos gravados, sobrescrever o espelho achataria o revezamento
           -- em uma pessoa só; quem manda no espelho é PUT /v1/agenda/:id/apresentadoras.
           apresentadora_id = CASE
             WHEN EXISTS (SELECT 1 FROM agenda_evento_apresentadoras aea
                           WHERE aea.agenda_evento_id = agenda_eventos.id)
             THEN agenda_eventos.apresentadora_id
             ELSE $5::uuid
           END,
           data_inicio = $6::timestamptz,
           data_fim = $7::timestamptz,
           status = $8,
           live_id = $9::uuid,
           observacoes = COALESCE(NULLIF(observacoes, ''), $10),
           atualizado_em = NOW()
       WHERE id = $1::uuid
         AND tenant_id = $2::uuid
       RETURNING id`,
      [
        eventId,
        tenantId,
        marcaId,
        cabineId ?? null,
        apresentadoraId ?? null,
        dataInicio,
        agendaFim,
        agendaStatus,
        liveId,
        observacoes ?? 'Live sincronizada automaticamente pelo registro operacional.',
      ],
    )
    eventId = updated.rows[0]?.id ?? eventId
  } else {
    const inserted = await db.query(
      `INSERT INTO agenda_eventos (
         tenant_id, tipo, marca_id, cabine_id, apresentadora_id, data_inicio, data_fim,
         status, live_id, observacoes, criado_por
       )
       VALUES ($1,'live',$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        tenantId,
        marcaId,
        cabineId ?? null,
        apresentadoraId ?? null,
        dataInicio,
        agendaFim,
        agendaStatus,
        liveId,
        observacoes ?? 'Live criada automaticamente a partir do registro operacional.',
        criadoPor ?? null,
      ],
    )
    eventId = inserted.rows[0]?.id ?? null
  }

  if (eventId) {
    await db.query(
      `UPDATE lives
       SET agenda_evento_id = $1::uuid
       WHERE id = $2::uuid
         AND tenant_id = $3::uuid
         AND agenda_evento_id IS DISTINCT FROM $1::uuid`,
      [eventId, liveId, tenantId],
    )
  }

  return eventId
}
