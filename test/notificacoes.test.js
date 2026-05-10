import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

import { notificacoesRoutes } from '../src/routes/notificacoes.js'
import { renderTemplate, sendEmail } from '../src/services/mailer.js'

const TENANT = '00000000-0000-0000-0000-000000000001'

function buildAppWithMocks({ logRows = [], totalRow = { total: 0 }, tenantRow = null } = {}) {
  const app = Fastify()
  const queryMock = vi.fn()
  const releaseMock = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: TENANT, papel: 'franqueado' }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: TENANT, papel: 'franqueado' }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })

  // app.db.query (sem tenant) — usado pra buscar tenant no endpoint de teste
  app.decorate('db', {
    query: async () => ({ rows: tenantRow ? [tenantRow] : [] }),
    pool: null, // evita gravar em notification_log no test
  })

  // dbTenant — usado pelo GET /log
  app.decorate('dbTenant', async () => ({
    query: async (sql) => {
      if (/COUNT\(\*\)/.test(sql)) return { rows: [totalRow] }
      return { rows: logRows }
    },
    release: releaseMock,
  }))
  app.decorate('withTenant', async (tenantId, fn) => {
    const db = await app.dbTenant(tenantId)
    try { return await fn(db) } finally { db.release() }
  })

  return { app, queryMock, releaseMock }
}

describe('mailer service', () => {
  describe('renderTemplate', () => {
    it('renders live_encerrada template with vars', () => {
      const { subject, html } = renderTemplate('live_encerrada', {
        gmv: 1234.56, qtd_pedidos: 10, viewers: 500, duracao: '01:00:00',
      })
      expect(subject).toContain('1.234,56')
      expect(html).toContain('1.234,56')
      expect(html).toContain('10') // qtd_pedidos
      expect(html).toContain('500') // viewers
      expect(html).toContain('01:00:00')
    })

    it('renders boleto_vencido with money format', () => {
      const { subject, html } = renderTemplate('boleto_vencido', {
        cliente_nome: 'João',
        valor: 99.9,
        vencimento: '2026-01-01',
        descricao: 'Mensalidade',
        url: 'https://pay.test/123',
      })
      expect(subject).toContain('99,90')
      expect(html).toContain('João')
      expect(html).toContain('https://pay.test/123')
    })

    it('renders contrato_aprovado and contrato_reprovado', () => {
      const aprovado = renderTemplate('contrato_aprovado', { cliente_nome: 'X', score: 80, risco: 'baixo' })
      const reprovado = renderTemplate('contrato_reprovado', { cliente_nome: 'Y', score: 30, risco: 'alto', motivo: 'teste' })
      expect(aprovado.subject).toContain('aprovado')
      expect(aprovado.html).toContain('APROVADO')
      expect(reprovado.subject).toContain('reprovado')
      expect(reprovado.html).toContain('REPROVADO')
      expect(reprovado.html).toContain('teste')
    })

    it('renders lead_novo_inbound', () => {
      const { subject, html } = renderTemplate('lead_novo_inbound', {
        nome: 'Maria', cidade: 'SP', estado: 'SP', email: 'm@m.com',
        whatsapp: '11999', origem: 'bio_cliente',
      })
      expect(subject).toContain('Maria')
      expect(html).toContain('m@m.com')
      expect(html).toContain('bio_cliente')
    })

    it('throws on unknown template', () => {
      expect(() => renderTemplate('inexistente', {})).toThrow(/desconhecido/)
    })
  })

  describe('sendEmail', () => {
    let envSnap
    beforeEach(() => { envSnap = process.env.RESEND_API_KEY; delete process.env.RESEND_API_KEY })
    afterEach(() => { if (envSnap !== undefined) process.env.RESEND_API_KEY = envSnap })

    it('returns skipped when RESEND_API_KEY ausente (no-op seguro)', async () => {
      const result = await sendEmail({
        to: 'a@b.com', subject: 's', html: '<p>x</p>',
        tenantId: TENANT, tipo: 'live_encerrada',
      })
      expect(result.ok).toBe(false)
      expect(result.skipped).toBe(true)
    })

    it('returns error when params missing', async () => {
      const result = await sendEmail({ to: '', subject: '', html: '', tenantId: TENANT, tipo: 'x' })
      expect(result.ok).toBe(false)
      expect(result.error).toBeTruthy()
    })
  })
})

describe('GET /v1/notificacoes/log', () => {
  it('retorna lista paginada com total', async () => {
    const logRows = [
      { id: '1', tipo: 'live_encerrada', ref_id: null, destinatario: 'a@b.com',
        assunto: 's', enviado_em: new Date(), erro: null, criado_em: new Date() },
    ]
    const { app } = buildAppWithMocks({ logRows, totalRow: { total: 1 } })
    await app.register(notificacoesRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/notificacoes/log' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.itens).toHaveLength(1)
    expect(body.total).toBe(1)
    expect(body.pagina).toBe(1)
  })

  it('aceita query params tipo e desde', async () => {
    const { app } = buildAppWithMocks({ logRows: [], totalRow: { total: 0 } })
    await app.register(notificacoesRoutes)

    const res = await app.inject({
      method: 'GET',
      url: '/v1/notificacoes/log?tipo=boleto_vencido&desde=2026-01-01&pagina=2',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.pagina).toBe(2)
  })
})

describe('POST /v1/configuracoes/notificacao-teste', () => {
  it('400 quando tenant sem email_contato', async () => {
    const { app } = buildAppWithMocks({ tenantRow: { email_contato: null, nome: 't', notif_email_ativo: true } })
    await app.register(notificacoesRoutes)

    const res = await app.inject({ method: 'POST', url: '/v1/configuracoes/notificacao-teste' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/e-mail de contato/i)
  })

  it('200 com skipped quando RESEND_API_KEY ausente', async () => {
    delete process.env.RESEND_API_KEY
    const { app } = buildAppWithMocks({
      tenantRow: { email_contato: 'a@b.com', nome: 't', notif_email_ativo: true },
    })
    await app.register(notificacoesRoutes)

    const res = await app.inject({ method: 'POST', url: '/v1/configuracoes/notificacao-teste' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(false)
    expect(body.skipped).toBe(true)
  })
})
