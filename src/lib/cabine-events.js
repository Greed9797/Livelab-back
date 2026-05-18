export function getRequestIp(request) {
  const forwardedFor = request.headers['x-forwarded-for']
  if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
    return forwardedFor.split(',')[0].trim()
  }

  return request.socket?.remoteAddress ?? null
}

export async function logCabineEvent(db, {
  tenantId,
  cabineId,
  contratoId = null,
  tipoEvento,
  actorUserId = null,
  actorPapel = null,
  ip = null,
  payload = {},
}) {
  await db.query(
    `INSERT INTO cabine_eventos (
      tenant_id,
      cabine_id,
      contrato_id,
      tipo_evento,
      actor_user_id,
      actor_papel,
      ip,
      payload_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      tenantId,
      cabineId,
      contratoId,
      tipoEvento,
      actorUserId,
      actorPapel,
      ip,
      JSON.stringify(payload),
    ]
  )
}
