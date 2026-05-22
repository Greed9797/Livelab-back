import { z } from 'zod'
import { READ_APRESENTADORAS, WRITE_APRESENTADORAS } from '../config/role_groups.js'
import { moneySchema } from '../lib/money.js'

const APRESENTADORA_FIXO_MAX = 1_000_000 // R$ 1 milhão — sanity cap
const APRESENTADORA_META_MAX = 100_000_000 // R$ 100 milhões — sanity cap pra meta diária

const fixoSchema = moneySchema.refine((v) => v <= APRESENTADORA_FIXO_MAX, {
  message: `Fixo não pode ultrapassar R$ ${APRESENTADORA_FIXO_MAX.toLocaleString('pt-BR')}`,
})
const metaDiariaSchema = moneySchema.refine((v) => v <= APRESENTADORA_META_MAX, {
  message: `Meta diária não pode ultrapassar R$ ${APRESENTADORA_META_MAX.toLocaleString('pt-BR')}`,
})

const createSchema = z.object({
  nome:            z.string().min(1),
  telefone:        z.string().optional(),
  cargo:           z.string().optional(),
  email:           z.string().email().optional(),
  cpf_cnpj:        z.string().optional(),
  cidade:          z.string().optional(),
  fixo:            fixoSchema.default(0),
  comissao_pct:    z.number().min(0).max(100).default(0),
  meta_diaria_gmv: metaDiariaSchema.default(0),
  observacoes:     z.string().optional(),
  link_contrato:   z.string().optional(),
  data_aniversario: z.string().optional(),
  data_inicio:     z.string().optional(),
  data_fim:        z.string().optional(),
})

const updateSchema = createSchema.partial().extend({
  ativo: z.boolean().optional(),
})

const faixaSchema = z.object({
  gmv_inicio: moneySchema.default(0),
  gmv_fim: moneySchema.nullable().optional(),
  comissao_pct: z.coerce.number().min(0).max(100),
  ativo: z.boolean().default(true),
})

const faixaPatchSchema = faixaSchema.partial()

const COLS = `id, user_id, nome, telefone, cargo, email, cpf_cnpj, cidade, ativo, fixo, comissao_pct, meta_diaria_gmv, observacoes, link_contrato, data_aniversario, data_inicio, data_fim, criado_em`

// Resolve o id de apresentadora a partir de :id que pode ser:
//  - id real da tabela apresentadoras, OU
//  - user_id (quando o usuário tem papel apresentador mas ainda não tem
//    linha em apresentadoras). Nesse caso busca por user_id e, se não houver,
//    provisiona uma apresentadora vinculada ao usuário.
// Retorna o id da apresentadora ou null se nem usuário nem apresentadora existem.
async function resolveApresentadoraId(db, tenantId, rawId) {
  const byId = await db.query(
    `SELECT id FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid`,
    [rawId, tenantId],
  )
  if (byId.rows[0]) return byId.rows[0].id

  const byUser = await db.query(
    `SELECT id FROM apresentadoras WHERE user_id = $1 AND tenant_id = $2::uuid`,
    [rawId, tenantId],
  )
  if (byUser.rows[0]) return byUser.rows[0].id

  // Não existe apresentadora: provisiona a partir do usuário com papel apresentador.
  // rawId pode ser user_id; aceita também quando o usuário existe mas papel divergente
  // (defensivo — pode ter sido criado como apresentador e depois editado).
  const user = await db.query(
    `SELECT id, nome, email, papel FROM users
      WHERE id = $1 AND tenant_id = $2::uuid`,
    [rawId, tenantId],
  )
  const u = user.rows[0]
  if (!u) return null
  if (u.papel !== 'apresentador' && u.papel !== 'apresentadora') return null

  // INSERT plano (já confirmamos que não existe apresentadora por id nem user_id).
  // Em corrida, captura unique-violation e re-seleciona.
  try {
    const created = await db.query(
      `INSERT INTO apresentadoras (tenant_id, user_id, nome, email, fixo, comissao_pct, meta_diaria_gmv, ativo)
       VALUES ($1, $2, $3, $4, 0, 0, 0, true)
       RETURNING id`,
      [tenantId, u.id, u.nome ?? 'Apresentadora', u.email ?? null],
    )
    return created.rows[0]?.id ?? null
  } catch (err) {
    if (err?.code === '23505') {
      const retry = await db.query(
        `SELECT id FROM apresentadoras WHERE user_id = $1 AND tenant_id = $2::uuid`,
        [u.id, tenantId],
      )
      return retry.rows[0]?.id ?? null
    }
    throw err
  }
}

