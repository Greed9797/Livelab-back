import { z } from 'zod'
import { READ_CLIENTES, WRITE_CLIENTES } from '../config/role_groups.js'

/**
 * Briefing do cliente — documento único (1:1) de texto rico em Markdown.
 * Preenchido e lido pelo time interno na tela Comercial. O cliente final
 * (cliente_parceiro) NÃO vê.
 *
 * Endpoints:
 *   GET /v1/clientes/:clienteId/briefing  -> row do briefing ou null
 *   PUT /v1/clientes/:clienteId/briefing  -> upsert (cria ou sobrescreve)
 *
 * Permissões: leitura = READ_CLIENTES; escrita = WRITE_CLIENTES.
 * RLS por tenant garantido via policies da migration 124.
 */

const briefingSchema = z.object({
  // Markdown puro. String vazia permitida (limpar o briefing).
  conteudo: z.string().max(20000, 'Briefing muito longo (máx 20000 caracteres)'),
})

export async function clienteBriefingRoutes(app) {
  const readAccess = [app.authenticate, app.requirePapel(READ_CLIENTES)]
  const writeAccess = [app.authenticate, app.requirePapel(WRITE_CLIENTES)]

  // GET — briefing do cliente (null se ainda não existe)
  app.get('/v1/clientes/:clienteId/briefing', { onRequest: readAccess }, async (req) => {
    const { tenant_id } = req.user
    return app.withTenant(tenant_id, async (db) => {
      const { rows } = await db.query(
        `SELECT id, cliente_id, conteudo, atualizado_por_id, atualizado_por_nome,
                criado_em, atualizado_em
           FROM cliente_briefing
          WHERE cliente_id = $1::uuid
            AND tenant_id = $2::uuid`,
        [req.params.clienteId, tenant_id],
      )
      return rows[0] ?? null
    })
  })

  // PUT — cria ou sobrescreve (upsert) o briefing do cliente
  app.put('/v1/clientes/:clienteId/briefing', { onRequest: writeAccess }, async (req, reply) => {
    const parsed = briefingSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id, sub: autorId, nome: autorNome } = req.user
    return app.withTenant(tenant_id, async (db) => {
      // Validar que cliente existe e é do tenant (defesa em profundidade)
      const cliente = await db.query(
        `SELECT id FROM clientes WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [req.params.clienteId, tenant_id],
      )
      if (cliente.rows.length === 0) {
        return reply.code(404).send({ error: 'Cliente não encontrado' })
      }

      const { rows } = await db.query(
        `INSERT INTO cliente_briefing
           (tenant_id, cliente_id, conteudo, atualizado_por_id, atualizado_por_nome)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5)
         ON CONFLICT (cliente_id) DO UPDATE SET
           conteudo            = EXCLUDED.conteudo,
           atualizado_por_id   = EXCLUDED.atualizado_por_id,
           atualizado_por_nome = EXCLUDED.atualizado_por_nome,
           atualizado_em       = NOW()
         RETURNING id, cliente_id, conteudo, atualizado_por_id, atualizado_por_nome,
                   criado_em, atualizado_em`,
        [tenant_id, req.params.clienteId, parsed.data.conteudo, autorId, autorNome ?? 'Usuário'],
      )
      app.audit?.log?.(req, { action: 'cliente_briefing.save', entity_type: 'cliente_briefing', entity_id: rows[0].id, metadata: { cliente_id: req.params.clienteId } })?.catch(err => app.log.error({ err }, 'audit log failed'))
      return rows[0]
    })
  })
}
