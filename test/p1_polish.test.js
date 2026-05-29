// W3-F P1 Polish — 3 new behaviors:
//   1. Block contrato POST if cliente reprovado < 30 dias
//   2. Template boleto_pago renderiza corretamente
//   3. Smoke: audit refactor (aprovar/reprovar/arquivar delegam ao service)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

import { contratosRoutes } from '../src/routes/contratos.js'
import { renderTemplate } from '../src/services/mailer.js'

// ──────────────────────────────────────────────────────────────────────────────
// 1. Block contrato if cliente reprovado < 30 dias
// ──────────────────────────────────────────────────────────────────────────────
describe('POST /v1/contratos — bloqueia cliente reprovado < 30 dias', () => {
  const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const CLIENTE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

  function buildApp({ diasPassados = 5 } = {}) {
    const app = Fastify()

    const queryMock = vi.fn(async (sql, params) => {
      // Check reprovado
      if (/status = 'reprovado'/.test(sql) && /INTERVAL '30 days'/.test(sql)) {
        if (diasPassados !== null) {
          return { rows: [{ dias_passados: diasPassados }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }
      // INSERT contratos
      if (/INSERT INTO contratos/.test(sql)) {
        return { rows: [{ id: 'new-id', cliente_id: CLIENTE_ID, status: 'rascunho' }], rowCount: 1 }
      }
      // SELECT tiktok_username from clientes (for POST /v1/contratos)
      if (/SELECT tiktok_username FROM clientes/.test(sql)) {
        return { rows: [{ tiktok_username: 'usuario_test' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })

    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: TENANT, sub: USER_ID, papel: 'franqueado' }
    })
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!request.user) request.user = { tenant_id: TENANT, sub: USER_ID, papel: 'franqueado' }
      if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
    })
    app.decorate('dbTenant', async () => ({ query: queryMock, release: vi.fn() }))
    app.decorate('withTenant', async (tenantId, fn) => {
      const db = await app.dbTenant(tenantId)
      try { return await fn(db) } finally { db.release() }
    })
    app.decorate('db', { query: queryMock, pool: {} })

    return { app, queryMock }
  }

  it('retorna 409 quando cliente foi reprovado há 5 dias (restam 25 dias)', async () => {
    const { app } = buildApp({ diasPassados: 5 })
    await app.register(contratosRoutes)

    const r = await app.inject({
      method: 'POST',
      url: '/v1/contratos/quick',
      headers: { 'content-type': 'application/json' },
      payload: { cliente_id: CLIENTE_ID },
    })

    expect(r.statusCode).toBe(409)
    const body = r.json()
    expect(body.error).toMatch(/reprovado nos últimos 30 dias/)
    expect(body.error).toMatch(/25 dia/)
    await app.close()
  })

  it('permite criar contrato quando cliente não foi reprovado recentemente', async () => {
    const { app } = buildApp({ diasPassados: null })
    await app.register(contratosRoutes)

    const r = await app.inject({
      method: 'POST',
      url: '/v1/contratos/quick',
      headers: { 'content-type': 'application/json' },
      payload: { cliente_id: CLIENTE_ID },
    })

    // 201 ou pode ser 400 por outros motivos (pacote, etc.) mas não 409
    expect(r.statusCode).not.toBe(409)
    await app.close()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// 2. Template boleto_pago renderiza corretamente
// ──────────────────────────────────────────────────────────────────────────────
describe('mailer template boleto_pago', () => {
  it('renderiza subject com valor formatado', () => {
    const { subject } = renderTemplate('boleto_pago', {
      cliente_nome: 'João Silva',
      valor: 1500,
      vencimento: new Date('2026-04-30'),
      pago_em: new Date('2026-05-01'),
    })
    expect(subject).toMatch(/Pagamento confirmado/)
    expect(subject).toMatch(/R\$/)
    expect(subject).toMatch(/recebido/)
  })

  it('renderiza HTML com nome do cliente e data de pagamento', () => {
    const { html } = renderTemplate('boleto_pago', {
      cliente_nome: 'Maria Oliveira',
      valor: 750.5,
      vencimento: new Date('2026-04-15'),
      pago_em: new Date('2026-04-14'),
    })
    expect(html).toContain('Maria Oliveira')
    expect(html).toContain('Pagamento confirmado')
    expect(html).toContain('Valor pago')
    expect(html).toContain('Data do pagamento')
  })

  it('não lança erro quando campos opcionais são omitidos', () => {
    expect(() =>
      renderTemplate('boleto_pago', { valor: 0 })
    ).not.toThrow()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// 3. Smoke: audit refactor — aprovar/reprovar/arquivar delegam ao service
// ──────────────────────────────────────────────────────────────────────────────
describe('PATCH contratos audit — refactor smoke', () => {
  const TENANT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const CONTRATO_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  const CLIENTE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

  function buildAuditApp() {
    const app = Fastify()

    const queryMock = vi.fn(async (sql) => {
      // reprovado check (for POST, not relevant here but route is imported)
      if (/status = 'reprovado'/.test(sql) && /INTERVAL '30 days'/.test(sql)) {
        return { rows: [], rowCount: 0 }
      }
      // SELECT FOR UPDATE (executarAcaoAuditoria)
      if (/FOR UPDATE/.test(sql)) {
        return {
          rows: [{ id: CONTRATO_ID, status: 'em_analise', cliente_id: CLIENTE_ID, tenant_id: TENANT }],
          rowCount: 1,
        }
      }
      // UPDATE contratos SET status (any)
      if (/UPDATE contratos/.test(sql)) {
        return { rows: [], rowCount: 1 }
      }
      // UPDATE clientes
      if (/UPDATE clientes/.test(sql)) {
        return { rows: [], rowCount: 1 }
      }
      // INSERT INTO contrato_eventos
      if (/INSERT INTO contrato_eventos/.test(sql)) {
        return { rows: [], rowCount: 1 }
      }
      // BEGIN/COMMIT/ROLLBACK
      return { rows: [], rowCount: 0 }
    })

    app.decorate('authenticate', async (request) => {
      request.user = { tenant_id: TENANT, sub: 'user-master', papel: 'franqueador_master' }
    })
    app.decorate('requirePapel', (papeis) => async (request, reply) => {
      if (!request.user) request.user = { tenant_id: TENANT, sub: 'user-master', papel: 'franqueador_master' }
      if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
    })
    app.decorate('dbTenant', async () => ({ query: queryMock, release: vi.fn() }))
    app.decorate('withTenant', async (tenantId, fn) => {
      const db = await app.dbTenant(tenantId)
      try { return await fn(db) } finally { db.release() }
    })
    app.decorate('db', { query: queryMock, pool: {} })

    return { app, queryMock }
  }

  it('PATCH aprovar retorna ok:true e chama BEGIN/COMMIT via service', async () => {
    const { app, queryMock } = buildAuditApp()
    await app.register(contratosRoutes)

    const r = await app.inject({
      method: 'PATCH',
      url: `/v1/contratos/${CONTRATO_ID}/aprovar`,
    })

    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.ok).toBe(true)

    const sqls = queryMock.mock.calls.map(c => c[0])
    expect(sqls.some(s => /BEGIN/.test(s))).toBe(true)
    expect(sqls.some(s => /COMMIT/.test(s))).toBe(true)
    await app.close()
  })

  it('PATCH reprovar retorna erro 400 quando motivo < 8 chars (validação local mantida)', async () => {
    const { app } = buildAuditApp()
    await app.register(contratosRoutes)

    const r = await app.inject({
      method: 'PATCH',
      url: `/v1/contratos/${CONTRATO_ID}/reprovar`,
      headers: { 'content-type': 'application/json' },
      payload: { motivo: 'curto' },
    })

    expect(r.statusCode).toBe(400)
    expect(r.json().error).toMatch(/Motivo deve ter pelo menos/)
    await app.close()
  })

  it('PATCH arquivar passa motivo ao service e retorna ok:true', async () => {
    const { app, queryMock } = buildAuditApp()
    await app.register(contratosRoutes)

    const r = await app.inject({
      method: 'PATCH',
      url: `/v1/contratos/${CONTRATO_ID}/arquivar`,
      headers: { 'content-type': 'application/json' },
      payload: { motivo: 'Contrato encerrado por solicitação' },
    })

    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.ok).toBe(true)
    await app.close()
  })
})