export async function apresentadorasRoutes(app) {
  const readAccess = [app.authenticate, app.requirePapel(READ_APRESENTADORAS)]
  const writeAccess = [app.authenticate, app.requirePapel(WRITE_APRESENTADORAS)]

  // GET /v1/apresentadoras
  app.get('/v1/apresentadoras', { preHandler: readAccess }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT ${COLS} FROM apresentadoras a
         WHERE a.tenant_id = $1::uuid
         ORDER BY a.ativo DESC, a.nome ASC`,
        [tenant_id]
      )
      return result.rows
    })
  })

  // GET /v1/apresentadoras/:id/faixas-comissao
  app.get('/v1/apresentadoras/:id/faixas-comissao', { preHandler: app.authenticate }, async (request, reply) => {
    const { tenant_id, papel, sub: userId } = request.user
    return app.withTenant(tenant_id, async (db) => {
      // Resolve id real da apresentadora (aceita user_id de usuário apresentador).
      const apresentadoraQ = await db.query(
        `SELECT id FROM apresentadoras WHERE (id = $1 OR user_id = $1) AND tenant_id = $2::uuid LIMIT 1`,
        [request.params.id, tenant_id],
      )
      const apresentadoraId = apresentadoraQ.rows[0]?.id
      if (!apresentadoraId) return [] // sem perfil ainda → sem faixas

      if (!READ_APRESENTADORAS.includes(papel)) {
        const own = await db.query(
          `SELECT id FROM apresentadoras
           WHERE id = $1 AND tenant_id = $2::uuid AND user_id = $3`,
          [apresentadoraId, tenant_id, userId],
        )
        if (!own.rows[0]) return reply.code(403).send({ error: 'Acesso negado' })
      }
      const result = await db.query(
        `SELECT id, apresentadora_id, gmv_inicio, gmv_fim, comissao_pct, ativo, criado_em, atualizado_em
         FROM apresentadora_comissao_faixas
         WHERE tenant_id = $1::uuid AND apresentadora_id = $2
         ORDER BY ativo DESC, gmv_inicio ASC`,
        [tenant_id, apresentadoraId],
      )
      return result.rows
    })
  })

  // POST /v1/apresentadoras/:id/faixas-comissao
  app.post('/v1/apresentadoras/:id/faixas-comissao', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = faixaSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const { tenant_id } = request.user
    const d = parsed.data
    return app.withTenant(tenant_id, async (db) => {
      const apresentadoraId = await resolveApresentadoraId(db, tenant_id, request.params.id)
      if (!apresentadoraId) return reply.code(404).send({ error: 'Apresentadora não encontrada' })
      const result = await db.query(
        `INSERT INTO apresentadora_comissao_faixas (
           tenant_id, apresentadora_id, gmv_inicio, gmv_fim, comissao_pct, ativo
         )
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, apresentadora_id, gmv_inicio, gmv_fim, comissao_pct, ativo, criado_em, atualizado_em`,
        [tenant_id, apresentadoraId, d.gmv_inicio, d.gmv_fim ?? null, d.comissao_pct, d.ativo],
      )
      return reply.code(201).send(result.rows[0])
    })
  })

  // PATCH /v1/apresentadoras/:id/faixas-comissao/:faixaId
  app.patch('/v1/apresentadoras/:id/faixas-comissao/:faixaId', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = faixaPatchSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const updates = parsed.data
    const fields = Object.keys(updates)
    if (!fields.length) return reply.code(400).send({ error: 'Nenhum campo para atualizar' })

    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const apQ = await db.query(
        `SELECT id FROM apresentadoras WHERE (id = $1 OR user_id = $1) AND tenant_id = $2::uuid LIMIT 1`,
        [request.params.id, tenant_id],
      )
      const apresentadoraId = apQ.rows[0]?.id
      if (!apresentadoraId) return reply.code(404).send({ error: 'Apresentadora não encontrada' })

      const set = fields.map((field, index) => `${field} = $${index + 4}`).concat('atualizado_em = NOW()').join(', ')
      const values = [apresentadoraId, request.params.faixaId, tenant_id, ...fields.map((field) => updates[field])]
      const result = await db.query(
        `UPDATE apresentadora_comissao_faixas
         SET ${set}
         WHERE apresentadora_id = $1 AND id = $2 AND tenant_id = $3::uuid
         RETURNING id, apresentadora_id, gmv_inicio, gmv_fim, comissao_pct, ativo, criado_em, atualizado_em`,
        values,
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Faixa não encontrada' })
      return result.rows[0]
    })
  })

  // DELETE /v1/apresentadoras/:id/faixas-comissao/:faixaId
  app.delete('/v1/apresentadoras/:id/faixas-comissao/:faixaId', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const apQ = await db.query(
        `SELECT id FROM apresentadoras WHERE (id = $1 OR user_id = $1) AND tenant_id = $2::uuid LIMIT 1`,
        [request.params.id, tenant_id],
      )
      const apresentadoraId = apQ.rows[0]?.id
      if (!apresentadoraId) return reply.code(404).send({ error: 'Apresentadora não encontrada' })
      const result = await db.query(
        `UPDATE apresentadora_comissao_faixas
         SET ativo = false, atualizado_em = NOW()
         WHERE apresentadora_id = $1 AND id = $2 AND tenant_id = $3::uuid
         RETURNING id`,
        [apresentadoraId, request.params.faixaId, tenant_id],
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Faixa não encontrada' })
      return reply.code(204).send()
    })
  })

  // GET /v1/apresentadoras/:id
  app.get('/v1/apresentadoras/:id', { preHandler: readAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT ${COLS} FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid`,
        [request.params.id, tenant_id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Apresentadora não encontrada' })
      return result.rows[0]
    })
  })

  // POST /v1/apresentadoras
  app.post('/v1/apresentadoras', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const d = parsed.data
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `INSERT INTO apresentadoras (tenant_id, nome, telefone, cargo, email, cpf_cnpj, cidade, fixo, comissao_pct, meta_diaria_gmv, observacoes, link_contrato, data_aniversario, data_inicio, data_fim)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING ${COLS}`,
        [tenant_id, d.nome, d.telefone ?? null, d.cargo ?? null, d.email ?? null,
         d.cpf_cnpj ?? null, d.cidade ?? null, d.fixo, d.comissao_pct, d.meta_diaria_gmv, d.observacoes ?? null,
         d.link_contrato ?? null, d.data_aniversario ?? null, d.data_inicio ?? null, d.data_fim ?? null]
      )
      app.audit?.log?.(request, { action: 'apresentadora.create', entity_type: 'apresentadora', entity_id: result.rows[0].id, metadata: { nome: d.nome, cargo: d.cargo ?? null, fixo: d.fixo, comissao_pct: d.comissao_pct } })?.catch(err => app.log.error({ err }, 'audit log failed'))
      return reply.code(201).send(result.rows[0])
    })
  })

  // PATCH /v1/apresentadoras/:id
  app.patch('/v1/apresentadoras/:id', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const updates = parsed.data
    const fields = Object.keys(updates)
    if (fields.length === 0) return reply.code(400).send({ error: 'Nenhum campo para atualizar' })

    return app.withTenant(tenant_id, async (db) => {
      const apresentadoraId = await resolveApresentadoraId(db, tenant_id, request.params.id)
      if (!apresentadoraId) return reply.code(404).send({ error: 'Apresentadora não encontrada' })

      const setClauses = fields.map((f, i) => `${f} = $${i + 3}`).join(', ')
      const values = [apresentadoraId, tenant_id, ...fields.map((f) => updates[f])]
      const result = await db.query(
        `UPDATE apresentadoras SET ${setClauses}
         WHERE id = $1 AND tenant_id = $2::uuid
         RETURNING ${COLS}`,
        values
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Apresentadora não encontrada' })
      app.audit?.log?.(request, { action: 'apresentadora.update', entity_type: 'apresentadora', entity_id: apresentadoraId, metadata: { changed_fields: fields } })?.catch(err => app.log.error({ err }, 'audit log failed'))
      return result.rows[0]
    })
  })

  // DELETE /v1/apresentadoras/:id — desativa (soft delete)
  app.delete('/v1/apresentadoras/:id', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE apresentadoras SET ativo = false
         WHERE id = $1 AND tenant_id = $2::uuid
         RETURNING id`,
        [request.params.id, tenant_id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Apresentadora não encontrada' })
      app.audit?.log?.(request, { action: 'apresentadora.delete', entity_type: 'apresentadora', entity_id: request.params.id, metadata: { soft_delete: true } })?.catch(err => app.log.error({ err }, 'audit log failed'))
      return reply.code(204).send()
    })
  })
}
