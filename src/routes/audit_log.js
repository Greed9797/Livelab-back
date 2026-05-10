import { z } from 'zod'
import { READ_AUDIT_LOG } from '../config/role_groups.js'

/**
 * GET /v1/audit-log
 * Lista de eventos do audit_log com paginação + filtros.
 *
 * Query params:
 *   action       — string (ex: 'cliente.delete'). LIKE prefix opcional via 'cliente.%'
 *   entity_type  — string ('cliente' | 'contrato' | etc)
 *   user_id      — uuid do ator
 *   desde        — ISO date (lower bound em criado_em)
 *   pagina       — int default 1
 *   por_pagina   — int default 50, max 200
 *
 * Response:
 *   { itens: [{ ..., autor_nome, autor_email }], total, pagina, por_pagina }
 *
 * Permissão: READ_AUDIT_LOG (franqueador_master, franqueado, auditor).
 * RLS por tenant garante isolamento (policy audit_log_tenant na migration 061).
 */

const querySchema = z.object({
  action: z.string().trim().min(1).max(120).optional(),
  entity_type: z.string().trim().min(1).max(60).optional(),
  user_id: z.string().uuid().optional(),
  desde: z.string().datetime({ offset: true }).optional()
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'desde inválido').optional()),
  pagina: z.coerce.number().int().min(1).default(1),
  por_pagina: z.coerce.number().int().min(1).max(200).default(50),
})

export async function auditLogRoutes(app) {
  const readAccess = [app.authenticate, app.requirePapel(READ_AUDIT_LOG)]

  app.get('/v1/audit-log', { onRequest: readAccess }, async (req, reply) => {
    const parsed = querySchema.safeParse(req.query ?? {})
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Filtros inválidos',
        detalhes: parsed.error.flatten(),
      })
    }
    const { action, entity_type, user_id, desde, pagina, por_pagina } = parsed.data
    const offset = (pagina - 1) * por_pagina

    const filtros = []
    const params = []
    let p = 1

    // Tenant filter — defesa em profundidade (RLS já garante, mas explicito).
    filtros.push(`a.tenant_id = $${p++}::uuid`)
    params.push(req.user.tenant_id)

    if (action) {
      // Suporte a wildcard simples 'prefix.%'
      if (action.includes('%')) {
        filtros.push(`a.action LIKE $${p++}`)
        params.push(action)
      } else {
        filtros.push(`a.action = $${p++}`)
        params.push(action)
      }
    }
    if (entity_type) {
      filtros.push(`a.entity_type = $${p++}`)
      params.push(entity_type)
    }
    if (user_id) {
      filtros.push(`a.user_id = $${p++}::uuid`)
      params.push(user_id)
    }
    if (desde) {
      filtros.push(`a.criado_em >= $${p++}::timestamptz`)
      params.push(desde)
    }

    const whereSql = `WHERE ${filtros.join(' AND ')}`

    return app.withTenant(req.user.tenant_id, async (db) => {
      const totalRes = await db.query(
        `SELECT COUNT(*)::bigint AS total FROM audit_log a ${whereSql}`,
        params,
      )
      const total = Number(totalRes.rows[0]?.total ?? 0)

      const limitParam = p++
      const offsetParam = p++
      const itensRes = await db.query(
        `SELECT
            a.id,
            a.tenant_id,
            a.user_id,
            a.action,
            a.entity_type,
            a.entity_id,
            a.metadata,
            a.ip,
            a.user_agent,
            a.criado_em,
            u.nome  AS autor_nome,
            u.email AS autor_email,
            u.papel AS autor_papel
           FROM audit_log a
           LEFT JOIN users u ON u.id = a.user_id
           ${whereSql}
          ORDER BY a.criado_em DESC
          LIMIT $${limitParam} OFFSET $${offsetParam}`,
        [...params, por_pagina, offset],
      )

      return {
        itens: itensRes.rows,
        total,
        pagina,
        por_pagina,
      }
    })
  })
}

export default auditLogRoutes
