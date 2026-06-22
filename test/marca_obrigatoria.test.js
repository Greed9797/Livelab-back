import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { livesRoutes } from '../src/routes/lives.js'

// Mirrors the harness from test/lives_start.test.js
function buildApp({ queryMock, papel = 'franqueado' } = {}) {
  const app = Fastify()
  const release = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = {
      tenant_id: 'tenant-1',
      sub: '99999999-9999-4999-8999-999999999999',
      papel,
    }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('dbTenant', async () => ({ query: queryMock, release }))
  app.decorate('withTenant', async (tenantId, fn) => {
    const db = await app.dbTenant(tenantId)
    try {
      return await fn(db)
    } finally {
      db.release()
    }
  })

  return { app, release }
}

const cabineId = '11111111-1111-4111-8111-111111111111'
const clienteId = '22222222-2222-4222-8222-222222222222'

const cabineManualId = '11111111-1111-4111-8111-111111111111'
const clienteManualId = '22222222-2222-4222-8222-222222222222'

describe('Marca obrigatória — POST /v1/lives/manual', () => {
  it('POST /v1/lives/manual (cliente) sem marca resolvível responde 422 MARCA_OBRIGATORIA', async () => {
    // Query sequence for tipo='cliente' with clienteId but NO resolvable marca:
    // 1. BEGIN
    // 2. (no marca_id provided, skips marca lookup)
    // 3. (tipo='cliente', not afiliado/teste, skips marca-sistema fallback)
    // 4. (resolvedClienteId is set, skips CLIENTE_REQUIRED)
    // 5. After implementation: ensureClienteMarca's marca lookup → rows: []
    // 6. After implementation: ensureClienteMarca's client lookup → rows: [] (returns null)
    // → ROLLBACK + 422 MARCA_OBRIGATORIA
    const queryMock = vi.fn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return { rows: [] }
      // Inadimplência check
      if (sql.includes('FROM clientes') && sql.includes('SELECT status')) {
        return { rows: [{ status: 'ativo' }] }
      }
      // All marca lookups (ensureClienteMarca) → empty (no marca resolvível)
      if (sql.includes('FROM marcas')) return { rows: [] }
      // Client lookup inside ensureClienteMarca → empty (returns null)
      if (sql.includes('FROM clientes')) return { rows: [] }
      // cabine/contrato fallback
      if (sql.includes('FROM cabines')) return { rows: [{ comissao_pct: '10' }] }
      // apresentadoras
      if (sql.includes('FROM apresentadoras')) return { rows: [{ user_id: 'user-ap-1' }] }
      return { rows: [] }
    })

    const { app } = buildApp({ queryMock })
    await app.register(livesRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/lives/manual',
      payload: {
        cabine_id:   cabineManualId,
        cliente_id:  clienteManualId,
        tipo:        'cliente',
        data:        '2026-06-10',
        hora_inicio: '10:00',
        hora_fim:    '11:00',
        fat_gerado:  1000,
        qtd_pedidos: 1,
      },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('MARCA_OBRIGATORIA')

    await app.close()
  })
})

describe('Marca obrigatória — POST /v1/lives', () => {
  it('POST /v1/lives (cliente) sem marca resolvível responde 422 MARCA_OBRIGATORIA', async () => {
    // Query sequence for tipo='cliente' with clienteId but NO resolvable marca:
    // 1. BEGIN
    // 2. SELECT cabines FOR UPDATE → cabine found (disponivel, no contrato, no live_atual_id)
    // 3. SELECT agenda_eventos (auto-search today's cabine) → no agenda
    // 4. SELECT id FROM contratos (auto-reserve: cabine disponivel + clienteId) → no contract
    // 5. SELECT status FROM clientes (inadimplência check) → ativo
    // 6. (ensureClienteMarca) SELECT id, status FROM marcas WHERE cliente_id AND tipo='cliente' → no marca
    // 7. (ensureClienteMarca) SELECT id, nome, site, logo_url FROM clientes → no row (returns null)
    // → ROLLBACK + 422 MARCA_OBRIGATORIA
    const queryMock = vi.fn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return { rows: [] }
      if (sql.includes('FROM cabines')) {
        return {
          rows: [{ id: cabineId, numero: 1, status: 'disponivel', contrato_id: null, live_atual_id: null, ativo: true }],
        }
      }
      // Inadimplência check: SELECT status FROM clientes WHERE id = $1 AND tenant_id = $2
      if (sql.includes('FROM clientes') && sql.includes('SELECT status')) {
        return { rows: [{ status: 'ativo' }] }
      }
      // All other queries (agenda, contratos, marca lookups, ensureClienteMarca's client+marca queries) → empty
      return { rows: [] }
    })

    const { app } = buildApp({ queryMock })
    await app.register(livesRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/lives',
      payload: { cabine_id: cabineId, cliente_id: clienteId, tipo: 'cliente' },
    })

    expect(res.statusCode).toBe(422)
    expect(res.json().code).toBe('MARCA_OBRIGATORIA')

    await app.close()
  })
})
