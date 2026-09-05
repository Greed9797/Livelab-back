const SP_TIME_ZONE = 'America/Sao_Paulo'

export const CABINES_ACOMPANHAMENTO_SQL = `
  SELECT c.id, c.numero, c.nome, c.status, c.ativo
    FROM cabines c
   WHERE c.tenant_id = $1::uuid
     AND c.deleted_at IS NULL
   ORDER BY c.numero ASC`

export const AGENDA_ACOMPANHAMENTO_SQL = `
  SELECT ae.id, ae.cabine_id, ae.tipo, ae.status, ae.marca_id,
         ae.apresentadora_id, ae.data_inicio, ae.data_fim, ae.live_id,
         ae.observacoes, m.nome AS marca_nome, a.nome AS apresentadora_nome
    FROM agenda_eventos ae
    LEFT JOIN marcas m
      ON m.id = ae.marca_id AND m.tenant_id = ae.tenant_id
    LEFT JOIN apresentadoras a
      ON a.id = ae.apresentadora_id AND a.tenant_id = ae.tenant_id
   WHERE ae.tenant_id = $1::uuid
     AND ae.data_inicio < $3::timestamptz
     AND ae.data_fim > $2::timestamptz
   ORDER BY ae.data_inicio ASC, ae.id ASC`

export const LIVES_ACOMPANHAMENTO_SQL = `
  SELECT l.id, l.cabine_id, l.status, l.marca_id, l.agenda_evento_id,
         l.iniciado_em, l.encerrado_em,
         CASE
           WHEN l.encerrado_em > l.iniciado_em THEN l.encerrado_em
           WHEN l.status = 'em_andamento' THEN GREATEST(l.iniciado_em, LEAST(NOW(), $3::timestamptz))
           ELSE l.iniciado_em
         END AS fim_real,
         m.nome AS marca_nome
    FROM lives l
    LEFT JOIN marcas m
      ON m.id = l.marca_id AND m.tenant_id = l.tenant_id
   WHERE l.tenant_id = $1::uuid
     AND (
       (
         l.iniciado_em < $3::timestamptz
         AND (
           (l.status = 'cancelada' AND l.iniciado_em >= $2::timestamptz)
           OR (
             l.status <> 'cancelada'
             AND COALESCE(
               CASE WHEN l.encerrado_em > l.iniciado_em THEN l.encerrado_em END,
               CASE WHEN l.status = 'em_andamento' THEN NOW() END,
               l.iniciado_em
             ) > $2::timestamptz
           )
         )
       )
       OR EXISTS (
         SELECT 1
           FROM agenda_eventos linked
          WHERE linked.tenant_id = l.tenant_id
            AND (linked.id = l.agenda_evento_id OR linked.live_id = l.id)
            AND linked.data_inicio < $3::timestamptz
            AND linked.data_fim > $2::timestamptz
       )
     )
   ORDER BY l.iniciado_em ASC, l.id ASC`

function iso(value) {
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) return null
  return new Date(value).toISOString()
}

function utcForZonedMidnight(data) {
  const [year, month, day] = data.split('-').map(Number)
  const desired = Date.UTC(year, month - 1, day, 0, 0, 0)
  let instant = desired
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: SP_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]))
    const representedAsUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second),
    )
    instant += desired - representedAsUtc
  }
  return new Date(instant)
}

