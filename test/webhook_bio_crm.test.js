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
  app.decorate('withTenant', async (_tid, fn) => fn({ query: queryMock }))

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

    // F1: hook fire-and-forget de notify pode disparar SELECT extra no mesmo mock.
    // O INSERT do lead (call principal) é sempre o primeiro.
    expect(queryMock.mock.calls.length).toBeGreaterThanOrEqual(1)
    const params = queryMock.mock.calls[0][1]
    // params: [franqueadora, nome, nicho, cidade, estado, fat, status, etapa, responsavel, origem, email, whatsapp, observacoes, payload]
    expect(params[0]).toBe(FRANQUEADORA)
    expect(params[1]).toBe('Maria Silva')
    expect(params[2]).toBe('Cliente')
    expect(params[3]).toBe('São Paulo')
    expect(params[4]).toBe('SP')
    expect(params[5]).toBe(500000)
    expect(params[6]).toBe('disponivel')
    expect(params[7]).toBe('lead_novo')
    expect(params[9]).toBe('bio_cliente')
    expect(params[10]).toBe('maria@exemplo.com')
    expect(params[11]).toBe('(11) 99999-9999')
    // params[12] = dados_extras (JSON estruturado, não texto)
    const dados = JSON.parse(params[12])
    expect(dados.nome).toBe('Maria Silva')
    expect(dados.segmento).toBe('Moda feminina')
    expect(dados.fat_anual).toBe('500000')
    expect(JSON.parse(params[13]).event).toBe('bio.form.submitted')

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
    expect(queryMock.mock.calls[0][1][2]).toBe('Unidade')
    expect(queryMock.mock.calls[0][1][9]).toBe('bio_franqueado')
    await app.close()
  })

  it('mapeia apresentador como Creator e origem bio_apresentador', async () => {
    const { app, queryMock } = await buildApp()
    const payload = { ...VALID_PAYLOAD, persona: 'apresentador' }
    const body = JSON.stringify(payload)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/bio-crm',
      headers: { 'content-type': 'application/json', 'x-livelab-signature': sign(body) },
      payload: body,
    })
    expect(res.statusCode).toBe(201)
    expect(queryMock.mock.calls[0][1][2]).toBe('Creator')
    expect(queryMock.mock.calls[0][1][9]).toBe('bio_apresentador')
    await app.close()
  })

  it('persiste dados estruturados de franqueado em dados_extras', async () => {
    const { app, queryMock } = await buildApp()
    const payload = {
      ...VALID_PAYLOAD,
      persona: 'franqueado',
      lead_name: 'Vitor Xavier de Castro',
      whatsapp: '11949751130',
      city: 'São Paulo',
      source_path: '/bio/franqueado',
      data: {
        nome: 'Vitor Xavier de Castro',
        cidade: 'São Paulo ',
        situacao: 'Já empreendo e busco nova oportunidade',
        experiencia_franquia: 'Sim, tenho experiência',
        conhece_live_commerce: 'Sim, acompanho de perto',
        capital: 'Até R$ 40.000',
        prazo_inicio: 'Imediatamente — estou pronto(a)',
        espaco_fisico: 'Sim, já tenho um espaço disponível',
        socios: 'Sim',
        atrativos: ['Ser pioneiro(a) na minha cidade'],
        receio: 'Não tenho tanto capital disponível para aportar, porém tenho espaço e conhecimento.',
        interesse: 'Alto — quero conversar com um especialista agora',
        whatsapp: '11949751130',
        horario: 'Tarde (12h–18h)',
      },
    }
    const body = JSON.stringify(payload)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/bio-crm',
      headers: { 'content-type': 'application/json', 'x-livelab-signature': sign(body) },
      payload: body,
    })
    expect(res.statusCode).toBe(201)
    const dados = JSON.parse(queryMock.mock.calls[0][1][12])
    expect(dados.nome).toBe('Vitor Xavier de Castro')
    expect(dados.situacao).toBe('Já empreendo e busco nova oportunidade')
    expect(dados.experiencia_franquia).toBe('Sim, tenho experiência')
    expect(dados.capital).toBe('Até R$ 40.000')
    expect(dados.atrativos).toEqual(['Ser pioneiro(a) na minha cidade'])
    expect(dados.interesse).toBe('Alto — quero conversar com um especialista agora')
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
