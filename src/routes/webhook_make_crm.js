// Receiver de webhook do Make (make.com) → cria lead no CRM.
// Payload assinado via HMAC SHA256 + secret compartilhado (MAKE_CRM_WEBHOOK_SECRET).
// Espelha o padrão de webhook_bio_crm.js (mesma família de segurança).
//
// Contrato (header):  X-Livelab-Signature: sha256=<hex do HMAC do corpo cru>
// Contrato (body, todos os campos exceto `nome` são opcionais):
//   {
//     "event": "lead.created",           // opcional; se vier, deve ser lead.created
//     "nome": "Fulano de Tal",           // obrigatório
//     "email": "fulano@ex.com",
//     "whatsapp": "+55 47 90000-0000",
//     "cidade": "Blumenau",
//     "estado": "SC",
//     "nicho": "Moda",
//     "valor_oportunidade": 1500,
//     "responsavel": "Nome do vendedor",
//     "origem": "make_form_x",           // default: "make"
//     "dados_extras": { ...campos livres do cenário do Make... }
//   }

import crypto from 'node:crypto'
import { notify } from '../services/mailer.js'

function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return { ok: false, reason: 'missing_signature' }
  }
  const match = /^sha256=([a-f0-9]+)$/i.exec(signatureHeader.trim())
  if (!match) return { ok: false, reason: 'invalid_signature_format' }

  const received = Buffer.from(match[1], 'hex')
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest()

  if (received.length !== expected.length) return { ok: false, reason: 'signature_length_mismatch' }
  if (!crypto.timingSafeEqual(received, expected)) return { ok: false, reason: 'signature_mismatch' }
  return { ok: true }
}

function pickFirstNonEmpty(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue
    const s = Array.isArray(v)
      ? v.map((item) => String(item).trim()).filter(Boolean).join(', ')
      : typeof v === 'string' ? v.trim() : String(v).trim()
    if (s !== '') return s
  }
  return null
}

function toNumber(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.,-]/g, '').replace(',', '.'))
    if (Number.isFinite(n) && n > 0) return n
  }
  return 0
}

function buildLeadRow(payload, franqueadoraId) {
  const data = (payload?.dados_extras && typeof payload.dados_extras === 'object') ? payload.dados_extras : {}
  return {
    franqueadora_id: franqueadoraId,
    nome: pickFirstNonEmpty(payload.nome, payload.name, payload.lead_name, data.nome) ?? '(sem nome)',
    nicho: pickFirstNonEmpty(payload.nicho, payload.segmento, data.nicho),
    cidade: pickFirstNonEmpty(payload.cidade, payload.city, data.cidade),
    estado: pickFirstNonEmpty(payload.estado, payload.uf, payload.state, data.estado),
    fat_estimado: toNumber(payload.fat_estimado, payload.faturamento),
    valor_oportunidade: toNumber(payload.valor_oportunidade, payload.valor),
    status: 'disponivel',
    crm_etapa: 'lead_novo',
    responsavel_nome: pickFirstNonEmpty(payload.responsavel, payload.responsavel_nome, data.responsavel),
    origem: pickFirstNonEmpty(payload.origem, 'make'),
    contato_email: pickFirstNonEmpty(payload.email, payload.contato_email, data.email),
    contato_whatsapp: pickFirstNonEmpty(payload.whatsapp, payload.telefone, payload.phone, data.whatsapp),
    dados_extras: data,
    payload_externo: payload,
  }
}

