// Receiver de webhook do form bio público (cliente / franqueado / apresentador).
// Emissor: outro sistema (Codex). Payload assinado via HMAC SHA256 + secret compartilhado.
// Ação: cria registro em `leads` linkado à franqueadora padrão (env BIO_WEBHOOK_DEFAULT_FRANQUEADORA_ID).
//
// Contrato (header):  X-Livelab-Signature: sha256=<hex>
// Contrato (body):
//   { event, persona, lead_name, contact_email, whatsapp, city,
//     submitted_at, source_path, data: {...}, metadata: {...} }

import crypto from 'node:crypto'
import { notify } from '../services/mailer.js'

const ALLOWED_PERSONAS = new Set(['cliente', 'franqueado', 'apresentador'])
const PERSONA_CRM_TYPE = {
  cliente: 'Cliente',
  franqueado: 'Unidade',
  apresentador: 'Creator',
}

function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return { ok: false, reason: 'missing_signature' }
  }
  const match = /^sha256=([a-f0-9]+)$/i.exec(signatureHeader.trim())
  if (!match) return { ok: false, reason: 'invalid_signature_format' }

  const received = Buffer.from(match[1], 'hex')
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest()

  if (received.length !== expected.length) {
    return { ok: false, reason: 'signature_length_mismatch' }
  }
  if (!crypto.timingSafeEqual(received, expected)) {
    return { ok: false, reason: 'signature_mismatch' }
  }
  return { ok: true }
}

function pickFirstNonEmpty(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue
    const s = Array.isArray(v)
      ? v.map((item) => String(item).trim()).filter(Boolean).join(', ')
      : typeof v === 'string'
        ? v.trim()
        : String(v).trim()
    if (s !== '') return s
  }
  return null
}

function formatLeadFicha(payload) {
  const data = (payload?.data && typeof payload.data === 'object') ? payload.data : {}
  const persona = ALLOWED_PERSONAS.has(payload.persona) ? payload.persona : null
  const lines = []

  const addSection = (title, entries) => {
    lines.push(title)
    for (const [label, value] of entries) {
      const formatted = pickFirstNonEmpty(value)
      if (formatted) lines.push(`${label}: ${formatted}`)
    }
    lines.push('')
  }

  if (persona === 'franqueado') {
    addSection('IDENTIFICAÇÃO', [
      ['Nome completo', pickFirstNonEmpty(payload.lead_name, data.nome, data.name, data.nome_completo)],
      ['Cidade', pickFirstNonEmpty(payload.city, data.cidade, data.city, data.cidade_estado)],
      ['WhatsApp', pickFirstNonEmpty(payload.whatsapp, data.whatsapp, data.telefone, data.phone)],
    ])
    addSection('PERFIL DO INTERESSADO', [
      ['Situação atual', data.situacao],
      ['Experiência c/ franquias', data.experiencia_franquia],
      ['Conhece live commerce', data.conhece_live_commerce],
      ['Sócios', data.socios],
    ])
    addSection('CAPACIDADE & PRONTIDÃO', [
      ['Capital disponível', data.capital],
      ['Prazo para início', data.prazo_inicio],
      ['Espaço físico', data.espaco_fisico],
      ['Melhor horário', data.horario],
    ])
    addSection('MOTIVAÇÃO & OBSERVAÇÕES', [
      ['O que mais atrai', data.atrativos],
      ['Principal receio', data.receio],
      ['Nível de interesse', data.interesse],
    ])
    return lines.join('\n').trim()
  }

  addSection('IDENTIFICAÇÃO', [
    ['Nome completo', pickFirstNonEmpty(payload.lead_name, data.nome, data.name, data.nome_completo)],
    ['Cidade', pickFirstNonEmpty(payload.city, data.cidade, data.city, data.cidade_estado)],
    ['WhatsApp', pickFirstNonEmpty(payload.whatsapp, data.whatsapp, data.telefone, data.phone)],
    ['E-mail', pickFirstNonEmpty(payload.contact_email, data.email, data.contact_email)],
  ])
  addSection('DADOS DO FORMULÁRIO', Object.entries(data).map(([key, value]) => [key, value]))
  return lines.join('\n').trim()
}

