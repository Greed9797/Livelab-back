// Calendário de disponibilidade de apresentadoras (Feature F5)
//
// Endpoints:
//   GET    /v1/apresentadoras/:id/disponibilidade?data_inicio=&data_fim=
//   POST   /v1/apresentadoras/:id/disponibilidade/grade           (substitui grade inteira)
//   POST   /v1/apresentadoras/:id/disponibilidade/bloqueios
//   DELETE /v1/apresentadoras/:id/disponibilidade/bloqueios/:bloqueioId
//   GET    /v1/disponibilidade/check?apresentadora_id=&data=&hora_inicio=&hora_fim=
//
// Decisões (ver síntese do conselho):
//   1. Substituição da grade: BEGIN + DELETE + INSERT na MESMA conexão (atômico).
//      Reseta a grade limpando primeiro e gravando os slots novos.
//   2. Check de disponibilidade é 100% server-side. Front não replica regras.
//   3. Live agendada = lives onde a apresentadora está como titular
//      (lives.apresentador_id == apresentadoras.user_id) OU como extra
//      (live_apresentadores.apresentador_id == apresentadoras.user_id),
//      com status em ('em_andamento','aprovada' via live_requests).
//   4. Lock pessimista no resync via SELECT ... FOR UPDATE em nível de apresentadora
//      pra evitar duas escritas concorrentes da grade.

import { z } from 'zod'
import { READ_APRESENTADORAS, WRITE_APRESENTADORAS } from '../config/role_groups.js'

const slotSchema = z.object({
  dia_semana:  z.number().int().min(0).max(6),
  hora_inicio: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Formato HH:MM'),
  hora_fim:    z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Formato HH:MM'),
})

const gradeSchema = z.object({
  slots: z.array(slotSchema),
})

const bloqueioSchema = z.object({
  data_inicio: z.string().min(1),  // ISO 8601
  data_fim:    z.string().min(1),
  motivo:      z.string().optional(),
})

const checkQuerySchema = z.object({
  apresentadora_id: z.string().uuid(),
  data:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  hora_inicio: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'HH:MM'),
  hora_fim:    z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'HH:MM'),
})

const periodoQuerySchema = z.object({
  data_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(),
  data_fim:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(),
})

// Garante HH:MM:SS pra TIME do PG
function normalizeTime(t) {
  if (t.length === 5) return `${t}:00`
  return t
}

async function ensureApresentadoraExists(db, apresentadoraId) {
  const r = await db.query(
    `SELECT id, user_id FROM apresentadoras WHERE id = $1`,
    [apresentadoraId]
  )
  return r.rows[0] ?? null
}

