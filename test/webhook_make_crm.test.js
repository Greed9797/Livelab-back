import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import crypto from 'node:crypto'

import { webhookMakeCrmRoutes } from '../src/routes/webhook_make_crm.js'

const SECRET = 'make-secret-32-chars-minimum-aaaaaaaa'
const FRANQUEADORA = '00000000-0000-0000-0000-000000000001'

const VALID_PAYLOAD = {
  event: 'lead.created',
  nome: 'João Pereira',
  email: 'joao@exemplo.com',
  whatsapp: '(47) 90000-0000',
  cidade: 'Blumenau',
  estado: 'SC',
  nicho: 'Moda',
  valor_oportunidade: 1500,
  origem: 'make_form_x',
  dados_extras: { campanha: 'black-friday' },
}

// v1 legado: assina só o body.
function sign(body, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
}

// v2: assina `timestamp.nonce.body` e devolve os 3 headers prontos.
function signV2(body, { ts, nonce = 'nonce-1234-abcd', secret = SECRET } = {}) {
  const timestamp = String(ts ?? Math.floor(Date.now() / 1000))
  const signed = `${timestamp}.${nonce}.${body}`
  return {
    'x-livelab-timestamp': timestamp,
    'x-livelab-nonce': nonce,
    'x-livelab-signature': 'sha256=' + crypto.createHmac('sha256', secret).update(signed).digest('hex'),
  }
}

async function buildApp({ insertFails = false, replayInserted = 1 } = {}) {
  const app = Fastify()
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body
    if (!body) return done(null, {})
    try { done(null, JSON.parse(body)) } catch (err) { done(err, undefined) }
  })

  const queryMock = vi.fn(async (sql) => {
    if (String(sql).includes('webhook_replay_log')) return { rowCount: replayInserted, rows: [] }
    if (String(sql).includes('FROM tenants')) return { rows: [{ email_contato: null }] }
    if (insertFails) throw new Error('boom')
    return { rows: [{ id: 'lead-uuid', nome: 'João Pereira', origem: 'make_form_x', criado_em: new Date() }] }
  })
  app.decorate('db', { query: queryMock })
  app.decorate('withTenant', async (_tid, fn) => fn({ query: queryMock }))

  await app.register(webhookMakeCrmRoutes)
  return { app, queryMock }
}

function post(app, body, headers = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/webhooks/make-crm',
    headers: { 'content-type': 'application/json', ...headers },
    payload: body,
  })
}