function buildLeadRow(payload, franqueadoraId) {
  const data = (payload?.data && typeof payload.data === 'object') ? payload.data : {}

  const nome = pickFirstNonEmpty(payload.lead_name, data.nome, data.name, data.nome_completo)
  const cidade = pickFirstNonEmpty(payload.city, data.cidade, data.city, data.cidade_estado)
  const estado = pickFirstNonEmpty(data.estado, data.uf, data.state)
  const email = pickFirstNonEmpty(payload.contact_email, data.email, data.contact_email)
  const whatsapp = pickFirstNonEmpty(payload.whatsapp, data.whatsapp, data.telefone, data.phone)
  const persona = ALLOWED_PERSONAS.has(payload.persona) ? payload.persona : null
  const nicho = pickFirstNonEmpty(persona ? PERSONA_CRM_TYPE[persona] : null, data.nicho, data.segmento, data.marca)
  const responsavel = pickFirstNonEmpty(payload.lead_name, data.responsavel, data.responsible_name)
  const fatNum = (() => {
    const candidates = [data.fat_estimado, data.faturamento, data.fat_anual, data.gmv_expectation]
    for (const c of candidates) {
      if (c === null || c === undefined) continue
      const n = typeof c === 'number' ? c : Number(String(c).replace(/[^\d.,-]/g, '').replace(',', '.'))
      if (Number.isFinite(n) && n > 0) return n
    }
    return 0
  })()
  const origem = pickFirstNonEmpty(
    persona ? `bio_${persona}` : null,
    payload.source_path,
    'bio_webhook',
  )

  return {
    franqueadora_id: franqueadoraId,
    nome: nome ?? '(sem nome)',
    nicho,
    cidade,
    estado,
    fat_estimado: fatNum,
    status: 'disponivel',
    crm_etapa: 'lead_novo',
    responsavel_nome: responsavel,
    origem,
    contato_email: email,
    contato_whatsapp: whatsapp,
    dados_extras: data,
    payload_externo: payload,
  }
}

