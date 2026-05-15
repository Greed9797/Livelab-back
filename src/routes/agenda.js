import { z } from 'zod'
import { READ_AGENDA, WRITE_AGENDA } from '../config/role_groups.js'

const activeAgendaStatuses = ['planejado', 'confirmado', 'ao_vivo']

const agendaBaseSchema = z.object({
  tipo: z.enum(['live', 'gravacao_video']),
  marca_id: z.string().uuid(),
  cabine_id: z.string().uuid().nullable().optional(),
  data_inicio: z.string().datetime({ offset: true }),
  data_fim: z.string().datetime({ offset: true }),
  status: z.enum(['planejado', 'confirmado', 'ao_vivo', 'concluido', 'cancelado']).default('planejado'),
  recorrencia_rule: z.string().nullable().optional(),
  recorrencia_origem_id: z.string().uuid().nullable().optional(),
  observacoes: z.string().nullable().optional(),
})

const agendaSchema = agendaBaseSchema.refine((data) => new Date(data.data_fim) > new Date(data.data_inicio), {
  message: 'data_fim deve ser maior que data_inicio',
})

const agendaPatchSchema = agendaBaseSchema.partial().refine((data) => {
  if (!data.data_inicio || !data.data_fim) return true
  return new Date(data.data_fim) > new Date(data.data_inicio)
}, { message: 'data_fim deve ser maior que data_inicio' })

async function ensureAgendaRefs(db, reply, { tenantId, marcaId, cabineId }) {
  if (marcaId) {
    const marca = await db.query('SELECT id FROM marcas WHERE id = $1 AND tenant_id = $2::uuid', [marcaId, tenantId])
    if (!marca.rows[0]) {
      reply.code(404).send({ error: 'Marca não encontrada' })
      return false
    }
  }

  if (cabineId) {
    const cabine = await db.query('SELECT id FROM cabines WHERE id = $1 AND tenant_id = $2::uuid', [cabineId, tenantId])
    if (!cabine.rows[0]) {
      reply.code(404).send({ error: 'Cabine não encontrada' })
      return false
    }
  }

  return true
}

async function hasAgendaOverlap(db, { tenantId, cabineId, dataInicio, dataFim, excludeId }) {
  if (!cabineId) return false

  const values = [tenantId, cabineId, dataInicio, dataFim, activeAgendaStatuses]
  let extra = ''
  if (excludeId) {
    values.push(excludeId)
    extra = `AND id <> $${values.length}::uuid`
  }

  const result = await db.query(
    `SELECT id
     FROM agenda_eventos
     WHERE tenant_id = $1::uuid
       AND cabine_id = $2::uuid
       AND status = ANY($5::text[])
       AND data_inicio < $4::timestamptz
       AND data_fim > $3::timestamptz
       ${extra}
     LIMIT 1`,
    values,
  )
  return result.rowCount > 0
}

