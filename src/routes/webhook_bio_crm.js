// Receiver de webhook do form bio público (cliente / franqueado / apresentador).
// Emissor: outro sistema (Codex). Payload assinado via HMAC SHA256 + secret compartilhado.
// Ação: cria registro em `leads` linkado à franqueadora padrão (env BIO_WEBHOOK_DEFAULT_FRANQUEADORA_ID).
//
// Contrato (header):  X-Livelab-Signature: sha256=<hex>
// Contrato (body):
//   { event, persona, lead_name, contact_email, whatsapp, city,
//     submitted_at, source_path, data: {...}, metadata: {...} }

import crypto from 'node:crypto'

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
    observacoes_internas: formatLeadFicha(payload),
    payload_externo: payload,
  }
}

export async function webhookBioCrmRoutes(app) {
  // Rota pública (sem authenticate). Segurança via HMAC.
  app.post('/v1/webhooks/bio-crm', async (request, reply) => {
    const secret = process.env.BIO_CRM_WEBHOOK_SECRET
    const franqueadoraId = process.env.BIO_WEBHOOK_DEFAULT_FRANQUEADORA_ID

    if (!secret) {
      app.log.error('[bio-crm webhook] BIO_CRM_WEBHOOK_SECRET ausente — rejeitando')
      return reply.code(503).send({ error: 'Webhook não configurado.' })
    }
    if (!franqueadoraId) {
      app.log.error('[bio-crm webhook] BIO_WEBHOOK_DEFAULT_FRANQUEADORA_ID ausente — rejeitando')
      return reply.code(503).send({ error: 'Tenant destino não configurado.' })
    }

    // rawBody quando disponível (via contentTypeParser global) — fallback determinístico
    const rawBody = typeof request.rawBody === 'string'
      ? request.rawBody
      : JSON.stringify(request.body ?? {})

    const sig = verifySignature(rawBody, request.headers['x-livelab-signature'], secret)
    if (!sig.ok) {
      app.log.warn({ reason: sig.reason }, '[bio-crm webhook] assinatura inválida')
      return reply.code(401).send({ error: 'Assinatura inválida.' })
    }

    const payload = request.body
    if (!payload || typeof payload !== 'object') {
      return reply.code(400).send({ error: 'Payload inválido.' })
    }
    if (payload.event && payload.event !== 'bio.form.submitted') {
      return reply.code(400).send({ error: `Evento não suportado: ${payload.event}` })
    }

    const row = buildLeadRow(payload, franqueadoraId)

    try {
      // Usa withTenant pra setar app.tenant_id na conexão — necessário pra
      // passar pela policy RLS leads_tenant (WITH CHECK herda do USING quando
      // omitido, então INSERT exige franqueadora_id = current_setting(...)).
      const lead = await app.withTenant(franqueadoraId, async (db) => {
        const result = await db.query(
          `INSERT INTO leads (
              franqueadora_id, nome, nicho, cidade, estado, fat_estimado,
              status, crm_etapa, responsavel_nome, origem,
              contato_email, contato_whatsapp, observacoes_internas, payload_externo,
              criado_em, atualizado_em
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, NOW(), NOW())
           RETURNING id, nome, origem, criado_em`,
          [
            row.franqueadora_id, row.nome, row.nicho, row.cidade, row.estado, row.fat_estimado,
            row.status, row.crm_etapa, row.responsavel_nome, row.origem,
            row.contato_email, row.contato_whatsapp, row.observacoes_internas,
            JSON.stringify(row.payload_externo),
          ],
        )
        return result.rows[0]
      })
      app.log.info({ leadId: lead.id, origem: lead.origem }, '[bio-crm webhook] lead criado')
      return reply.code(201).send({ ok: true, lead_id: lead.id })
    } catch (err) {
      app.log.error({ err }, '[bio-crm webhook] erro ao inserir lead')
      return reply.code(500).send({ error: 'Erro ao gravar lead.' })
    }
  })
}