export async function webhookBioCrmRoutes(app) {
  // S-08: secret obrigatório em produção. Falha boot pra evitar webhook
  // aceitar payload sem assinatura por config esquecida.
  if (process.env.NODE_ENV === 'production' && !process.env.BIO_CRM_WEBHOOK_SECRET) {
    throw new Error('[boot] BIO_CRM_WEBHOOK_SECRET é obrigatório em produção')
  }

  // Rota pública (sem authenticate). Segurança via HMAC + replay protection.
  // Rate limit individual: 30/min é folga vs uso real (sender envia ~1/min).
  app.post('/v1/webhooks/bio-crm', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const secret = process.env.BIO_CRM_WEBHOOK_SECRET
    const franqueadoraId = process.env.BIO_WEBHOOK_DEFAULT_FRANQUEADORA_ID
    const replayProtect = process.env.WEBHOOK_REPLAY_PROTECTION === 'true'

    // Resposta genérica em todas as falhas pré-DB para não permitir enumeration.
    const reject = (status, reason) => {
      app.log.warn({ reason }, '[bio-crm webhook] rejected')
      return reply.code(status).send({ error: 'Webhook rejected.' })
    }

    if (!secret || !franqueadoraId) {
      app.log.error('[bio-crm webhook] config ausente — rejeitando')
      return reply.code(503).send({ error: 'Webhook indisponível.' })
    }

    const rawBody = typeof request.rawBody === 'string'
      ? request.rawBody
      : JSON.stringify(request.body ?? {})

    const sig = verifySignature(rawBody, request.headers['x-livelab-signature'], secret)
    if (!sig.ok) return reject(401, sig.reason)

    // Replay protection (timestamp + nonce). Ativado via env quando sender pronto.
    if (replayProtect) {
      const tsHeader = request.headers['x-livelab-timestamp']
      const nonce = request.headers['x-livelab-nonce']
      const ts = Number(tsHeader)
      if (!Number.isFinite(ts) || !nonce || typeof nonce !== 'string' || nonce.length < 8) {
        return reject(401, 'missing_timestamp_or_nonce')
      }
      const skewMs = Math.abs(Date.now() - ts * 1000)
      if (skewMs > 5 * 60 * 1000) return reject(401, 'timestamp_skew')

      try {
        const inserted = await app.db.query(
          `INSERT INTO webhook_replay_log (source, nonce)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING
           RETURNING nonce`,
          ['bio-crm', String(nonce).slice(0, 200)],
        )
        if (inserted.rowCount === 0) return reject(409, 'replay_detected')
      } catch (err) {
        app.log.error({ err }, '[bio-crm webhook] replay log insert failed')
        return reject(503, 'replay_log_unavailable')
      }
    }

    const payload = request.body
    if (!payload || typeof payload !== 'object') return reject(400, 'invalid_payload')
    if (payload.event && payload.event !== 'bio.form.submitted') {
      return reject(400, 'unsupported_event')
    }

    const row = buildLeadRow(payload, franqueadoraId)

    try {
      const lead = await app.withTenant(franqueadoraId, async (db) => {
        const result = await db.query(
          `INSERT INTO leads (
              franqueadora_id, nome, nicho, cidade, estado, fat_estimado,
              status, crm_etapa, responsavel_nome, origem,
              contato_email, contato_whatsapp, dados_extras, payload_externo,
              criado_em, atualizado_em
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb, NOW(), NOW())
           RETURNING id, nome, origem, criado_em`,
          [
            row.franqueadora_id, row.nome, row.nicho, row.cidade, row.estado, row.fat_estimado,
            row.status, row.crm_etapa, row.responsavel_nome, row.origem,
            row.contato_email, row.contato_whatsapp,
            JSON.stringify(row.dados_extras ?? {}),
            JSON.stringify(row.payload_externo),
          ],
        )
        return result.rows[0]
      })
      app.log.info({ leadId: lead.id, origem: lead.origem }, '[bio-crm webhook] lead criado')

      await app.audit.log(request, {
        action: 'webhook_received',
        entity_type: 'bio_crm',
        entity_id: null,
        metadata: {
          source: 'bio-crm',
          received_keys: Object.keys(request.body || {}),
        },
      }).catch(() => {}) // fire-and-forget

      // F1: notificação por e-mail — fire-and-forget.
      ;(async () => {
        try {
          // franqueadoraId aqui é tenant_id do destino. Busca e-mail de contato + flags.
          const tQ = await app.db.query(
            `SELECT email_contato, notif_email_ativo, notif_lead_novo
             FROM tenants WHERE id = $1`,
            [franqueadoraId],
          )
          const tenant = tQ.rows[0]
          if (!tenant?.email_contato) return

          await notify({
            app,
            tenantId: franqueadoraId,
            to: tenant.email_contato,
            template: 'lead_novo_inbound',
            refId: lead.id,
            settings: {
              notif_email_ativo: tenant.notif_email_ativo,
              notif_lead_novo: tenant.notif_lead_novo,
            },
            settingsKey: 'notif_lead_novo',
            dedupe: true,
            vars: {
              nome: row.nome,
              cidade: row.cidade,
              estado: row.estado,
              email: row.contato_email,
              whatsapp: row.contato_whatsapp,
              origem: row.origem,
            },
          })
        } catch (err) {
          app.log.error({ err, leadId: lead.id }, 'mailer: falha ao notificar lead inbound')
        }
      })()

      return reply.code(201).send({ ok: true, lead_id: lead.id })
    } catch (err) {
      app.log.error({ err }, '[bio-crm webhook] erro ao inserir lead')
      return reply.code(500).send({ error: 'Erro interno.' })
    }
  })
}
