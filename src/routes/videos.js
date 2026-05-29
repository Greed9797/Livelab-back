import { z } from 'zod'
import { READ_VIDEOS, WRITE_VIDEOS } from '../config/role_groups.js'
import { upsertVendaAtribuida } from './vendas_atribuidas.js'
import { moneySchema } from '../lib/money.js'

const videoSchema = z.object({
  marca_id: z.string().uuid(),
  apresentadora_id: z.string().uuid().nullable().optional(),
  agenda_evento_id: z.string().uuid().nullable().optional(),
  data: z.string(),
  quantidade: z.coerce.number().int().min(0).default(0),
  plataforma: z.string().default('tiktok'),
  campanha: z.string().nullable().optional(),
  gmv_atribuido: moneySchema.default(0),
  pedidos_atribuidos: z.coerce.number().int().min(0).default(0),
  observacoes: z.string().nullable().optional(),
})

const videoPatchSchema = videoSchema.partial()

async function ensureVideoRefs(db, reply, { tenantId, marcaId, apresentadoraId, agendaEventoId }) {
  if (marcaId) {
    const marca = await db.query('SELECT id FROM marcas WHERE id = $1 AND tenant_id = $2::uuid', [marcaId, tenantId])
    if (!marca.rows[0]) {
      reply.code(404).send({ error: 'Marca não encontrada' })
      return false
    }
  }

  if (apresentadoraId) {
    const apresentadora = await db.query('SELECT id FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid', [apresentadoraId, tenantId])
    if (!apresentadora.rows[0]) {
      reply.code(404).send({ error: 'Apresentadora não encontrada' })
      return false
    }
  }

  if (agendaEventoId) {
    const agenda = await db.query(
      `SELECT id FROM agenda_eventos
       WHERE id = $1 AND tenant_id = $2::uuid AND tipo = 'gravacao_video'`,
      [agendaEventoId, tenantId],
    )
    if (!agenda.rows[0]) {
      reply.code(404).send({ error: 'Evento de gravação não encontrado' })
      return false
    }
  }

  return true
}

async function syncVendaVideo(db, tenantId, video) {
  if (Number(video.gmv_atribuido ?? 0) <= 0) {
    await db.query(
      `DELETE FROM vendas_atribuidas
       WHERE origem = 'video'
         AND origem_id = $1::uuid
         AND tenant_id = $2::uuid
         AND COALESCE(status_aprovacao, 'pendente_aprovacao') = 'pendente_aprovacao'`,
      [video.id, tenantId],
    )
    return null
  }

  await db.query(
    `DELETE FROM vendas_atribuidas
     WHERE origem = 'video'
       AND origem_id = $1::uuid
       AND tenant_id = $2::uuid
       AND apresentadora_id IS DISTINCT FROM $3::uuid
       AND COALESCE(status_aprovacao, 'pendente_aprovacao') = 'pendente_aprovacao'`,
    [video.id, tenantId, video.apresentadora_id ?? null],
  )

  return upsertVendaAtribuida(db, {
    tenantId,
    origem: 'video',
    origemId: video.id,
    marcaId: video.marca_id,
    apresentadoraId: video.apresentadora_id ?? null,
    data: video.data,
    gmv: Number(video.gmv_atribuido ?? 0),
    pedidos: Number(video.pedidos_atribuidos ?? 0),
  })
}

