import crypto from 'node:crypto'
import { READ_BOLETOS, WRITE_BOLETOS } from '../config/role_groups.js'

export async function boletosRoutes(app) {
  const boletoAccess = [
    app.authenticate,
    app.requirePapel(READ_BOLETOS),
  ]
  
  // GET /v1/boletos/alertas
  app.get('/v1/boletos/alertas', { preHandler: boletoAccess }, async (request) => {
    const { tenant_id, sub: user_id, papel } = request.user
    return app.withTenant(tenant_id, async (db) => {
      let extraFilter = ''
      const values = [tenant_id]

      if (papel === 'cliente_parceiro') {
        const userQ = await db.query('SELECT email FROM users WHERE id = $1', [user_id])
        const email = userQ.rows[0]?.email
        const clienteQ = await db.query('SELECT id FROM clientes WHERE email = $1', [email])
        const clienteId = clienteQ.rows[0]?.id
        
        if (clienteId) {
          extraFilter = 'AND cliente_id = $2'
          values.push(clienteId)
        } else {
          return null // Cliente parceiro sem cliente vinculado
        }
      }

      // Busca um boleto criado nos ultimos 3 dias e nao notificado
      const q = `
        SELECT id, valor, vencimento, gateway_url, gateway_pix_copia_cola
        FROM boletos 
        WHERE tenant_id = $1 
          AND status = 'pendente' 
          AND notificado_em IS NULL 
          AND criado_em > NOW() - INTERVAL '3 days'
          ${extraFilter}
        ORDER BY criado_em DESC
        LIMIT 1
      `

      const res = await db.query(q, values)
      const alerta = res.rows[0]
      if (alerta) alerta.valor = Number(alerta.valor ?? 0)
      return alerta || null

    })
  })

  // PATCH /v1/boletos/:id/visto
  app.patch('/v1/boletos/:id/visto', { preHandler: boletoAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const res = await db.query(
        `UPDATE boletos SET notificado_em = NOW() WHERE id = $1 AND tenant_id = $2`,
        [request.params.id, tenant_id]
      )
      if (res.rowCount === 0) return reply.code(404).send({ error: 'Boleto não encontrado' })
      return { ok: true }
    })
  })
// GET /v1/boletos
  app.get('/v1/boletos', { preHandler: boletoAccess }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT id, tipo, valor, vencimento, status, pago_em, referencia_externa, competencia,
                gateway_id, gateway_url, gateway_pix_copia_cola, gateway_provider,
                gerado_automaticamente, gateway_error
         FROM boletos
         WHERE tenant_id = $1::uuid
         ORDER BY vencimento DESC`,
        [tenant_id]
      )
      return result.rows.map(b => ({ ...b, valor: Number(b.valor ?? 0) }))
    })
  })

  // GET /v1/boletos/:id
  app.get('/v1/boletos/:id', { preHandler: boletoAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT * FROM boletos WHERE id = $1 AND tenant_id = $2::uuid`,
        [request.params.id, tenant_id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Boleto não encontrado' })
      return { ...result.rows[0], url_boleto: `https://sandbox.pagar.me/boletos/${result.rows[0].referencia_externa ?? result.rows[0].id}` }
    })
  })

  // PATCH /v1/boletos/:id/pagar (dev manual)
  app.patch('/v1/boletos/:id/pagar', { preHandler: app.requirePapel(WRITE_BOLETOS) }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE boletos SET status = 'pago', pago_em = NOW()
         WHERE id = $1 AND tenant_id = $2::uuid AND status != 'pago'
         RETURNING id, status, pago_em`,
        [request.params.id, tenant_id]
      )
      if (!result.rows[0]) return reply.code(400).send({ error: 'Boleto não encontrado ou já pago' })
      return result.rows[0]
    })
  })

  // POST /v1/webhooks/pagamento (Pagar.me webhook)
  // Rate limit individual: webhooks legítimos chegam < 5/min; 30 é folga
  app.post('/v1/webhooks/pagamento', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    // Validar token secreto enviado no header pelo Pagar.me
    const receivedToken = request.headers['x-webhook-token']
    const expectedToken = process.env.PAGAMENTO_WEBHOOK_TOKEN ?? ''
    if (!expectedToken || expectedToken.length < 16) {
      return reply.code(500).send({ error: 'Webhook token não configurado' })
    }
    if (!receivedToken || receivedToken.length !== expectedToken.length) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    const a = Buffer.from(receivedToken)
    const b = Buffer.from(expectedToken)
    if (!crypto.timingSafeEqual(a, b)) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const { id, status } = request.body ?? {}
    if (!id || !status) return reply.code(400).send({ error: 'Payload inválido' })

    // Replay protection (opt-in via env). Identifica evento por id + status pra
    // permitir transições legítimas (pendente→pago não é replay) mas bloquear
    // duplicação exata de payload.
    if (process.env.WEBHOOK_REPLAY_PROTECTION === 'true') {
      const body = request.body ?? {}
      const nonceBase =
        body.event_id ??
        body.notification_id ??
        `${id}:${status}:${body.occurred_at ?? body.event_date ?? ''}`
      const nonce = nonceBase.length > 200
        ? crypto.createHash('sha256').update(nonceBase).digest('hex')
        : String(nonceBase).slice(0, 200)
      try {
        const inserted = await app.db.query(
          `INSERT INTO webhook_replay_log (source, nonce)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING
           RETURNING nonce`,
          ['pagarme', nonce],
        )
        if (inserted.rowCount === 0) {
          request.log.warn({ nonce }, '[webhook pagamento] replay bloqueado')
          return reply.code(200).send({ received: true, replay: true })
        }
      } catch (err) {
        app.log.error({ err }, '[webhook pagamento] replay log insert failed')
        return reply.code(503).send({ error: 'replay_log_unavailable' })
      }
    }

    if (status === 'paid') {
      // Lookup precisa cross-tenant pra detectar colisão de referência externa
      // (PK do gateway pode bater entre tenants). Defesa em profundidade.
      const lookup = await app.db.query(
        `SELECT id, tenant_id FROM boletos WHERE referencia_externa = $1 LIMIT 2`,
        [id]
      )
      if (lookup.rows.length === 0) {
        app.log.warn({ ref: id }, '[webhook pagamento] referência inexistente')
        return reply.code(404).send({ error: 'Boleto não encontrado' })
      }
      if (lookup.rows.length > 1) {
        app.log.warn({ ref: id, count: lookup.rows.length }, '[webhook pagamento] referência colide entre tenants — REJEITANDO')
        return reply.code(409).send({ error: 'Referência ambígua entre tenants' })
      }
      const { id: boletoId, tenant_id: boletoTenant } = lookup.rows[0]
      // UPDATE via dbTenant para ativar RLS (defesa em profundidade extra
      // sobre o filtro explícito tenant_id = $2).
      await app.withTenant(boletoTenant, async (db) => {
        await db.query(
          `UPDATE boletos SET status = 'pago', pago_em = NOW()
           WHERE id = $1 AND tenant_id = $2 AND status != 'pago'`,
          [boletoId, boletoTenant]
        )
      })
    }
    return { received: true }
  })

  // POST /v1/webhooks/asaas — DEPRECATED. Asaas substituído por Appmax.
  // Mantido pra responder 410 Gone caso webhook antigo ainda dispare.
  app.post('/v1/webhooks/asaas', async (_, reply) => {
    return reply.code(410).send({ error: 'Webhook Asaas removido. Use /v1/webhooks/appmax.' })
  })
}