function nextDate(data) {
  const date = new Date(`${data}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

export function saoPauloDayBounds(data) {
  return {
    start: utcForZonedMidnight(data).toISOString(),
    end: utcForZonedMidnight(nextDate(data)).toISOString(),
  }
}

export function intervalUnionMinutes(intervals, dayStart, dayEnd) {
  const startLimit = new Date(dayStart).getTime()
  const endLimit = new Date(dayEnd).getTime()
  const clipped = intervals
    .map(([start, end]) => [new Date(start).getTime(), new Date(end).getTime()])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .map(([start, end]) => [Math.max(start, startLimit), Math.min(end, endLimit)])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0])

  let total = 0
  let current = null
  for (const interval of clipped) {
    if (!current || interval[0] > current[1]) {
      if (current) total += current[1] - current[0]
      current = [...interval]
    } else {
      current[1] = Math.max(current[1], interval[1])
    }
  }
  if (current) total += current[1] - current[0]
  return Math.round(total / 60_000)
}

function liveInterval(live) {
  const start = iso(live.iniciado_em)
  const end = iso(live.fim_real ?? live.encerrado_em)
  return start && end && end > start ? [start, end] : null
}

function overlaps(evento, live) {
  const liveRange = liveInterval(live)
  const eventStart = iso(evento.data_inicio)
  const eventEnd = iso(evento.data_fim)
  if (!liveRange || !eventStart || !eventEnd) return false
  return liveRange[0] < eventEnd && liveRange[1] > eventStart
}

function isDirectLink(evento, live) {
  return live.agenda_evento_id === evento.id || evento.live_id === live.id
}

function isCandidate(evento, live) {
  if (evento.tipo !== 'live' || evento.status === 'cancelado') return false
  if (!evento.cabine_id || evento.cabine_id !== live.cabine_id) return false
  if (evento.marca_id && live.marca_id && evento.marca_id !== live.marca_id) return false
  return overlaps(evento, live)
}

function actualMinutes(lives, dayStart, dayEnd) {
  return intervalUnionMinutes(lives.map(liveInterval).filter(Boolean), dayStart, dayEnd)
}

function planejamentoPayload(evento, directLives, candidateLives, dayStart, dayEnd, now) {
  let situacao = 'registro_pendente'
  let cancelamento_origem = null
  if (evento.status === 'cancelado') {
    situacao = 'cancelada'
    cancelamento_origem = 'agenda'
  } else if (evento.tipo === 'bloqueio_manutencao') {
    situacao = 'manutencao'
  } else if (directLives.length > 0) {
    if (directLives.some((live) => live.status === 'em_andamento')) situacao = 'em_andamento'
    else if (directLives.some((live) => ['encerrada', 'faturada'].includes(live.status))) situacao = 'realizada'
    else if (directLives.every((live) => live.status === 'cancelada')) {
      situacao = 'cancelada'
      cancelamento_origem = 'execucao'
    }
  } else if (candidateLives.length > 0) {
    situacao = 'vinculacao_pendente'
  } else {
    const inicio = new Date(evento.data_inicio).getTime()
    const fim = new Date(evento.data_fim).getTime()
    const current = new Date(now).getTime()
    if (Number.isFinite(inicio) && inicio > current) situacao = 'planejada'
    else if (Number.isFinite(fim) && fim <= current) situacao = 'sem_execucao_vinculada'
  }

  return {
    id: evento.id,
    tipo: evento.tipo,
    status_agenda: evento.status,
    situacao,
    cancelamento_origem,
    marca_id: evento.marca_id ?? null,
    marca_nome: evento.marca_nome ?? null,
    apresentadora_id: evento.apresentadora_id ?? null,
    apresentadora_nome: evento.apresentadora_nome ?? null,
    data_inicio: iso(evento.data_inicio),
    data_fim: iso(evento.data_fim),
    observacoes: evento.observacoes ?? null,
    live_ids: directLives.map((live) => live.id),
    live_candidata_ids: candidateLives.map((live) => live.id),
    minutos_reais: actualMinutes(directLives, dayStart, dayEnd),
  }
}

function execucaoPayload(live, candidateEvents, dayStart, dayEnd) {
  return {
    id: live.id,
    situacao: live.status === 'cancelada' ? 'cancelada' : candidateEvents.length > 0 ? 'vinculacao_pendente' : 'sem_reserva',
    status_live: live.status,
    marca_id: live.marca_id ?? null,
    marca_nome: live.marca_nome ?? null,
    iniciado_em: iso(live.iniciado_em),
    encerrado_em: iso(live.fim_real ?? live.encerrado_em),
    agenda_candidata_ids: candidateEvents.map((evento) => evento.id),
    minutos_reais: actualMinutes([live], dayStart, dayEnd),
  }
}

function buildCabine(cabine, agenda, lives, dayStart, dayEnd, allAgenda = agenda, allLives = lives, gradeCells = [], now = new Date().toISOString()) {
  const directLiveIds = new Set(allAgenda.flatMap((evento) => allLives.filter((live) => isDirectLink(evento, live)).map((live) => live.id)))
  const planejamentos = agenda.map((evento) => {
    // IDs explícitos prevalecem inclusive quando existe divergência de cabine.
    // A duração física continua contada na cabine registrada na execução.
    const directLives = allLives.filter((live) => isDirectLink(evento, live))
    const candidates = directLives.length === 0
      ? lives.filter((live) => !directLiveIds.has(live.id) && isCandidate(evento, live))
      : []
    return planejamentoPayload(evento, directLives, candidates, dayStart, dayEnd, now)
  })
  const execucoesSemReserva = lives
    .filter((live) => !directLiveIds.has(live.id))
    .map((live) => execucaoPayload(live, agenda.filter((evento) => isCandidate(evento, live)), dayStart, dayEnd))

  return {
    id: cabine?.id ?? null,
    numero: cabine?.numero ?? null,
    nome: cabine?.nome ?? null,
    ativo: cabine?.ativo ?? null,
    status_fisico: cabine?.status ?? 'desconhecida',
    sem_reserva: planejamentos.every((item) => item.situacao === 'cancelada'),
    programacao_grade: gradeCells,
    minutos_reais: actualMinutes(lives.filter((live) => live.status !== 'cancelada'), dayStart, dayEnd),
    planejamentos,
    execucoes_sem_reserva: execucoesSemReserva,
  }
}

export function buildAcompanhamento({ data, dayStart, dayEnd, cabines, agenda, lives, gradeCells = [], now = new Date().toISOString() }) {
  const knownIds = new Set(cabines.map((cabine) => cabine.id))
  const responseCabines = cabines.map((cabine) => buildCabine(
    cabine,
    agenda.filter((evento) => evento.cabine_id === cabine.id),
    lives.filter((live) => live.cabine_id === cabine.id),
    dayStart,
    dayEnd,
    agenda,
    lives,
    gradeCells.filter((celula) => celula.cabine_id === cabine.id),
    now,
  ))
  const unknownAgenda = agenda.filter((evento) => !evento.cabine_id || !knownIds.has(evento.cabine_id))
  const unknownLives = lives.filter((live) => !live.cabine_id || !knownIds.has(live.cabine_id))

  return {
    data,
    timezone: SP_TIME_ZONE,
    cabines: responseCabines,
    cabine_desconhecida: buildCabine(
      null, unknownAgenda, unknownLives, dayStart, dayEnd, agenda, lives,
      gradeCells.filter((celula) => !celula.cabine_id || !knownIds.has(celula.cabine_id)),
      now,
    ),
  }
}

export async function carregarAcompanhamento(db, tenantId, data) {
  const { start, end } = saoPauloDayBounds(data)
  const params = [tenantId, start, end]
  const [cabinesQ, agendaQ, livesQ] = await Promise.all([
    db.query(CABINES_ACOMPANHAMENTO_SQL, [tenantId]),
    db.query(AGENDA_ACOMPANHAMENTO_SQL, params),
    db.query(LIVES_ACOMPANHAMENTO_SQL, params),
  ])
  return buildAcompanhamento({
    data,
    dayStart: start,
    dayEnd: end,
    cabines: cabinesQ.rows,
    agenda: agendaQ.rows,
    lives: livesQ.rows,
  })
}
