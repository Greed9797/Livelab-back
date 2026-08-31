// Gestão das chaves de API (migration 138).
//
// Só papel administrativo entra aqui, e nunca por chave: uma chave que pudesse
// criar outra chave transformaria um vazamento em acesso permanente, e uma que
// pudesse se revogar transformaria um bot confuso em porta fechada. Por isso
// estas rotas ficam fora da allowlist do plugin de auth — quem administra chave
// é gente logada.

import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { hashDaChave } from '../plugins/auth.js'

const ADMIN = ['franqueador_master', 'franqueado', 'gerente']

const criarSchema = z.object({
  nome: z.string().min(1).max(120),
  // Sem data = chave sem vencimento. É o caso do bot que roda todo dia; quem
  // quiser uma chave temporária passa a data.
  expira_em: z.string().datetime().nullable().optional(),
})

// 32 bytes de aleatoriedade em base64url. O prefixo `llk_` serve para a chave
// ser reconhecível num log ou num campo de configuração — e para um scanner de
// segredo conseguir achá-la se ela vazar para um repositório.
function gerarChave() {
  const bruta = `llk_${randomBytes(32).toString('base64url')}`
  return { bruta, prefixo: bruta.slice(0, 12) }
}

export async function apiKeysRoutes(app) {
  const adminOnly = [app.authenticate, app.requirePapel(ADMIN)]

  app.get('/v1/api-keys', { preHandler: adminOnly }, async (request, reply) => {
    const { tenant_id } = request.user
    const db = await app.dbTenant(tenant_id)
    try {
      const { rows } = await db.query(
        `SELECT id, nome, prefixo, papel, criado_em, ultimo_uso, expira_em, revogada_em
           FROM api_keys
          WHERE tenant_id = $1::uuid
          ORDER BY criado_em DESC`,
        [tenant_id],
      )
      return reply.send({ items: rows })
    } finally {
      db.release()
    }
  })

  app.post('/v1/api-keys', { preHandler: adminOnly }, async (request, reply) => {
    const parsed = criarSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Payload inválido' })
    }
    const { tenant_id } = request.user
    const { bruta, prefixo } = gerarChave()

    const db = await app.dbTenant(tenant_id)
    try {
      const { rows } = await db.query(
        `INSERT INTO api_keys (tenant_id, nome, prefixo, key_hash, criado_por, expira_em)
         VALUES ($1::uuid, $2, $3, $4, $5, $6)
         RETURNING id, nome, prefixo, papel, criado_em, expira_em`,
        [
          tenant_id,
          parsed.data.nome,
          prefixo,
          hashDaChave(bruta),
          request.user.sub,
          parsed.data.expira_em ?? null,
        ],
      )
      const chave = rows[0]

      app.audit?.log?.(request, {
        action: 'api_key.create',
        entity_type: 'api_key',
        entity_id: chave.id,
        metadata: { nome: chave.nome, prefixo },
      })?.catch?.((err) => app.log.error({ err }, 'audit api_key.create falhou'))

      // `chave` sai aqui e não volta nunca: o banco só tem o hash. Perdeu, cria
      // outra e revoga esta.
      return reply.code(201).send({ ...chave, chave: bruta })
    } finally {
      db.release()
    }
  })

  app.post('/v1/api-keys/:id/revogar', { preHandler: adminOnly }, async (request, reply) => {
    const { tenant_id } = request.user
    const db = await app.dbTenant(tenant_id)
    try {
      const { rows } = await db.query(
        `UPDATE api_keys
            SET revogada_em = NOW()
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND revogada_em IS NULL
        RETURNING id, nome, prefixo, revogada_em`,
        [request.params.id, tenant_id],
      )
      if (rows.length === 0) {
        // Já revogada ou inexistente dão o mesmo 404: repetir a revogação não é
        // erro para quem chama, e a chave está fora do ar de todo jeito.
        return reply.code(404).send({ error: 'Chave não encontrada ou já revogada' })
      }

      app.audit?.log?.(request, {
        action: 'api_key.revoke',
        entity_type: 'api_key',
        entity_id: rows[0].id,
        metadata: { nome: rows[0].nome, prefixo: rows[0].prefixo },
      })?.catch?.((err) => app.log.error({ err }, 'audit api_key.revoke falhou'))

      return reply.send(rows[0])
    } finally {
      db.release()
    }
  })
}
