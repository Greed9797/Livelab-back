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
  valor_fixo_mensal: z.number().min(0).default(0),
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

const COLS = `a.id, a.nome, a.telefone, a.cargo, a.email, a.cpf_cnpj, a.cidade, a.ativo, a.fixo, a.comissao_pct, a.meta_diaria_gmv, a.valor_fixo_mensal, a.observacoes, a.link_contrato, a.data_aniversario, a.data_inicio, a.data_fim, a.criado_em, a.user_id`

const STATS = `
  COALESCE(stats.total_lives, 0)::int AS total_lives,
  COALESCE(stats.total_faturamento, 0)::float AS total_faturamento
`

const STATS_JOIN = `
  LEFT JOIN LATERAL (
    SELECT
      COUNT(DISTINCT l.id)::int AS total_lives,
      COALESCE(SUM(l.fat_gerado), 0) AS total_faturamento
    FROM lives l
    WHERE l.tenant_id = a.tenant_id
      AND l.apresentador_id = a.user_id
      AND l.status = 'encerrada'
  ) stats ON true
`

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

  // Não existe apresentadora: tenta provisionar a partir do usuário com papel apresentador.
  const user = await db.query(
    `SELECT id, nome, email FROM users
      WHERE id = $1 AND tenant_id = $2::uuid
        AND papel IN ('apresentador', 'apresentadora')`,
    [rawId, tenantId],
  )
  if (!user.rows[0]) return null

  const created = await db.query(
    `INSERT INTO apresentadoras (tenant_id, user_id, nome, email, fixo, comissao_pct, meta_diaria_gmv, ativo)
     VALUES ($1, $2, $3, $4, 0, 0, 0, true)
     ON CONFLICT (user_id) WHERE user_id IS NOT NULL DO UPDATE SET nome = EXCLUDED.nome
     RETURNING id`,
    [tenantId, user.rows[0].id, user.rows[0].nome ?? 'Apresentadora', user.rows[0].email ?? null],
  )
  return created.rows[0]?.id ?? null
}