export async function apresentadoraDisponibilidadeRoutes(app) {
  const readAccess  = [app.authenticate, app.requirePapel(READ_APRESENTADORAS)]
  const writeAccess = [app.authenticate, app.requirePapel(WRITE_APRESENTADORAS)]

  // ─── GET grade + bloqueios + lives agendadas no período ──────────────
  app.get('/v1/apresentadoras/:id/disponibilidade', { preHandler: readAccess }, async (request, reply) => {
    const parsed = periodoQuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const { id } = request.params

    // Default: próximas 4 semanas
    const dataInicio = parsed.data.data_inicio ?? new Date().toISOString().slice(0, 10)
    const dataFim    = parsed.data.data_fim ?? new Date(Date.now() + 28 * 86400_000).toISOString().slice(0, 10)

    return app.withTenant(tenant_id, async (db) => {
      const apr = await ensureApresentadoraExists(db, id)
      if (!apr) return reply.code(404).send({ error: 'Apresentadora não encontrada' })

      const grade = await db.query(
        `SELECT id, dia_semana, hora_inicio::text, hora_fim::text
           FROM apresentadora_disponibilidade
          WHERE apresentadora_id = $1
          ORDER BY dia_semana, hora_inicio`,
        [id]
      )

      const bloqueios = await db.query(
        `SELECT id, data_inicio, data_fim, motivo, criado_em
           FROM apresentadora_bloqueios
          WHERE apresentadora_id = $1
            AND data_fim >= $2::date
            AND data_inicio <= ($3::date + interval '1 day')
          ORDER BY data_inicio`,
        [id, dataInicio, dataFim]
      )

      // Lives agendadas: titular OU extra, status ativo, no período.
      // Quando user_id é null (apresentadora sem login) → sem lives.
      const lives = apr.user_id ? (await db.query(
        `SELECT DISTINCT l.id, l.iniciado_em AS data_inicio, l.encerrado_em AS data_fim,
                l.status, l.cabine_id
           FROM lives l
           LEFT JOIN live_apresentadores la ON la.live_id = l.id
          WHERE l.status IN ('em_andamento', 'agendada')
            AND (l.apresentador_id = $1 OR la.apresentador_id = $1)
            AND l.iniciado_em <= ($3::date + interval '1 day')
            AND COALESCE(l.encerrado_em, l.iniciado_em) >= $2::date
          ORDER BY l.iniciado_em`,
        [apr.user_id, dataInicio, dataFim]
      )).rows : []

      return {
        grade_semanal: grade.rows,
        bloqueios:     bloqueios.rows,
        lives_agendadas: lives,
        periodo: { data_inicio: dataInicio, data_fim: dataFim },
      }
    })
  })

  // ─── POST substitui grade inteira (transação atômica) ────────────────
  app.post('/v1/apresentadoras/:id/disponibilidade/grade', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = gradeSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const { id } = request.params
    const slots = parsed.data.slots

    // Valida hora_fim > hora_inicio em cada slot (defesa em profundidade — DB também checa)
    for (const s of slots) {
      if (normalizeTime(s.hora_fim) <= normalizeTime(s.hora_inicio)) {
        return reply.code(400).send({ error: `Slot inválido: hora_fim deve ser maior que hora_inicio (${s.hora_inicio}-${s.hora_fim})` })
      }
    }

    // Transação manual (sem withTenant) pra ter BEGIN/COMMIT explícitos.
    const client = await app.db.pool.connect()
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant_id])
      await client.query('BEGIN')

      // Lock na apresentadora pra evitar duas escritas concorrentes
      const apr = await client.query(
        `SELECT id FROM apresentadoras WHERE id = $1 FOR UPDATE`,
        [id]
      )
      if (!apr.rows[0]) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'Apresentadora não encontrada' })
      }

      await client.query(
        `DELETE FROM apresentadora_disponibilidade WHERE apresentadora_id = $1`,
        [id]
      )

      for (const s of slots) {
        await client.query(
          `INSERT INTO apresentadora_disponibilidade
             (tenant_id, apresentadora_id, dia_semana, hora_inicio, hora_fim)
           VALUES ($1, $2, $3, $4::time, $5::time)`,
          [tenant_id, id, s.dia_semana, normalizeTime(s.hora_inicio), normalizeTime(s.hora_fim)]
        )
      }

      await client.query('COMMIT')
      return reply.code(200).send({ ok: true, total: slots.length })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      request.log.error({ err }, 'Erro ao substituir grade')
      // UNIQUE violation → 409
      if (err.code === '23505') {
        return reply.code(409).send({ error: 'Slot duplicado (mesmo dia_semana + hora_inicio)' })
      }
      return reply.code(500).send({ error: 'Erro ao salvar grade' })
    } finally {
      client.release()
    }
  })

  // ─── POST adiciona bloqueio pontual ──────────────────────────────────
  app.post('/v1/apresentadoras/:id/disponibilidade/bloqueios', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = bloqueioSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id, sub: userId } = request.user
    const { id } = request.params
    const d = parsed.data

    if (new Date(d.data_fim) <= new Date(d.data_inicio)) {
      return reply.code(400).send({ error: 'data_fim deve ser maior que data_inicio' })
    }

    return app.withTenant(tenant_id, async (db) => {
      const apr = await ensureApresentadoraExists(db, id)
      if (!apr) return reply.code(404).send({ error: 'Apresentadora não encontrada' })

      const r = await db.query(
        `INSERT INTO apresentadora_bloqueios
           (tenant_id, apresentadora_id, data_inicio, data_fim, motivo, criado_por)
         VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6)
         RETURNING id, data_inicio, data_fim, motivo, criado_em`,
        [tenant_id, id, d.data_inicio, d.data_fim, d.motivo ?? null, userId ?? null]
      )
      return reply.code(201).send(r.rows[0])
    })
  })

  // ─── DELETE bloqueio ─────────────────────────────────────────────────
  app.delete('/v1/apresentadoras/:id/disponibilidade/bloqueios/:bloqueioId', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    const { id, bloqueioId } = request.params

    return app.withTenant(tenant_id, async (db) => {
      const r = await db.query(
        `DELETE FROM apresentadora_bloqueios
          WHERE id = $1 AND apresentadora_id = $2
          RETURNING id`,
        [bloqueioId, id]
      )
      if (!r.rows[0]) return reply.code(404).send({ error: 'Bloqueio não encontrado' })
      return reply.code(204).send()
    })
  })

  // ─── GET check de disponibilidade pontual (server-side) ──────────────
  app.get('/v1/disponibilidade/check', { preHandler: readAccess }, async (request, reply) => {
    const parsed = checkQuerySchema.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const { apresentadora_id, data, hora_inicio, hora_fim } = parsed.data

    if (normalizeTime(hora_fim) <= normalizeTime(hora_inicio)) {
      return reply.code(400).send({ error: 'hora_fim deve ser maior que hora_inicio' })
    }

    return app.withTenant(tenant_id, async (db) => {
      const apr = await ensureApresentadoraExists(db, apresentadora_id)
      if (!apr) return reply.code(404).send({ error: 'Apresentadora não encontrada' })

      // dia_semana: 0=domingo .. 6=sabado (PG: EXTRACT(DOW))
      // B6.3 — usar timezone BR para evitar bug de virada de dia em UTC
      const dowR = await db.query(
        `SELECT EXTRACT(DOW FROM ($1::date AT TIME ZONE 'America/Sao_Paulo'))::int AS dow`,
        [data]
      )
      const dow = dowR.rows[0].dow

      // 1) Está dentro de algum slot da grade?
      const slotR = await db.query(
        `SELECT 1
           FROM apresentadora_disponibilidade
          WHERE apresentadora_id = $1
            AND dia_semana = $2
            AND hora_inicio <= $3::time
            AND hora_fim   >= $4::time
          LIMIT 1`,
        [apresentadora_id, dow, normalizeTime(hora_inicio), normalizeTime(hora_fim)]
      )
      if (slotR.rows.length === 0) {
        return {
          disponivel: false,
          conflito: { tipo: 'fora_da_grade', detalhe: 'Horário fora da grade semanal cadastrada' },
        }
      }

      // 2) Há bloqueio pontual sobreposto? (tstzrange overlap)
      const blqR = await db.query(
        `SELECT id, motivo, data_inicio, data_fim
           FROM apresentadora_bloqueios
          WHERE apresentadora_id = $1
            AND tstzrange(data_inicio, data_fim, '[)') &&
                tstzrange(($2::date + $3::time)::timestamptz,
                          ($2::date + $4::time)::timestamptz, '[)')
          LIMIT 1`,
        [apresentadora_id, data, normalizeTime(hora_inicio), normalizeTime(hora_fim)]
      )
      if (blqR.rows.length > 0) {
        return {
          disponivel: false,
          conflito: {
            tipo: 'bloqueio_pontual',
            detalhe: blqR.rows[0].motivo ?? 'Bloqueio sem motivo informado',
            bloqueio_id: blqR.rows[0].id,
          },
        }
      }

      // 3) Há live ativa/agendada que conflita?
      // B6.1 — inclui lives 'em_andamento' E 'agendada' (status no DB) + lives aprovadas
      //         via live_requests (status='aprovada') para detectar conflitos futuros.
      // Considera lives sem encerrado_em como "em aberto" — usa interval 4h default.
      if (apr.user_id) {
        const liveR = await db.query(
          `SELECT DISTINCT l.id, l.status, l.iniciado_em, l.encerrado_em
             FROM lives l
             LEFT JOIN live_apresentadores la ON la.live_id = l.id
            WHERE l.status IN ('em_andamento', 'agendada')
              AND (l.apresentador_id = $1 OR la.apresentador_id = $1)
              AND tstzrange(
                    l.iniciado_em,
                    COALESCE(l.encerrado_em, l.iniciado_em + interval '4 hours'),
                    '[)'
                  ) &&
                  tstzrange(($2::date + $3::time)::timestamptz,
                            ($2::date + $4::time)::timestamptz, '[)')
           UNION
           SELECT DISTINCT lr.id, 'live_request_aprovada' AS status,
                  (lr.data_solicitada + lr.hora_inicio)::timestamptz AS iniciado_em,
                  (lr.data_solicitada + lr.hora_fim)::timestamptz    AS encerrado_em
             FROM live_requests lr
            WHERE lr.status = 'aprovada'
              AND lr.apresentadora_id = $1
              AND tstzrange(
                    (lr.data_solicitada + lr.hora_inicio)::timestamptz,
                    (lr.data_solicitada + lr.hora_fim)::timestamptz,
                    '[)'
                  ) &&
                  tstzrange(($2::date + $3::time)::timestamptz,
                            ($2::date + $4::time)::timestamptz, '[)')
            LIMIT 1`,
          [apr.user_id, data, normalizeTime(hora_inicio), normalizeTime(hora_fim)]
        )
        if (liveR.rows.length > 0) {
          return {
            disponivel: false,
            conflito: {
              tipo: 'live_agendada',
              detalhe: 'Apresentadora já está alocada em outra live neste horário',
              live_id: liveR.rows[0].id,
            },
          }
        }
      }

      return { disponivel: true, conflito: null }
    })
  })
}