export async function agendaRoutes(app) {
  const readAccess = [app.authenticate, app.requirePapel(READ_AGENDA)]
  const writeAccess = [app.authenticate, app.requirePapel(WRITE_AGENDA)]

  app.get('/v1/agenda', { preHandler: readAccess }, async (request) => {
    const { tenant_id } = request.user
    const { status, tipo, cabine_id, marca_id, data_inicio, data_fim } = request.query ?? {}

    return app.withTenant(tenant_id, async (db) => {
      const values = [tenant_id]
      const filters = ['ae.tenant_id = $1::uuid']
      const add = (sql, value) => {
        values.push(value)
        filters.push(sql.replace('?', `$${values.length}`))
      }

      if (status && status !== 'all') add('ae.status = ?', status)
      if (tipo && tipo !== 'all') add('ae.tipo = ?', tipo)
      if (cabine_id) add('ae.cabine_id = ?::uuid', cabine_id)
      if (marca_id) add('ae.marca_id = ?::uuid', marca_id)
      if (data_inicio) add('ae.data_fim >= ?::timestamptz', data_inicio)
      if (data_fim) add('ae.data_inicio <= ?::timestamptz', data_fim)

      const result = await db.query(
        `SELECT ae.*,
                m.nome AS marca_nome,
                c.numero AS cabine_numero,
                c.nome AS cabine_nome
         FROM agenda_eventos ae
         JOIN marcas m ON m.id = ae.marca_id AND m.tenant_id = ae.tenant_id
         LEFT JOIN cabines c ON c.id = ae.cabine_id AND c.tenant_id = ae.tenant_id
         WHERE ${filters.join(' AND ')}
         ORDER BY ae.data_inicio ASC
         LIMIT 500`,
        values,
      )
      return result.rows
    })
  })

  app.post('/v1/agenda', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = agendaSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id, sub } = request.user
    const d = parsed.data
    return app.withTenant(tenant_id, async (db) => {
      const refsOk = await ensureAgendaRefs(db, reply, { tenantId: tenant_id, marcaId: d.marca_id, cabineId: d.cabine_id })
      if (!refsOk) return reply

      if (d.cabine_id && activeAgendaStatuses.includes(d.status)) {
        const overlap = await hasAgendaOverlap(db, {
          tenantId: tenant_id,
          cabineId: d.cabine_id,
          dataInicio: d.data_inicio,
          dataFim: d.data_fim,
        })
        if (overlap) return reply.code(409).send({ error: 'Já existe evento ativo nesta cabine no horário informado' })
      }

      const result = await db.query(
        `INSERT INTO agenda_eventos (
           tenant_id, tipo, marca_id, cabine_id, data_inicio, data_fim,
           status, recorrencia_rule, recorrencia_origem_id, observacoes, criado_por
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          tenant_id, d.tipo, d.marca_id, d.cabine_id ?? null, d.data_inicio,
          d.data_fim, d.status, d.recorrencia_rule ?? null,
          d.recorrencia_origem_id ?? null, d.observacoes ?? null, sub ?? null,
        ],
      )
      return reply.code(201).send(result.rows[0])
    })
  })

  app.patch('/v1/agenda/:id', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = agendaPatchSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const updates = parsed.data
    const fields = Object.keys(updates)
    if (fields.length === 0) return reply.code(400).send({ error: 'Nenhum campo para atualizar' })

    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const currentQ = await db.query(
        `SELECT * FROM agenda_eventos WHERE id = $1 AND tenant_id = $2::uuid FOR UPDATE`,
        [request.params.id, tenant_id],
      )
      const current = currentQ.rows[0]
      if (!current) return reply.code(404).send({ error: 'Evento não encontrado' })

      const next = { ...current, ...updates }
      if (new Date(next.data_fim) <= new Date(next.data_inicio)) {
        return reply.code(400).send({ error: 'data_fim deve ser maior que data_inicio' })
      }

      const refsOk = await ensureAgendaRefs(db, reply, { tenantId: tenant_id, marcaId: updates.marca_id, cabineId: updates.cabine_id })
      if (!refsOk) return reply

      if (next.cabine_id && activeAgendaStatuses.includes(next.status)) {
        const overlap = await hasAgendaOverlap(db, {
          tenantId: tenant_id,
          cabineId: next.cabine_id,
          dataInicio: next.data_inicio,
          dataFim: next.data_fim,
          excludeId: request.params.id,
        })
        if (overlap) return reply.code(409).send({ error: 'Já existe evento ativo nesta cabine no horário informado' })
      }

      const values = [request.params.id, tenant_id, ...fields.map((field) => updates[field])]
      const set = fields.map((field, index) => `${field} = $${index + 3}`).concat('atualizado_em = NOW()').join(', ')
      const result = await db.query(
        `UPDATE agenda_eventos SET ${set}
         WHERE id = $1 AND tenant_id = $2::uuid
         RETURNING *`,
        values,
      )
      return result.rows[0]
    })
  })

  app.delete('/v1/agenda/:id', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE agenda_eventos SET status = 'cancelado', atualizado_em = NOW()
         WHERE id = $1 AND tenant_id = $2::uuid
         RETURNING id`,
        [request.params.id, tenant_id],
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Evento não encontrado' })
      return reply.code(204).send()
    })
  })
}