export async function webhookMakeCrmRoutes(app) {
  // Secret obrigatório em produção — evita aceitar payload sem assinatura por config esquecida.
  if (process.env.NODE_ENV === 'production' && !process.env.MAKE_CRM_WEBHOOK_SECRET) {
    throw new Error('[boot] MAKE_CRM_WEBHOOK_SECRET é obrigatório em produção')
  }

  app.post('/v1/webhooks/make-crm', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const secret = process.env.MAKE_CRM_WEBHOOK_SECRET
    const franqueadoraId = process.env.MAKE_WEBHOOK_DEFAULT_FRANQUEADORA_ID
      || process.env.BIO_WEBHOOK_DEFAULT_FRANQUEADORA_ID
    const replayProtect = process.env.WEBHOOK_REPLAY_PROTECTION === 'true'

    // Resposta genérica em falhas pré-DB (anti-enumeration).
    const reject = (status, reason) => {
      app.log.warn({ reason }, '[make-crm webhook] rejected')
      return reply.code(status).send({ error: 'Webhook rejected.' })
    }

    if (!secret || !franqueadoraId) {
      app.log.error('[make-crm webhook] config ausente — rejeitando')
      return reply.code(503).send({ error: 'Webhook indisponível.' })
    }

    const rawBody = typeof request.rawBody === 'string'
      ? request.rawBody
      : JSON.stringify(request.body ?? {})

    const sig = verifySignature(rawBody, request.headers['x-livelab-signature'], secret)
    if (!sig.ok) return reject(401, sig.reason)

    if (replayProtect) {
      const ts = Number(request.headers['x-livelab-timestamp'])
      const nonce = request.headers['x-livelab-nonce']
      if (!Number.isFinite(ts) || !nonce || typeof nonce !== 'string' || nonce.length < 8) {
        return reject(401, 'missing_timestamp_or_nonce')
      }
      if (Math.abs(Date.now() - ts * 1000) > 5 * 60 * 1000) return reject(401, 'timestamp_skew')
      try {
        const inserted = await app.db.query(
          `INSERT INTO webhook_replay_log (source, nonce)
           VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING nonce`,
          ['make-crm', String(nonce).slice(0, 200)],
        )
        if (inserted.rowCount === 0) return reject(409, 'replay_detected')
      } catch (err) {
        app.log.error({ err }, '[make-crm webhook] replay log insert failed')
        return reject(503, 'replay_log_unavailable')
      }
    }

    const payload = request.body
    if (!payload || typeof payload !== 'object') return reject(400, 'invalid_payload')
    if (payload.event && payload.event !== 'lead.created') return reject(400, 'unsupported_event')

    const row = buildLeadRow(payload, franqueadoraId)

    try {
      const lead = await app.withTenant(franqueadoraId, async (db) => {
        const result = await db.query(
          `INSERT INTO leads (
              franqueadora_id, nome, nicho, cidade, estado, fat_estimado, valor_oportunidade,
              status, crm_etapa, responsavel_nome, origem,
              contato_email, contato_whatsapp, dados_extras, payload_externo,
              criado_em, atualizado_em
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb, NOW(), NOW())
           RETURNING id, nome, origem, criado_em`,
          [
            row.franqueadora_id, row.nome, row.nicho, row.cidade, row.estado, row.fat_estimado, row.valor_oportunidade,
            row.status, row.crm_etapa, row.responsavel_nome, row.origem,
            row.contato_email, row.contato_whatsapp,
            JSON.stringify(row.dados_extras ?? {}), JSON.stringify(row.payload_externo),
          ],
        )
        return result.rows[0]
      })
      app.log.info({ leadId: lead.id, origem: lead.origem }, '[make-crm webhook] lead criado')

      app.audit?.log?.(request, {
        action: 'webhook_received',
        entity_type: 'make_crm',
        entity_id: lead.id,
        metadata: { source: 'make-crm', received_keys: Object.keys(payload) },
      })?.catch(() => {})

      // Notificação por e-mail — fire-and-forget.
      ;(async () => {
        try {
          const tQ = await app.db.query(
            `SELECT email_contato, notif_email_ativo, notif_lead_novo FROM tenants WHERE id = $1`,
            [franqueadoraId],
          )
          const tenant = tQ.rows[0]
          if (!tenant?.email_contato) return
          await notify({
            app, tenantId: franqueadoraId, to: tenant.email_contato,
            template: 'lead_novo_inbound', refId: lead.id,
            settings: { notif_email_ativo: tenant.notif_email_ativo, notif_lead_novo: tenant.notif_lead_novo },
            settingsKey: 'notif_lead_novo', dedupe: true,
            vars: { nome: row.nome, cidade: row.cidade, estado: row.estado, email: row.contato_email, whatsapp: row.contato_whatsapp, origem: row.origem },
          })
        } catch (err) {
          app.log.error({ err, leadId: lead.id }, 'mailer: falha ao notificar lead make inbound')
        }
      })()

      return reply.code(201).send({ ok: true, lead_id: lead.id })
    } catch (err) {
      app.log.error({ err }, '[make-crm webhook] erro ao inserir lead')
      return reply.code(500).send({ error: 'Erro interno.' })
    }
  })
}
