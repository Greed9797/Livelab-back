import crypto from 'node:crypto'
import { validarWebhookToken } from '../services/asaas.js'

export async function boletosRoutes(app) {
  const boletoAccess = [
    app.authenticate,
    app.requirePapel(['franqueador_master', 'franqueado', 'gerente', 'cliente_parceiro']),
  ]
  
  // GET /v1/boletos/alertas
  app.get('/v1/boletos/alertas', { preHandler: boletoAccess }, async (request) => {
    const { tenant_id, sub: user_id, papel } = request.user
    const db = await app.dbTenant(tenant_id)
    
    try {
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
        SELECT id, valor, vencimento, asaas_url, asaas_pix_copia_cola
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

    } finally {
      db.release()
    }
  })

  // PATCH /v1/boletos/:id/visto
  app.patch('/v1/boletos/:id/visto', { preHandler: boletoAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    const db = await app.dbTenant(tenant_id)
    
    try {
      const res = await db.query(
        `UPDATE boletos SET notificado_em = NOW() WHERE id = $1 AND tenant_id = $2`,
        [request.params.id, tenant_id]
      )
      if (res.rowCount === 0) return reply.code(404).send({ error: 'Boleto não encontrado' })
      return { ok: true }
    } finally {
      db.release()
    }
  })
// GET /v1/boletos
  app.get('/v1/boletos', { preHandler: boletoAccess }, async (request) => {
    const { tenant_id } = request.user
    const db = await app.dbTenant(tenant_id)
    try {
      const result = await db.query(
        `SELECT id, tipo, valor, vencimento, status, pago_em, referencia_externa, competencia,
                asaas_id, asaas_url, asaas_pix_copia_cola, gerado_automaticamente, asaas_error
         FROM boletos ORDER BY vencimento DESC`
      )
      return result.rows.map(b => ({ ...b, valor: Number(b.valor ?? 0) }))
    } finally {
      db.release()
    }
  })

  // GET /v1/boletos/:id
  app.get('/v1/boletos/:id', { preHandler: boletoAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    const db = await app.dbTenant(tenant_id)
    try {
      const result = await db.query(
        `SELECT * FROM boletos WHERE id = $1`, [request.params.id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Boleto não encontrado' })
      return { ...result.rows[0], url_boleto: `https://sandbox.pagar.me/boletos/${result.rows[0].referencia_externa ?? result.rows[0].id}` }
    } finally {
      db.release()
    }
  })

  // PATCH /v1/boletos/:id/pagar (dev manual)
  app.patch('/v1/boletos/:id/pagar', { preHandler: app.requirePapel(['franqueado', 'gerente']) }, async (request, reply) => {
    const { tenant_id } = request.user
    const db = await app.dbTenant(tenant_id)
    try {
      const result = await db.query(
        `UPDATE boletos SET status = 'pago', pago_em = NOW()
         WHERE id = $1 AND status != 'pago' RETURNING id, status, pago_em`,
        [request.params.id]
      )
      if (!result.rows[0]) return reply.code(400).send({ error: 'Boleto não encontrado ou já pago' })
      return result.rows[0]
    } finally {
      db.release()
    }
  })

  // POST /v1/webhooks/pagamento (Pagar.me webhook)
  app.post('/v1/webhooks/pagamento', async (request, reply) => {
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

    if (status === 'paid') {
      // Lookup tenant_id da referência primeiro pra defesa em profundidade.
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
      await app.db.query(
        `UPDATE boletos SET status = 'pago', pago_em = NOW()
         WHERE id = $1 AND tenant_id = $2 AND status != 'pago'`,
        [boletoId, boletoTenant]
      )
    }
    return { received: true }
  })

  // POST /v1/webhooks/asaas — seguro por token no header
  app.post('/v1/webhooks/asaas', async (request, reply) => {
    const receivedToken = request.headers['asaas-access-token']

    try {
      validarWebhookToken(receivedToken)
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const payload = request.body ?? {}
    const eventType = payload.event ?? 'UNKNOWN'   // Fix D: default if absent
    const payment = payload.payment

    let boletoId = null
    let tenantId = null

    if (payment?.externalReference) {
      const { rows } = await app.db.query(
        `SELECT id, tenant_id FROM boletos WHERE id = $1`,
        [payment.externalReference]
      )
      if (rows.length > 0) {
        boletoId = rows[0].id
        tenantId = rows[0].tenant_id
      } else {
        app.log.warn({ externalReference: payment.externalReference }, 'webhook asaas: externalReference não encontrado em boletos')
      }
    }

    try {
      await app.db.query(
        `INSERT INTO webhook_eventos (tenant_id, source, event_type, payload_raw, boleto_id)
         VALUES ($1, 'asaas', $2, $3::jsonb, $4)`,
        [tenantId, eventType, JSON.stringify(payload), boletoId]
      )

      if (eventType === 'PAYMENT_RECEIVED' && boletoId && payment?.id && tenantId) {
        await app.db.query(
          `UPDATE boletos
           SET status = 'pago', pago_em = NOW(), asaas_id = $3
           WHERE id = $1 AND tenant_id = $2 AND status != 'pago'`,
          [boletoId, tenantId, payment.id]
        )
      }
    } catch (err) {
      app.log.error({ err }, 'webhook asaas: erro ao processar evento no banco')
    }

    return reply.code(200).send({ received: true })
  })
}
