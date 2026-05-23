// Rotas de integração com Appmax (gateway de pagamento).
// - POST /v1/webhooks/appmax/validate — endpoint de instalação (Appmax bate pra
//   confirmar que o app está instalado; precisa retornar 200 + app_id matching).
// - POST /v1/webhooks/appmax           — recebe eventos de pagamento.

import crypto from 'node:crypto'
import { validateWebhook, validarWebhookToken } from '../services/appmax.js'
import { notify } from '../services/mailer.js'

// Extrai um identificador único do payload pra prevenir replay.
// Tenta usar IDs nativos do Appmax; fallback pra hash SHA256 do payload completo.
function appmaxEventNonce(payload) {
  const data = payload?.data ?? {}
  const id =
    payload?.id ??
    payload?.event_id ??
    payload?.notification_id ??
    data.id ??
    data.payment_id ??
    data.order_id
  if (id) return String(id).slice(0, 200)
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

// Retorna o external_id estável da instalação Appmax. Idempotente por identidade
// (app_id + client_id + external_key): mesma instalação → mesmo external_id.
async function resolveAppmaxExternalId(db, { appId, clientId, clientSecret, externalKey }) {
  const cid = clientId ?? ''
  const ekey = externalKey ?? ''

  const existing = await db.query(
    `SELECT external_id FROM appmax_installations
      WHERE app_id = $1 AND COALESCE(client_id,'') = $2 AND COALESCE(external_key,'') = $3
      LIMIT 1`,
    [appId, cid, ekey],
  )
  if (existing.rows[0]) {
    // Atualiza client_secret (pode ter rotacionado) sem mudar o external_id.
    await db.query(
      `UPDATE appmax_installations SET client_secret = $4, atualizado_em = NOW()
        WHERE app_id = $1 AND COALESCE(client_id,'') = $2 AND COALESCE(external_key,'') = $3`,
      [appId, cid, ekey, clientSecret],
    )
    return existing.rows[0].external_id
  }

  try {
    const inserted = await db.query(
      `INSERT INTO appmax_installations (app_id, client_id, client_secret, external_key)
       VALUES ($1, $2, $3, $4)
       RETURNING external_id`,
      [appId, clientId, clientSecret, externalKey],
    )
    return inserted.rows[0].external_id
  } catch (err) {
    if (err?.code === '23505') {
      const retry = await db.query(
        `SELECT external_id FROM appmax_installations
          WHERE app_id = $1 AND COALESCE(client_id,'') = $2 AND COALESCE(external_key,'') = $3
          LIMIT 1`,
        [appId, cid, ekey],
      )
      if (retry.rows[0]) return retry.rows[0].external_id
    }
    throw err
  }
}

function appmaxWebhookToken(request) {
  return request.headers['x-appmax-signature']
    ?? request.headers['appmax-signature']
    ?? request.headers['x-appmax-token']
    ?? request.headers['x-webhook-token']
}

export async function appmaxRoutes(app) {
  // S-08-style: Appmax obrigatório em produção exige APPMAX_APP_ID
  if (process.env.NODE_ENV === 'production' && !process.env.APPMAX_APP_ID) {
    app.log.warn('[appmax] APPMAX_APP_ID ausente em produção — webhooks responderão 503')
  }
  if (process.env.NODE_ENV === 'production' && process.env.APPMAX_APP_ID && !process.env.APPMAX_WEBHOOK_SECRET) {
    app.log.warn('[appmax] APPMAX_WEBHOOK_SECRET ausente em produção — webhooks responderão 503')
  }

  // GET/POST /v1/webhooks/appmax/validate — Appmax bate aqui na instalação.
  // Aceita GET pra healthcheck rápido + POST com payload de validação.
  // GET — healthcheck simples (Appmax usa POST para validar a instalação).
  app.get('/v1/webhooks/appmax/validate', async (request, reply) => {
    const appId = process.env.APPMAX_APP_ID
    if (!appId) return reply.code(503).send({ error: 'APPMAX_APP_ID não configurado' })
    return reply.send({ ok: true, app_id: appId, service: 'liveshop-saas-api' })
  })

  // POST — validação de instalação. Appmax envia
  // { app_id, client_id, client_secret, external_key } e espera 200 + { external_id }
  // ÚNICO e ESTÁVEL por instalação (mesma identidade → mesmo external_id).
  app.post('/v1/webhooks/appmax/validate', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const envAppId = process.env.APPMAX_APP_ID
    if (!envAppId) return reply.code(503).send({ error: 'APPMAX_APP_ID não configurado' })

    const body = request.body ?? {}
    // Rejeita app_id divergente do nosso app cadastrado.
    if (body.app_id != null && String(body.app_id) !== String(envAppId)) {
      app.log.warn({ recebido: body.app_id }, '[appmax] validate: app_id divergente')
      return reply.code(401).send({ error: 'app_id inválido' })
    }

    const appId = String(body.app_id ?? envAppId)
    const clientId = body.client_id != null ? String(body.client_id) : null
    const clientSecret = body.client_secret != null ? String(body.client_secret) : null
    const externalKey = body.external_key != null ? String(body.external_key) : null

    // Appmax exige external_id FIXO do app (não por instalação). Vem de APPMAX_EXTERNAL_ID.
    const fixedExternalId = process.env.APPMAX_EXTERNAL_ID
    if (!fixedExternalId) return reply.code(503).send({ error: 'APPMAX_EXTERNAL_ID não configurado' })

    // Persiste a instalação pra auditoria (best-effort, não bloqueia a resposta).
    resolveAppmaxExternalId(app.db, { appId, clientId, clientSecret, externalKey })
      .catch((err) => app.log.error({ err }, '[appmax] validate: falha ao registrar instalação (auditoria)'))

    app.log.info({ appId, clientId, externalKey }, '[appmax] validate ok')
    return reply.code(200).send({ external_id: fixedExternalId })
  })

  // POST /v1/webhooks/appmax — recebe eventos de pagamento
  app.post('/v1/webhooks/appmax', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!process.env.APPMAX_APP_ID) {
      return reply.code(503).send({ error: 'Appmax não configurado' })
    }
    if (process.env.NODE_ENV === 'production' && !process.env.APPMAX_WEBHOOK_SECRET) {
      return reply.code(503).send({ error: 'APPMAX_WEBHOOK_SECRET não configurado' })
    }

    const payload = request.body ?? {}
    if (!validateWebhook(payload)) {
      app.log.warn('[appmax webhook] app_id inválido — rejeitando')
      // Audit log: falha de validação (sem PII)
      app.audit?.log?.(request, {
        action: 'webhook_received',
        entity_type: 'appmax',
        entity_id: null,
        metadata: {
          event_type: payload.event ?? payload.type ?? 'unknown',
          status: 'rejected_invalid_app_id',
        },
      })?.catch(() => {})
      return reply.code(401).send({ error: 'app_id inválido' })
    }

    try {
      // Defesa em profundidade: quando APPMAX_WEBHOOK_SECRET estiver configurado,
      // o webhook público precisa provar posse do token sem depender só do app_id no payload.
      validarWebhookToken(appmaxWebhookToken(request))
    } catch {
      app.log.warn('[appmax webhook] token inválido — rejeitando')
      // Audit log: falha de token (sem PII)
      app.audit?.log?.(request, {
        action: 'webhook_received',
        entity_type: 'appmax',
        entity_id: null,
        metadata: {
          event_type: payload.event ?? payload.type ?? 'unknown',
          status: 'rejected_invalid_token',
        },
      })?.catch(() => {})
      return reply.code(401).send({ error: 'Token de webhook Appmax inválido' })
    }

    // Replay protection (opt-in via env). Idempotência via tabela webhook_replay_log
    // com PK (source, nonce). Ataque de replay retorna 200 + replay:true sem reprocessar.
    if (process.env.WEBHOOK_REPLAY_PROTECTION === 'true') {
      const nonce = appmaxEventNonce(payload)
      try {
        const inserted = await app.db.query(
          `INSERT INTO webhook_replay_log (source, nonce)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING
           RETURNING nonce`,
          ['appmax', nonce],
        )
        if (inserted.rowCount === 0) {
          request.log.warn({ nonce }, '[appmax webhook] replay bloqueado')
          // Audit log: replay bloqueado (sem PII)
          app.audit?.log?.(request, {
            action: 'webhook_received',
            entity_type: 'appmax',
            entity_id: null,
            metadata: {
              event_type: payload.event ?? payload.type ?? 'unknown',
              status: 'blocked_replay',
            },
          })?.catch(() => {})
          return reply.code(200).send({ received: true, replay: true })
        }
      } catch (err) {
        app.log.error({ err }, '[appmax webhook] replay log insert failed')
        return reply.code(503).send({ error: 'replay_log_unavailable' })
      }
    }

    const event = payload.event ?? payload.type ?? 'unknown'
    const data = payload.data ?? {}

    // Extrai ID do evento de forma segura (sem PII)
    const eventId = payload?.id?.toString() || payload?.event_id?.toString() || null

    try {
      // Persiste evento bruto pra auditoria
      await app.db.query(
        `INSERT INTO webhook_eventos (tenant_id, source, event_type, payload_raw, boleto_id)
         VALUES ($1, 'appmax', $2, $3::jsonb, NULL)`,
        [null, event, JSON.stringify(payload)],
      )

      // Audit log sanitizado (sem PII: nome, cpf, email, card, telefone)
      app.audit?.log?.(request, {
        action: 'webhook_received',
        entity_type: 'appmax',
        entity_id: eventId,
        metadata: {
          event_type: event,
          status: 'received',
        },
      })?.catch(() => {})

      // Processa eventos de pagamento aprovado
      if (
        event === 'OrderPaid' ||
        event === 'OrderPaidByPix' ||
        event === 'OrderApproved' ||
        event === 'PaymentApproved'
      ) {
        // Será auditado depois no processamento specific
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
          // Audit log: evento sem identificador (sem PII)
          app.audit?.log?.(request, {
            action: 'webhook_received',
            entity_type: 'appmax',
            entity_id: eventId,
            metadata: {
              event_type: event,
              status: 'missing_identifier',
            },
          })?.catch(() => {})
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
          // UPDATE via withTenant para ativar RLS (defesa em profundidade extra
          // sobre o filtro explícito tenant_id = $2). Necessário quando a role
          // do app for NOBYPASSRLS (P0 hardening).
          await app.withTenant(boletoTenant, async (db) => {
            const updated = await db.query(
              `UPDATE boletos
               SET status = 'pago', pago_em = NOW(), gateway_id = COALESCE(gateway_id, $3)
               WHERE id = $1 AND tenant_id = $2 AND status != 'pago'
               RETURNING id, valor, vencimento, pago_em, cliente_id`,
              [boletoId, boletoTenant, gatewayId ?? null],
            )
            if (updated.rows[0]) {
              const boleto = updated.rows[0]
              // Busca e-mail do cliente (fire-and-forget)
              db.query(
                `SELECT cl.nome, cl.email FROM clientes cl WHERE cl.id = $1`,
                [boleto.cliente_id]
              ).then(({ rows }) => {
                const cliente = rows[0]
                if (cliente?.email) {
                  notify({
                    app, tenantId: boletoTenant, to: cliente.email,
                    template: 'boleto_pago', refId: boletoId,
                    dedupe: true,
                    vars: {
                      cliente_nome: cliente.nome,
                      valor: boleto.valor,
                      vencimento: boleto.vencimento,
                      pago_em: boleto.pago_em,
                    },
                  }).catch(err => app.log.error({ err }, 'mailer boleto_pago failed'))
                }
              }).catch(err => app.log.error({ err }, 'mailer boleto_pago: lookup cliente failed'))
            }
          })
          app.log.info({ boletoId, gatewayId, event }, '[appmax webhook] boleto marcado como pago')
          // Audit log: boleto processado com sucesso (sem PII)
          app.audit?.log?.(request, {
            action: 'webhook_received',
            entity_type: 'appmax',
            entity_id: eventId,
            metadata: {
              event_type: event,
              status: 'processed_payment_approved',
              boleto_id: boletoId.toString(),
            },
          })?.catch(() => {})
        } else if (lookup.rows.length > 1) {
          app.log.warn({ candidates }, '[appmax webhook] referência ambígua entre tenants — REJEITANDO')
          // Audit log: referência ambígua (sem PII)
          app.audit?.log?.(request, {
            action: 'webhook_received',
            entity_type: 'appmax',
            entity_id: eventId,
            metadata: {
              event_type: event,
              status: 'rejected_ambiguous_reference',
            },
          })?.catch(() => {})
          return reply.code(409).send({ error: 'Referência ambígua' })
        } else {
          app.log.warn({ candidates, gatewayId }, '[appmax webhook] referência não encontrada')
          // Audit log: referência não encontrada (sem PII)
          app.audit?.log?.(request, {
            action: 'webhook_received',
            entity_type: 'appmax',
            entity_id: eventId,
            metadata: {
              event_type: event,
              status: 'unmatched_reference',
            },
          })?.catch(() => {})
        }
      } else {
        // Eventos que não são de pagamento (e.g., NotificationReceived, OrderCreated, etc)
        app.log.info({ event }, '[appmax webhook] evento ignorado (tipo não-crítico)')
        // Audit log: evento de tipo não-crítico (sem PII)
        app.audit?.log?.(request, {
          action: 'webhook_received',
          entity_type: 'appmax',
          entity_id: eventId,
          metadata: {
            event_type: event,
            status: 'received_non_payment_event',
          },
        })?.catch(() => {})
      }
    } catch (err) {
      app.log.error({ err }, '[appmax webhook] erro processando evento')
      // Audit log: erro no processamento (sem PII)
      app.audit?.log?.(request, {
        action: 'webhook_received',
        entity_type: 'appmax',
        entity_id: eventId || null,
        metadata: {
          event_type: event,
          status: 'error_processing',
        },
      })?.catch(() => {})
      return reply.code(500).send({ error: 'Erro ao processar webhook Appmax' })
    }

    return reply.code(200).send({ received: true })
  })
}
