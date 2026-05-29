import { z } from 'zod'
import { notify } from '../services/mailer.js'

const READ_NOTIF = ['franqueador_master', 'franqueado', 'gerente', 'auditor', 'financeiro_readonly']
const TEST_NOTIF = ['franqueador_master', 'franqueado']

const querySchema = z.object({
  tipo: z.string().optional(),
  desde: z.string().optional(),
  pagina: z.coerce.number().int().positive().optional().default(1),
})

/**
 * Rotas de notificações
 * GET  /v1/notificacoes/log
 * POST /v1/configuracoes/notificacao-teste
 */
export async function notificacoesRoutes(app) {
  app.get('/v1/notificacoes/log', {
    preHandler: [app.authenticate, app.requirePapel(READ_NOTIF)],
  }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query ?? {})
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message })
    }

    const { tipo, desde, pagina } = parsed.data
    const pageSize = 20
    const offset = (pagina - 1) * pageSize
    const { tenant_id } = request.user

    return app.withTenant(tenant_id, async (db) => {
      const conds = ['tenant_id = $1::uuid']
      const params = [tenant_id]
      let idx = 2

      if (tipo) {
        conds.push(`tipo = $${idx++}`)
        params.push(tipo)
      }
      if (desde) {
        conds.push(`criado_em >= $${idx++}::timestamptz`)
        params.push(desde)
      }

      const where = conds.join(' AND ')

      const totalQ = await db.query(
        `SELECT COUNT(*)::int AS total FROM notification_log WHERE ${where}`,
        params,
      )
      const total = totalQ.rows[0]?.total ?? 0

      const itensQ = await db.query(
        `SELECT id, tipo, ref_id, destinatario, assunto, enviado_em, erro, criado_em
         FROM notification_log
         WHERE ${where}
         ORDER BY criado_em DESC
         LIMIT ${pageSize} OFFSET ${offset}`,
        params,
      )

      return reply.send({
        itens: itensQ.rows,
        total,
        pagina,
        page_size: pageSize,
      })
    })
  })

  // Endpoint de teste — útil pra confirmar config Resend.
  app.post('/v1/configuracoes/notificacao-teste', {
    preHandler: [app.authenticate, app.requirePapel(TEST_NOTIF)],
  }, async (request, reply) => {
    const { tenant_id } = request.user

    const tenantQ = await app.db.query(
      `SELECT email_contato, nome, notif_email_ativo
       FROM tenants WHERE id = $1`,
      [tenant_id],
    )
    const tenant = tenantQ.rows[0]
    if (!tenant?.email_contato) {
      return reply.code(400).send({
        error: 'Cadastre um e-mail de contato em Configurações antes de testar.',
      })
    }

    const result = await notify({
      app,
      tenantId: tenant_id,
      to: tenant.email_contato,
      template: 'live_encerrada',
      settings: { notif_email_ativo: tenant.notif_email_ativo, notif_live_meta: true },
      settingsKey: 'notif_live_meta',
      vars: {
        gmv: 9999.9,
        qtd_pedidos: 42,
        viewers: 1234,
        duracao: '01:30:00',
      },
    })

    if (result.skipped) {
      return reply.code(200).send({
        ok: false,
        skipped: true,
        message: result.error ?? 'Envio pulado (sem RESEND_API_KEY ou flag desabilitada).',
      })
    }
    if (!result.ok) {
      return reply.code(502).send({ ok: false, error: result.error ?? 'Falha no envio.' })
    }
    return reply.send({ ok: true, message: `E-mail de teste enviado para ${tenant.email_contato}.` })
  })
}
