import { z } from 'zod'
import { READ_VENDAS_ATRIBUIDAS, WRITE_VENDAS_ATRIBUIDAS } from '../config/role_groups.js'
import { NIL_UUID, resolvePresenterCommissionPct } from '../services/presenter-commission.js'

const vendaSchema = z.object({
  origem: z.enum(['live', 'video']),
  origem_id: z.string().uuid(),
  marca_id: z.string().uuid(),
  apresentadora_id: z.string().uuid().nullable().optional(),
  data: z.string(),
  gmv: z.coerce.number().min(0).default(0),
  pedidos: z.coerce.number().int().min(0).default(0),
  comissao_apresentadora: z.coerce.number().min(0).optional(),
  comissao_franquia: z.coerce.number().min(0).optional(),
  comissao_franqueadora: z.coerce.number().min(0).optional(),
})

const vendaPatchSchema = vendaSchema.partial().omit({ origem: true, origem_id: true })

export async function calcularComissoesAtribuidas(db, {
  tenantId,
  marcaId,
  apresentadoraId,
  origem,
  origemId,
  data,
  gmv,
  comissaoApresentadora,
  comissaoFranquia,
  comissaoFranqueadora,
}) {
  const marcaQ = await db.query(
    `SELECT comissao_franquia_pct, comissao_franqueadora_pct
     FROM marcas WHERE id = $1 AND tenant_id = $2::uuid`,
    [marcaId, tenantId],
  )
  const marca = marcaQ.rows[0]
  if (!marca) return null

  let apresentadoraPct = 0
  if (apresentadoraId) {
    apresentadoraPct = await resolvePresenterCommissionPct(db, {
      tenantId,
      marcaId,
      apresentadoraId,
      origem,
      origemId,
      data,
      gmv,
    })
  }

  const valor = Number(gmv ?? 0)
  return {
    comissao_apresentadora: comissaoApresentadora ?? valor * (apresentadoraPct / 100),
    comissao_franquia: comissaoFranquia ?? valor * (Number(marca.comissao_franquia_pct ?? 0) / 100),
    comissao_franqueadora: comissaoFranqueadora ?? valor * (Number(marca.comissao_franqueadora_pct ?? 0) / 100),
  }
}

