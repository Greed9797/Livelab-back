import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import crypto from 'node:crypto'

import { webhookBioCrmRoutes } from '../src/routes/webhook_bio_crm.js'

const SECRET = 'test-secret-32-chars-minimum-aaaaaaaa'
const FRANQUEADORA = '00000000-0000-0000-0000-000000000001'

const VALID_PAYLOAD = {
  event: 'bio.form.submitted',
  persona: 'cliente',
  lead_name: 'Maria Silva',
  contact_email: 'maria@exemplo.com',
  whatsapp: '(11) 99999-9999',
  city: 'São Paulo',
  submitted_at: '2026-05-04T16:30:00.000Z',
  source_path: '/bio/cliente',
  data: {
    nome: 'Maria Silva',
    email: 'maria@exemplo.com',
    whatsapp: '11999999999',
    cidade: 'São Paulo',
    estado: 'SP',
    segmento: 'Moda feminina',
    fat_anual: '500000',
  },
  metadata: { origin: 'https://livelab.app', referer: 'https://livelab.app/bio' },
}

function sign(body, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
}

async function buildApp({ insertFails = false } = {}) {
  const app = Fastify()
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body
    if (!body) return done(null, {})
    try { done(null, JSON.parse(body)) } catch (err) { done(err, undefined) }
  })

  const queryMock = vi.fn(async () => {
    if (insertFails) throw new Error('boom')
    return { rows: [{ id: 'lead-uuid', nome: 'Maria Silva', origem: 'bio_cliente', criado_em: new Date() }] }
  })
  app.decorate('db', { query: queryMock })

  await app.register(webhookBioCrmRoutes)
  return { app, queryMock }
}

describe('POST /v1/webhooks/bio-crm', () => {
  beforeEach(() => {
    process.env.BIO_CRM_WEBHOOK_SECRET = SECRET
    process.env.BIO_WEBHOOK_DEFAULT_FRANQUEADORA_ID = FRANQUEADORA
  })

  afterEach(() => {
    delete process.env.BIO_CRM_WEBHOOK_SECRET
    delete process.env.BIO_WEBHOOK_DEFAULT_FRANQUEADORA_ID
  })

  it('aceita payload válido + HMAC correto e cria lead', async () => {
    const { app, queryMock } = await buildApp()
    const body = JSON.stringify(VALID_PAYLOAD)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/bio-crm',
      headers: {
        'content-type': 'application/json',
        'x-livelab-signature': sign(body),
      },
      payload: body,
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ ok: true, lead_id: 'lead-uuid' })

    expect(queryMock).toHaveBeenCalledTimes(1)
    const params = queryMock.mock.calls[0][1]
    // params: [franqueadora, nome, nicho, cidade, estado, fat, status, etapa, responsavel, origem, email, whatsapp, payload]
    expect(params[0]).toBe(FRANQUEADORA)
    expect(params[1]).toBe('Maria Silva')
    expect(params[2]).toBe('Moda feminina') // nicho via data.segmento
    expect(params[3]).toBe('São Paulo')
    expect(params[4]).toBe('SP')
    expect(params[5]).toBe(500000)
    expect(params[6]).toBe('disponivel')
    expect(params[7]).toBe('lead_novo')
    expect(params[9]).toBe('bio_cliente')
    expect(params[10]).toBe('maria@exemplo.com')
    expect(params[11]).toBe('(11) 99999-9999')
    expect(JSON.parse(params[12]).event).toBe('bio.form.submitted')

    await app.close()
  })

  it('rejeita 401 quando assinatura inválida', async () => {
    const { app, queryMock } = await buildApp()
    const body = JSON.stringify(VALID_PAYLOAD)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/bio-crm',
      headers: {
        'content-type': 'application/json',
        'x-livelab-signature': 'sha256=' + 'a'.repeat(64),
      },
      payload: body,
    })

    expect(res.statusCode).toBe(401)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejeita 401 quando header X-Livelab-Signature ausente', async () => {
    const { app, queryMock } = await buildApp()
    const body = JSON.stringify(VALID_PAYLOAD)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/bio-crm',
      headers: { 'content-type': 'application/json' },
      payload: body,
    })
    expect(res.statusCode).toBe(401)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('responde 503 quando BIO_CRM_WEBHOOK_SECRET ausente', async () => {
    delete process.env.BIO_CRM_WEBHOOK_SECRET
    const { app, queryMock } = await buildApp()
    const body = JSON.stringify(VALID_PAYLOAD)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/bio-crm',
      headers: { 'content-type': 'application/json', 'x-livelab-signature': sign(body) },
      payload: body,
    })
    expect(res.statusCode).toBe(503)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('responde 503 quando BIO_WEBHOOK_DEFAULT_FRANQUEADORA_ID ausente', async () => {
    delete process.env.BIO_WEBHOOK_DEFAULT_FRANQUEADORA_ID
    const { app, queryMock } = await buildApp()
    const body = JSON.stringify(VALID_PAYLOAD)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/bio-crm',
      headers: { 'content-type': 'application/json', 'x-livelab-signature': sign(body) },
      payload: body,
    })
    expect(res.statusCode).toBe(503)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('mapeia origem por persona (franqueado)', async () => {
    const { app, queryMock } = await buildApp()
    const payload = { ...VALID_PAYLOAD, persona: 'franqueado' }
    const body = JSON.stringify(payload)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/bio-crm',
      headers: { 'content-type': 'application/json', 'x-livelab-signature': sign(body) },
      payload: body,
    })
    expect(res.statusCode).toBe(201)
    expect(queryMock.mock.calls[0][1][9]).toBe('bio_franqueado')
    await app.close()
  })

  it('500 + não cria lead se INSERT falha', async () => {
    const { app } = await buildApp({ insertFails: true })
    const body = JSON.stringify(VALID_PAYLOAD)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/bio-crm',
      headers: { 'content-type': 'application/json', 'x-livelab-signature': sign(body) },
      payload: body,
    })
    expect(res.statusCode).toBe(500)
    await app.close()
  })

  it('rejeita event diferente de bio.form.submitted', async () => {
    const { app, queryMock } = await buildApp()
    const payload = { ...VALID_PAYLOAD, event: 'other.event' }
    const body = JSON.stringify(payload)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/bio-crm',
      headers: { 'content-type': 'application/json', 'x-livelab-signature': sign(body) },
      payload: body,
    })
    expect(res.statusCode).toBe(400)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })
})
