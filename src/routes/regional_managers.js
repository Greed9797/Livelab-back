// Endpoints administrativos para gerenciar acesso de gerente_regional
// (papel Tier 4, multi-tenant). Apenas franqueador_master pode operar aqui.
//
// - GET    /v1/master/regional-managers           → lista users + N unidades
// - POST   /v1/master/regional-managers/:userId/tenants  → substitui set
// - DELETE /v1/master/regional-managers/:userId/tenants/:tenantId
//
// Toda escrita também grava em audit_log (best-effort).

import { z } from 'zod'

const masterOnly = (app) => ({
  onRequest: [app.authenticate, app.requirePapel(['franqueador_master'])],
})

const tenantIdsSchema = z.object({
  tenant_ids: z.array(z.string().uuid()).max(500),
})

export async function regionalManagersRoutes(app) {
  // GET — lista todos gerente_regional + qtd de unidades atribuídas + nomes.
  app.get('/v1/master/regional-managers', masterOnly(app), async (request, reply) => {
    try {
      const { rows } = await app.db.query(
        `
          SELECT
            u.id,
            u.nome,
            u.email,
            u.ativo,
            u.criado_em AS created_at,
            COALESCE(
              (
                SELECT json_agg(
                  json_build_object('id', t.id, 'nome', t.nome)
                  ORDER BY t.nome
                )
                FROM user_tenant_access uta
                JOIN tenants t ON t.id = uta.tenant_id
                WHERE uta.user_id = u.id
              ),
              '[]'::json
            ) AS tenants
          FROM users u
          WHERE u.papel = 'gerente_regional'
          ORDER BY u.ativo DESC, u.nome ASC
        `
      )
      return reply.send(
        rows.map((row) => ({
          id: row.id,
          nome: row.nome,
          email: row.email,
          ativo: row.ativo,
          created_at: row.created_at,
          tenants: row.tenants ?? [],
          tenants_count: Array.isArray(row.tenants) ? row.tenants.length : 0,
        }))
      )
    } catch (err) {
      request.log.error({ err }, 'master/regional-managers/list: erro')
      throw err
    }
  })

  // POST — substitui completamente o set de acesso do user (transacional).
  // Body: { tenant_ids: string[] }
  app.post(
    '/v1/master/regional-managers/:userId/tenants',
    masterOnly(app),
    async (request, reply) => {
      const { userId } = request.params
      if (!userId || typeof userId !== 'string' || userId.length < 8) {
        return reply.code(400).send({ error: 'userId inválido' })
      }

      const parsed = tenantIdsSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'Body inválido',
          details: parsed.error.issues,
        })
      }
      const tenantIds = Array.from(new Set(parsed.data.tenant_ids))
      const masterId = request.user.sub ?? request.user.id

      // Defesa anti-IDOR: master não pode atribuir acesso pra si mesmo.
      if (userId === masterId) {
        return reply.code(400).send({ error: 'Master não pode atribuir acesso pra si mesmo' })
      }

      const client = await app.db.pool.connect()
      try {
        await client.query('BEGIN')

        // Confirma que o user-alvo existe e tem papel correto.
        const userRes = await client.query(
          `SELECT id, papel FROM users WHERE id = $1::uuid LIMIT 1`,
          [userId]
        )
        if (userRes.rows.length === 0) {
          await client.query('ROLLBACK')
          return reply.code(404).send({ error: 'Usuário não encontrado' })
        }
        if (userRes.rows[0].papel !== 'gerente_regional') {
          await client.query('ROLLBACK')
          return reply
            .code(400)
            .send({ error: 'Usuário não é gerente_regional' })
        }

        // Confirma que todos os tenant_ids existem.
        if (tenantIds.length > 0) {
          const checkRes = await client.query(
            `SELECT id FROM tenants WHERE id = ANY($1::uuid[])`,
            [tenantIds]
          )
          if (checkRes.rows.length !== tenantIds.length) {
            await client.query('ROLLBACK')
            return reply
              .code(400)
              .send({ error: 'Um ou mais tenant_ids são inválidos' })
          }
        }

        // Substituição atômica: deleta tudo + reinsere.
        await client.query(
          `DELETE FROM user_tenant_access WHERE user_id = $1::uuid`,
          [userId]
        )
        if (tenantIds.length > 0) {
          await client.query(
            `
              INSERT INTO user_tenant_access (user_id, tenant_id, concedido_por)
              SELECT $1::uuid, t, $2::uuid FROM unnest($3::uuid[]) AS t
            `,
            [userId, masterId, tenantIds]
          )
        }
        await client.query('COMMIT')

        // audit log best-effort (não bloqueia se tabela não existir).
        if (typeof app.auditLog === 'function') {
          await app
            .auditLog({
              action: 'regional_manager.set_tenants',
              actor_id: masterId,
              entity_type: 'user',
              entity_id: userId,
              metadata: { tenant_count: tenantIds.length },
            })
            .catch(() => {})
        }

        return reply.send({
          ok: true,
          user_id: userId,
          tenants_count: tenantIds.length,
        })
      } catch (err) {
        try {
          await client.query('ROLLBACK')
        } catch {}
        request.log.error({ err }, 'master/regional-managers/set: erro')
        throw err
      } finally {
        client.release()
      }
    }
  )

  // DELETE — revoga acesso pontual a uma única unidade.
  app.delete(
    '/v1/master/regional-managers/:userId/tenants/:tenantId',
    masterOnly(app),
    async (request, reply) => {
      const { userId, tenantId } = request.params
      if (!userId || !tenantId) {
        return reply.code(400).send({ error: 'userId e tenantId obrigatórios' })
      }

      try {
        const result = await app.db.query(
          `
            DELETE FROM user_tenant_access
            WHERE user_id = $1::uuid AND tenant_id = $2::uuid
            RETURNING id
          `,
          [userId, tenantId]
        )

        if (result.rowCount === 0) {
          return reply.code(404).send({ error: 'Acesso não encontrado' })
        }

        if (typeof app.auditLog === 'function') {
          await app
            .auditLog({
              action: 'regional_manager.revoke_tenant',
              actor_id: request.user.sub ?? request.user.id,
              entity_type: 'user',
              entity_id: userId,
              metadata: { tenant_id: tenantId },
            })
            .catch(() => {})
        }

        return reply.send({ ok: true })
      } catch (err) {
        request.log.error({ err }, 'master/regional-managers/revoke: erro')
        throw err
      }
    }
  )
}