export async function videosRoutes(app) {
  const readAccess = [app.authenticate, app.requirePapel(READ_VIDEOS)]
  const writeAccess = [app.authenticate, app.requirePapel(WRITE_VIDEOS)]

  app.get('/v1/videos', { preHandler: readAccess }, async (request) => {
    const { tenant_id } = request.user
    const { marca_id, apresentadora_id, data_inicio, data_fim, plataforma } = request.query ?? {}

    return app.withTenant(tenant_id, async (db) => {
      const values = [tenant_id]
      const filters = ['vr.tenant_id = $1::uuid']
      const add = (sql, value) => {
        values.push(value)
        filters.push(sql.replace('?', `$${values.length}`))
      }

      if (marca_id) add('vr.marca_id = ?::uuid', marca_id)
      if (apresentadora_id) add('vr.apresentadora_id = ?::uuid', apresentadora_id)
      if (data_inicio) add('vr.data >= ?::date', data_inicio)
      if (data_fim) add('vr.data <= ?::date', data_fim)
      if (plataforma && plataforma !== 'all') add('vr.plataforma = ?', plataforma)

      const result = await db.query(
        `SELECT vr.*,
                m.nome AS marca_nome,
                a.nome AS apresentadora_nome,
                ae.status AS agenda_status
         FROM video_registros vr
         JOIN marcas m ON m.id = vr.marca_id AND m.tenant_id = vr.tenant_id
         LEFT JOIN apresentadoras a ON a.id = vr.apresentadora_id AND a.tenant_id = vr.tenant_id
         LEFT JOIN agenda_eventos ae ON ae.id = vr.agenda_evento_id AND ae.tenant_id = vr.tenant_id
         WHERE ${filters.join(' AND ')}
         ORDER BY vr.data DESC, vr.criado_em DESC
         LIMIT 1000`,
        values,
      )
      return result.rows
    })
  })

  app.post('/v1/videos', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = videoSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id, sub } = request.user
    const d = parsed.data
    return app.withTenant(tenant_id, async (db) => {
      const refsOk = await ensureVideoRefs(db, reply, {
        tenantId: tenant_id,
        marcaId: d.marca_id,
        apresentadoraId: d.apresentadora_id,
        agendaEventoId: d.agenda_evento_id,
      })
      if (!refsOk) return reply

      await db.query('BEGIN')
      try {
        const result = await db.query(
          `INSERT INTO video_registros (
             tenant_id, marca_id, apresentadora_id, agenda_evento_id, data,
             quantidade, plataforma, campanha, gmv_atribuido,
             pedidos_atribuidos, observacoes, criado_por
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING *`,
          [
            tenant_id, d.marca_id, d.apresentadora_id ?? null,
            d.agenda_evento_id ?? null, d.data, d.quantidade, d.plataforma,
            d.campanha ?? null, d.gmv_atribuido, d.pedidos_atribuidos,
            d.observacoes ?? null, sub ?? null,
          ],
        )
        const video = result.rows[0]
        const venda = await syncVendaVideo(db, tenant_id, video)
        await db.query('COMMIT')
        return reply.code(201).send({ ...video, venda_atribuida: venda })
      } catch (error) {
        await db.query('ROLLBACK')
        throw error
      }
    })
  })

  app.patch('/v1/videos/:id', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = videoPatchSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const updates = parsed.data
    const fields = Object.keys(updates)
    if (fields.length === 0) return reply.code(400).send({ error: 'Nenhum campo para atualizar' })

    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const refsOk = await ensureVideoRefs(db, reply, {
        tenantId: tenant_id,
        marcaId: updates.marca_id,
        apresentadoraId: updates.apresentadora_id,
        agendaEventoId: updates.agenda_evento_id,
      })
      if (!refsOk) return reply

      await db.query('BEGIN')
      try {
        const values = [request.params.id, tenant_id, ...fields.map((field) => updates[field])]
        const set = fields.map((field, index) => `${field} = $${index + 3}`).join(', ')
        const result = await db.query(
          `UPDATE video_registros SET ${set}
           WHERE id = $1 AND tenant_id = $2::uuid
           RETURNING *`,
          values,
        )
        if (!result.rows[0]) {
          await db.query('ROLLBACK')
          return reply.code(404).send({ error: 'Registro de vídeo não encontrado' })
        }
        const venda = await syncVendaVideo(db, tenant_id, result.rows[0])
        await db.query('COMMIT')
        return { ...result.rows[0], venda_atribuida: venda }
      } catch (error) {
        await db.query('ROLLBACK')
        throw error
      }
    })
  })

  app.delete('/v1/videos/:id', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      await db.query('BEGIN')
      try {
        const video = await db.query(
          `DELETE FROM video_registros
           WHERE id = $1 AND tenant_id = $2::uuid
           RETURNING id`,
          [request.params.id, tenant_id],
        )
        if (!video.rows[0]) {
          await db.query('ROLLBACK')
          return reply.code(404).send({ error: 'Registro de vídeo não encontrado' })
        }
        await db.query(
          `DELETE FROM vendas_atribuidas
           WHERE origem = 'video' AND origem_id = $1 AND tenant_id = $2::uuid`,
          [request.params.id, tenant_id],
        )
        await db.query('COMMIT')
        return reply.code(204).send()
      } catch (error) {
        await db.query('ROLLBACK')
        throw error
      }
    })
  })
}