export async function apresentadorasRoutes(app) {
  const readAccess = [app.authenticate, app.requirePapel(READ_APRESENTADORAS)]
  const writeAccess = [app.authenticate, app.requirePapel(WRITE_APRESENTADORAS)]

  // GET /v1/apresentadoras
  app.get('/v1/apresentadoras', { preHandler: readAccess }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT ${COLS}, ${STATS}
         FROM apresentadoras a
         ${STATS_JOIN}
         WHERE a.tenant_id = $1::uuid
         ORDER BY a.ativo DESC, a.nome ASC`,
        [tenant_id]
      )
      return result.rows
    })
  })

  // GET /v1/apresentadoras/sem-usuario — usuários com papel apresentadora/apresentador
  // que não têm registro correspondente em apresentadoras (diagnóstico)
  app.get('/v1/apresentadoras/sem-usuario', { preHandler: readAccess }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT u.id, u.nome, u.email, u.papel, u.criado_em
         FROM users u
         WHERE u.tenant_id = $1::uuid
           AND u.papel IN ('apresentador', 'apresentadora')
           AND u.ativo = true
           AND NOT EXISTS (
             SELECT 1 FROM apresentadoras a
             WHERE a.user_id = u.id AND a.tenant_id = $1::uuid
           )
         ORDER BY u.criado_em DESC`,
        [tenant_id]
      )
      return result.rows
    })
  })

  // POST /v1/apresentadoras/do-usuario/:userId — cria registro em apresentadoras
  // para um usuário com papel apresentadora/apresentador que não tem registro
  app.post('/v1/apresentadoras/do-usuario/:userId', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    const { userId } = request.params
    return app.withTenant(tenant_id, async (db) => {
      const userRow = await db.query(
        `SELECT id, nome, email, papel FROM users
         WHERE id = $1 AND tenant_id = $2::uuid AND papel IN ('apresentador','apresentadora')`,
        [userId, tenant_id]
      )
      if (!userRow.rows[0]) return reply.code(404).send({ error: 'Usuário não encontrado ou papel incompatível' })
      const u = userRow.rows[0]

      const existing = await db.query(
        `SELECT id FROM apresentadoras WHERE user_id = $1 AND tenant_id = $2::uuid`,
        [userId, tenant_id]
      )
      if (existing.rows[0]) return reply.code(409).send({ error: 'Usuário já vinculado a uma apresentadora', apresentadora_id: existing.rows[0].id })

      const result = await db.query(
        `INSERT INTO apresentadoras (tenant_id, nome, email, user_id, fixo, comissao_pct, meta_diaria_gmv, valor_fixo_mensal)
         VALUES ($1, $2, $3, $4, 0, 0, 0, 0)
         RETURNING id, nome, email, user_id`,
        [tenant_id, u.nome, u.email ?? null, userId]
      )
      app.audit?.log?.(request, { action: 'apresentadora.create_from_user', entity_type: 'apresentadora', entity_id: result.rows[0].id, metadata: { user_id: userId, nome: u.nome } })?.catch(() => {})
      return reply.code(201).send(result.rows[0])
    })
  })

  // GET /v1/apresentadoras/:id/faixas-comissao
  app.get('/v1/apresentadoras/:id/faixas-comissao', { preHandler: app.authenticate }, async (request, reply) => {
    const { tenant_id, papel, sub: userId } = request.user
    return app.withTenant(tenant_id, async (db) => {
      if (!READ_APRESENTADORAS.includes(papel)) {
        const own = await db.query(
          `SELECT id FROM apresentadoras
           WHERE id = $1 AND tenant_id = $2::uuid AND user_id = $3`,
          [request.params.id, tenant_id, userId],
        )
        if (!own.rows[0]) return reply.code(403).send({ error: 'Acesso negado' })
      }
      const result = await db.query(
        `SELECT id, apresentadora_id, gmv_inicio, gmv_fim, comissao_pct, ativo, criado_em, atualizado_em
         FROM apresentadora_comissao_faixas
         WHERE tenant_id = $1::uuid AND apresentadora_id = $2
         ORDER BY ativo DESC, gmv_inicio ASC`,
        [tenant_id, request.params.id],
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
    const set = fields.map((field, index) => `${field} = $${index + 4}`).concat('atualizado_em = NOW()').join(', ')
    const values = [request.params.id, request.params.faixaId, tenant_id, ...fields.map((field) => updates[field])]
    return app.withTenant(tenant_id, async (db) => {
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
      const result = await db.query(
        `UPDATE apresentadora_comissao_faixas
         SET ativo = false, atualizado_em = NOW()
         WHERE apresentadora_id = $1 AND id = $2 AND tenant_id = $3::uuid
         RETURNING id`,
        [request.params.id, request.params.faixaId, tenant_id],
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
        `SELECT ${COLS}, ${STATS}
         FROM apresentadoras a
         ${STATS_JOIN}
         WHERE a.id = $1 AND a.tenant_id = $2::uuid`,
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
        `INSERT INTO apresentadoras (tenant_id, nome, telefone, cargo, email, cpf_cnpj, cidade, fixo, comissao_pct, meta_diaria_gmv, valor_fixo_mensal, observacoes, link_contrato, data_aniversario, data_inicio, data_fim)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING id, nome, telefone, cargo, email, cpf_cnpj, cidade, ativo, fixo, comissao_pct, meta_diaria_gmv, valor_fixo_mensal, observacoes, link_contrato, data_aniversario, data_inicio, data_fim, criado_em, user_id`,
        [tenant_id, d.nome, d.telefone ?? null, d.cargo ?? null, d.email ?? null,
         d.cpf_cnpj ?? null, d.cidade ?? null, d.fixo, d.comissao_pct, d.meta_diaria_gmv, d.valor_fixo_mensal,
         d.observacoes ?? null, d.link_contrato ?? null, d.data_aniversario ?? null, d.data_inicio ?? null, d.data_fim ?? null]
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
         RETURNING id, nome, telefone, cargo, email, cpf_cnpj, cidade, ativo, fixo, comissao_pct, meta_diaria_gmv, valor_fixo_mensal, observacoes, link_contrato, data_aniversario, data_inicio, data_fim, criado_em, user_id`,
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

  // GET /v1/apresentadoras/:id/faixas
  app.get('/v1/apresentadoras/:id/faixas', { preHandler: readAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const ap = await db.query('SELECT id FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid', [request.params.id, tenant_id])
      if (!ap.rows[0]) return reply.code(404).send({ error: 'Apresentadora não encontrada' })
      const result = await db.query(
        `SELECT id, gmv_min, gmv_max, pct_comissao, vigente_desde, criado_em
         FROM apresentadora_faixas_comissao
         WHERE apresentadora_id = $1 AND tenant_id = $2::uuid
         ORDER BY gmv_min ASC`,
        [request.params.id, tenant_id],
      )
      return result.rows
    })
  })

  // POST /v1/apresentadoras/:id/faixas
  app.post('/v1/apresentadoras/:id/faixas', { preHandler: writeAccess }, async (request, reply) => {
    const schema = z.object({
      gmv_min: z.number().min(0).default(0),
      gmv_max: z.number().positive().nullable().optional(),
      pct_comissao: z.number().min(0).max(100),
      vigente_desde: z.string().optional(),
    })
    const parsed = schema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const d = parsed.data
    return app.withTenant(tenant_id, async (db) => {
      const ap = await db.query('SELECT id FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid', [request.params.id, tenant_id])
      if (!ap.rows[0]) return reply.code(404).send({ error: 'Apresentadora não encontrada' })
      const result = await db.query(
        `INSERT INTO apresentadora_faixas_comissao (tenant_id, apresentadora_id, gmv_min, gmv_max, pct_comissao, vigente_desde)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [tenant_id, request.params.id, d.gmv_min, d.gmv_max ?? null, d.pct_comissao, d.vigente_desde ?? new Date().toISOString().slice(0, 10)],
      )
      return reply.code(201).send(result.rows[0])
    })
  })

  // DELETE /v1/apresentadoras/:id/faixas/:faixaId
  app.delete('/v1/apresentadoras/:id/faixas/:faixaId', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `DELETE FROM apresentadora_faixas_comissao WHERE id = $1 AND apresentadora_id = $2 AND tenant_id = $3::uuid RETURNING id`,
        [request.params.faixaId, request.params.id, tenant_id],
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Faixa não encontrada' })
      return reply.code(204).send()
    })
  })

  // GET /v1/ranking/apresentadoras?mes=YYYY-MM
  app.get('/v1/ranking/apresentadoras', { preHandler: readAccess }, async (request) => {
    const { tenant_id } = request.user
    const mesStr = request.query.mes
    const mesInicio = (mesStr && /^\d{4}-\d{2}$/.test(mesStr))
      ? `${mesStr}-01`
      : (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-01` })()
    const [ano, mes] = mesInicio.split('-')
    const mesFim = new Date(Date.UTC(Number(ano), Number(mes), 0)).toISOString().slice(0, 10)

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT
           a.id,
           a.nome,
           a.valor_fixo_mensal,
           COALESCE(SUM(va.gmv), 0) AS gmv_total,
           COALESCE(SUM(va.comissao_apresentadora), 0) AS comissao_variavel,
           GREATEST(a.valor_fixo_mensal, COALESCE(SUM(va.comissao_apresentadora), 0)) AS ganho_total,
           COUNT(DISTINCT CASE WHEN va.origem = 'live' THEN va.origem_id END)::int AS total_lives,
           COALESCE(m.gmv_meta, 0) AS gmv_meta,
           CASE WHEN COALESCE(m.gmv_meta, 0) > 0
                THEN ROUND(COALESCE(SUM(va.gmv), 0) / m.gmv_meta * 100, 1)
                ELSE NULL END AS pct_meta,
           ROW_NUMBER() OVER (ORDER BY GREATEST(a.valor_fixo_mensal, COALESCE(SUM(va.comissao_apresentadora), 0)) DESC) AS posicao
         FROM apresentadoras a
         LEFT JOIN vendas_atribuidas va
           ON va.apresentadora_id = a.id
          AND va.tenant_id = $1::uuid
          AND va.data >= $2::date
          AND va.data <= $3::date
         LEFT JOIN metas_apresentadora m
           ON m.apresentadora_id = a.id AND m.mes_referencia = $2::date
         WHERE a.tenant_id = $1::uuid AND a.ativo = true
         GROUP BY a.id, a.nome, a.valor_fixo_mensal, m.gmv_meta
         ORDER BY ganho_total DESC`,
        [tenant_id, mesInicio, mesFim],
      )
      return result.rows
    })
  })
}