export async function upsertVendaAtribuida(db, payload) {
  const comissoes = await calcularComissoesAtribuidas(db, payload)
  if (!comissoes) return null

  const apresentadoraId = payload.apresentadoraId ?? null
  const current = await db.query(
    `SELECT *
     FROM vendas_atribuidas
     WHERE tenant_id = $1::uuid
       AND origem = $2
       AND origem_id = $3::uuid
       AND COALESCE(apresentadora_id, $4::uuid) = COALESCE($5::uuid, $4::uuid)
     LIMIT 1`,
    [payload.tenantId, payload.origem, payload.origemId, NIL_UUID, apresentadoraId],
  )

  if (current.rows[0]) {
    if (current.rows[0].status_aprovacao === 'aprovada') return current.rows[0]

    const updated = await db.query(
      `UPDATE vendas_atribuidas
       SET marca_id = $1,
           apresentadora_id = $2,
           data = $3,
           gmv = $4,
           pedidos = $5,
           comissao_apresentadora = $6,
           comissao_franquia = $7,
           comissao_franqueadora = $8,
           atualizado_em = NOW()
       WHERE id = $9 AND tenant_id = $10::uuid
       RETURNING *`,
      [
        payload.marcaId, apresentadoraId, payload.data, payload.gmv ?? 0, payload.pedidos ?? 0,
        comissoes.comissao_apresentadora, comissoes.comissao_franquia, comissoes.comissao_franqueadora,
        current.rows[0].id, payload.tenantId,
      ],
    )
    return updated.rows[0]
  }

  const inserted = await db.query(
    `INSERT INTO vendas_atribuidas (
       tenant_id, origem, origem_id, marca_id, apresentadora_id, data,
       gmv, pedidos, comissao_apresentadora, comissao_franquia, comissao_franqueadora
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      payload.tenantId, payload.origem, payload.origemId, payload.marcaId,
      apresentadoraId, payload.data, payload.gmv ?? 0, payload.pedidos ?? 0,
      comissoes.comissao_apresentadora, comissoes.comissao_franquia, comissoes.comissao_franqueadora,
    ],
  )
  return inserted.rows[0]
}

export async function recalcularVendasAtribuidasApresentadora(db, { tenantId, apresentadoraId }) {
  if (!tenantId || !apresentadoraId) return { updated: 0 }

  const vendas = await db.query(
    `SELECT id, origem, origem_id, marca_id, apresentadora_id, data, gmv, pedidos
     FROM vendas_atribuidas
     WHERE tenant_id = $1::uuid
       AND apresentadora_id = $2::uuid
       AND origem IN ('live', 'video')
       AND COALESCE(status_aprovacao, 'pendente_aprovacao') = 'pendente_aprovacao'
     ORDER BY data ASC, criado_em ASC`,
    [tenantId, apresentadoraId],
  )

  let updated = 0
  for (const venda of vendas.rows) {
    const comissoes = await calcularComissoesAtribuidas(db, {
      tenantId,
      origem: venda.origem,
      origemId: venda.origem_id,
      marcaId: venda.marca_id,
      apresentadoraId: venda.apresentadora_id,
      data: venda.data,
      gmv: venda.gmv,
    })
    if (!comissoes) continue

    await db.query(
      `UPDATE vendas_atribuidas
       SET comissao_apresentadora = $1,
           comissao_franquia = $2,
           comissao_franqueadora = $3,
           atualizado_em = NOW()
       WHERE id = $4 AND tenant_id = $5::uuid`,
      [
        comissoes.comissao_apresentadora,
        comissoes.comissao_franquia,
        comissoes.comissao_franqueadora,
        venda.id,
        tenantId,
      ],
    )
    updated += 1
  }

  return { updated }
}

export async function vendasAtribuidasRoutes(app) {
  const readAccess = [app.authenticate, app.requirePapel(READ_VENDAS_ATRIBUIDAS)]
  const writeAccess = [app.authenticate, app.requirePapel(WRITE_VENDAS_ATRIBUIDAS)]

  app.get('/v1/vendas-atribuidas', { preHandler: readAccess }, async (request) => {
    const { tenant_id } = request.user
    const { origem, marca_id, apresentadora_id, data_inicio, data_fim } = request.query ?? {}

    return app.withTenant(tenant_id, async (db) => {
      const values = [tenant_id]
      const filters = ['va.tenant_id = $1::uuid']
      const add = (sql, value) => {
        values.push(value)
        filters.push(sql.replace('?', `$${values.length}`))
      }

      if (origem && origem !== 'all') add('va.origem = ?', origem)
      if (marca_id) add('va.marca_id = ?::uuid', marca_id)
      if (apresentadora_id) add('va.apresentadora_id = ?::uuid', apresentadora_id)
      if (data_inicio) add('va.data >= ?::date', data_inicio)
      if (data_fim) add('va.data <= ?::date', data_fim)

      const result = await db.query(
        `SELECT va.*, m.nome AS marca_nome, a.nome AS apresentadora_nome
         FROM vendas_atribuidas va
         JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
         LEFT JOIN apresentadoras a ON a.id = va.apresentadora_id AND a.tenant_id = va.tenant_id
         WHERE ${filters.join(' AND ')}
         ORDER BY va.data DESC, va.criado_em DESC
         LIMIT 1000`,
        values,
      )
      return result.rows
    })
  })

  app.post('/v1/vendas-atribuidas', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = vendaSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const d = parsed.data
    return app.withTenant(tenant_id, async (db) => {
      const venda = await upsertVendaAtribuida(db, {
        tenantId: tenant_id,
        origem: d.origem,
        origemId: d.origem_id,
        marcaId: d.marca_id,
        apresentadoraId: d.apresentadora_id ?? null,
        data: d.data,
        gmv: d.gmv,
        pedidos: d.pedidos,
        comissaoApresentadora: d.comissao_apresentadora,
        comissaoFranquia: d.comissao_franquia,
        comissaoFranqueadora: d.comissao_franqueadora,
      })
      if (!venda) return reply.code(404).send({ error: 'Marca não encontrada' })
      return reply.code(201).send(venda)
    })
  })

  app.patch('/v1/vendas-atribuidas/:id', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = vendaPatchSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const updates = parsed.data
    const fields = Object.keys(updates)
    if (fields.length === 0) return reply.code(400).send({ error: 'Nenhum campo para atualizar' })

    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const current = await db.query('SELECT * FROM vendas_atribuidas WHERE id = $1 AND tenant_id = $2::uuid', [request.params.id, tenant_id])
      if (!current.rows[0]) return reply.code(404).send({ error: 'Venda atribuída não encontrada' })

      const next = { ...current.rows[0], ...updates }
    const comissoes = await calcularComissoesAtribuidas(db, {
      tenantId: tenant_id,
      marcaId: next.marca_id,
      apresentadoraId: next.apresentadora_id ?? null,
      origem: next.origem,
      origemId: next.origem_id,
      data: next.data,
      gmv: next.gmv,
      comissaoApresentadora: updates.comissao_apresentadora,
      comissaoFranquia: updates.comissao_franquia,
        comissaoFranqueadora: updates.comissao_franqueadora,
      })
      if (!comissoes) return reply.code(404).send({ error: 'Marca não encontrada' })

      const payload = {
        marca_id: next.marca_id,
        apresentadora_id: next.apresentadora_id ?? null,
        data: next.data,
        gmv: next.gmv,
        pedidos: next.pedidos,
        ...comissoes,
      }
      const keys = Object.keys(payload)
      const values = [request.params.id, tenant_id, ...keys.map((key) => payload[key])]
      const set = keys.map((key, index) => `${key} = $${index + 3}`).concat('atualizado_em = NOW()').join(', ')

      const result = await db.query(
        `UPDATE vendas_atribuidas SET ${set}
         WHERE id = $1 AND tenant_id = $2::uuid
         RETURNING *`,
        values,
      )
      return result.rows[0]
    })
  })
}
