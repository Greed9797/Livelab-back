// Rotas de integração com Appmax (gateway de pagamento).
// - POST /v1/webhooks/appmax/validate — endpoint de instalação (Appmax bate pra
//   confirmar que o app está instalado; precisa retornar 200 + app_id matching).
// - POST /v1/webhooks/appmax           — recebe eventos de pagamento.

import { validateWebhook } from '../services/appmax.js'

export async function appmaxRoutes(app) {
  // S-08-style: Appmax obrigatório em produção exige APPMAX_APP_ID
  if (process.env.NODE_ENV === 'production' && !process.env.APPMAX_APP_ID) {
    app.log.warn('[appmax] APPMAX_APP_ID ausente em produção — webhooks responderão 503')
  }

  // GET/POST /v1/webhooks/appmax/validate — Appmax bate aqui na instalação.
  // Aceita GET pra healthcheck rápido + POST com payload de validação.
  app.get('/v1/webhooks/appmax/validate', async (request, reply) => {
    const appId = process.env.APPMAX_APP_ID
    if (!appId) return reply.code(503).send({ error: 'APPMAX_APP_ID não configurado' })
    return reply.send({
      ok: true,
      app_id: appId,
      service: 'liveshop-saas-api',
    })
  })

  app.post('/v1/webhooks/appmax/validate', async (request, reply) => {
    const appId = process.env.APPMAX_APP_ID
    if (!appId) return reply.code(503).send({ error: 'APPMAX_APP_ID não configurado' })
    const payload = request.body ?? {}
    app.log.info({ payload }, '[appmax] validate hit')
    return reply.send({
      ok: true,
      app_id: appId,
      received: payload,
    })
  })

  // POST /v1/webhooks/appmax — recebe eventos de pagamento
  app.post('/v1/webhooks/appmax', async (request, reply) => {
    if (!process.env.APPMAX_APP_ID) {
      return reply.code(503).send({ error: 'Appmax não configurado' })
    }

    const payload = request.body ?? {}
    if (!validateWebhook(payload)) {
      app.log.warn({ payload }, '[appmax webhook] app_id inválido — rejeitando')
      return reply.code(401).send({ error: 'app_id inválido' })
    }

    const event = payload.event ?? payload.type ?? 'unknown'
    const data = payload.data ?? {}

    try {
      // Persiste evento bruto pra auditoria
      await app.db.query(
        `INSERT INTO webhook_eventos (tenant_id, source, event_type, payload_raw, boleto_id)
         VALUES ($1, 'appmax', $2, $3::jsonb, NULL)`,
        [null, event, JSON.stringify(payload)],
      )

      // Processa eventos de pagamento aprovado
      if (
        event === 'OrderPaid' ||
        event === 'OrderPaidByPix' ||
        event === 'OrderApproved' ||
        event === 'PaymentApproved'
      ) {
        // Tenta localizar boleto por: gateway_id (Appmax order/payment id) ou
        // referencia_externa (legacy), ou external_reference (sku do produto).
        const gatewayId = data.id ?? data.order_id ?? data.payment_id
        const externalRef = data.external_reference
          ?? data.cart?.external_reference
          ?? data.products?.[0]?.sku

        const candidates = []
        if (gatewayId) candidates.push(gatewayId.toString())
        if (externalRef) candidates.push(externalRef.toString())

        if (candidates.length === 0) {
          app.log.warn({ event, data }, '[appmax webhook] sem identificador de boleto')
          return reply.code(200).send({ received: true })
        }

        const lookup = await app.db.query(
          `SELECT id, tenant_id FROM boletos
           WHERE gateway_id = ANY($1::text[]) OR id::text = ANY($1::text[]) OR referencia_externa = ANY($1::text[])
           LIMIT 2`,
          [candidates],
        )

        if (lookup.rows.length === 1) {
          const { id: boletoId, tenant_id: boletoTenant } = lookup.rows[0]
          await app.db.query(
            `UPDATE boletos
             SET status = 'pago', pago_em = NOW(), gateway_id = COALESCE(gateway_id, $3)
             WHERE id = $1 AND tenant_id = $2 AND status != 'pago'`,
            [boletoId, boletoTenant, gatewayId ?? null],
          )
          app.log.info({ boletoId, gatewayId, event }, '[appmax webhook] boleto marcado como pago')
        } else if (lookup.rows.length > 1) {
          app.log.warn({ candidates }, '[appmax webhook] referência ambígua entre tenants — REJEITANDO')
          return reply.code(409).send({ error: 'Referência ambígua' })
        } else {
          app.log.warn({ candidates, gatewayId }, '[appmax webhook] referência não encontrada')
        }
      }
    } catch (err) {
      app.log.error({ err }, '[appmax webhook] erro processando evento')
    }

    return reply.code(200).send({ received: true })
  })
}