describe('POST /v1/webhooks/make-crm', () => {
  beforeEach(() => {
    process.env.MAKE_CRM_WEBHOOK_SECRET = SECRET
    process.env.MAKE_WEBHOOK_DEFAULT_FRANQUEADORA_ID = FRANQUEADORA
  })
  afterEach(() => {
    delete process.env.MAKE_CRM_WEBHOOK_SECRET
    delete process.env.MAKE_WEBHOOK_DEFAULT_FRANQUEADORA_ID
    delete process.env.WEBHOOK_REPLAY_PROTECTION
  })

  it('aceita payload válido + HMAC correto e cria lead com origem do payload', async () => {
    const { app, queryMock } = await buildApp()
    const body = JSON.stringify(VALID_PAYLOAD)
    const res = await post(app, body, { 'x-livelab-signature': sign(body) })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ ok: true, lead_id: 'lead-uuid' })
    const insert = queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO leads'))
    expect(insert).toBeTruthy()
    // origem do payload preservada; status disponivel; etapa lead_novo
    expect(insert[1]).toContain('make_form_x')
    expect(insert[1]).toContain('disponivel')
    expect(insert[1]).toContain('lead_novo')
    await app.close()
  })

  it('usa origem "make" quando não enviada', async () => {
    const { app, queryMock } = await buildApp()
    const body = JSON.stringify({ nome: 'Sem Origem' })
    const res = await post(app, body, { 'x-livelab-signature': sign(body) })
    expect(res.statusCode).toBe(201)
    const insert = queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO leads'))
    expect(insert[1]).toContain('make')
    await app.close()
  })

  it('rejeita assinatura incorreta com 401', async () => {
    const { app } = await buildApp()
    const body = JSON.stringify(VALID_PAYLOAD)
    const res = await post(app, body, { 'x-livelab-signature': sign(body, 'segredo-errado') })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('rejeita sem header de assinatura com 401', async () => {
    const { app } = await buildApp()
    const res = await post(app, JSON.stringify(VALID_PAYLOAD))
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('rejeita event não suportado com 400', async () => {
    const { app } = await buildApp()
    const body = JSON.stringify({ ...VALID_PAYLOAD, event: 'outro.evento' })
    const res = await post(app, body, { 'x-livelab-signature': sign(body) })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('replay: nonce repetido (rowCount 0) → 409', async () => {
    process.env.WEBHOOK_REPLAY_PROTECTION = 'true'
    const { app } = await buildApp({ replayInserted: 0 })
    const body = JSON.stringify(VALID_PAYLOAD)
    const res = await post(app, body, signV2(body))
    expect(res.statusCode).toBe(409)
    await app.close()
  })

  // ─── L3-2: assinatura v2 (timestamp.nonce.body) ────────────────────────────

  it('v2: aceita assinatura sobre timestamp.nonce.body', async () => {
    const { app } = await buildApp()
    const body = JSON.stringify(VALID_PAYLOAD)
    const res = await post(app, body, signV2(body))
    expect(res.statusCode).toBe(201)
    await app.close()
  })

  it('v2: rejeita skew > 5min mesmo com WEBHOOK_REPLAY_PROTECTION desligado', async () => {
    const { app, queryMock } = await buildApp()
    const body = JSON.stringify(VALID_PAYLOAD)
    const stale = Math.floor(Date.now() / 1000) - 6 * 60
    const res = await post(app, body, signV2(body, { ts: stale }))
    expect(res.statusCode).toBe(401)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('v2: rejeita timestamp futuro além de 5min', async () => {
    const { app } = await buildApp()
    const body = JSON.stringify(VALID_PAYLOAD)
    const future = Math.floor(Date.now() / 1000) + 6 * 60
    const res = await post(app, body, signV2(body, { ts: future }))
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('v2: assinatura que cobre só o body é rejeitada quando ts/nonce vêm nos headers', async () => {
    const { app } = await buildApp()
    const body = JSON.stringify(VALID_PAYLOAD)
    const res = await post(app, body, {
      ...signV2(body),
      'x-livelab-signature': sign(body), // v1 sig num request v2 → downgrade bloqueado
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('v2: trocar o nonce depois de assinar invalida a assinatura', async () => {
    const { app } = await buildApp()
    const body = JSON.stringify(VALID_PAYLOAD)
    const headers = signV2(body)
    const res = await post(app, body, { ...headers, 'x-livelab-nonce': 'outro-nonce-9999' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('v1 legado continua aceito enquanto WEBHOOK_REPLAY_PROTECTION não está ligado', async () => {
    const { app } = await buildApp()
    const body = JSON.stringify(VALID_PAYLOAD)
    const res = await post(app, body, { 'x-livelab-signature': sign(body) })
    expect(res.statusCode).toBe(201)
    await app.close()
  })

  it('v1 legado passa a ser 401 com WEBHOOK_REPLAY_PROTECTION=true', async () => {
    process.env.WEBHOOK_REPLAY_PROTECTION = 'true'
    const { app, queryMock } = await buildApp()
    const body = JSON.stringify(VALID_PAYLOAD)
    const res = await post(app, body, { 'x-livelab-signature': sign(body) })
    expect(res.statusCode).toBe(401)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('v2: nonce curto demais é rejeitado', async () => {
    const { app } = await buildApp()
    const body = JSON.stringify(VALID_PAYLOAD)
    const res = await post(app, body, signV2(body, { nonce: 'curto' }))
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('v2: nonce sem timestamp é rejeitado (não cai no caminho v1)', async () => {
    const { app } = await buildApp()
    const body = JSON.stringify(VALID_PAYLOAD)
    const res = await post(app, body, {
      'x-livelab-signature': sign(body),
      'x-livelab-nonce': 'nonce-1234-abcd',
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('v2: grava o nonce completo no replay log (sem truncar)', async () => {
    process.env.WEBHOOK_REPLAY_PROTECTION = 'true'
    const { app, queryMock } = await buildApp()
    const body = JSON.stringify(VALID_PAYLOAD)
    const nonce = 'n'.repeat(200)
    const res = await post(app, body, signV2(body, { nonce }))
    expect(res.statusCode).toBe(201)
    const replay = queryMock.mock.calls.find(([sql]) => String(sql).includes('webhook_replay_log'))
    expect(replay[1]).toEqual(['make-crm', nonce])
    await app.close()
  })
})
