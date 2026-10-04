import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { invalidateTenant } from '../src/lib/dashboard-cache.js'
import { marcasRoutes } from '../src/routes/marcas.js'
import { ensureClienteMarca } from '../src/services/client-brand.js'

vi.mock('../src/lib/dashboard-cache.js', async (importOriginal) => ({
  ...(await importOriginal()),
  invalidateTenant: vi.fn(),
}))

function buildApp(query) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: 'tenant-uuid-1', sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async (request) => {
    if (!request.user) request.user = { tenant_id: 'tenant-uuid-1', sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('withTenant', async (_t, fn) => fn({ query, release: vi.fn() }))
  return app
}

const HOJE = "(now() AT TIME ZONE 'America/Sao_Paulo')::date"
const ENCERRA = `data_fim = LEAST(COALESCE(data_fim, ${HOJE}), ${HOJE})`

async function patch(status, row = {}, extra = {}) {
  const query = vi.fn(async (sql) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] }
    return { rows: [{ id: 'm1', tipo: 'afiliada', cliente_id: null, data_fim: null, ...row }] }
  })
  const app = buildApp(query)
  await app.register(marcasRoutes)
  const res = await app.inject({ method: 'PATCH', url: '/v1/marcas/m1', payload: { status, ...extra } })
  await app.close()
  return { res, sql: query.mock.calls.map((c) => String(c[0])).find((s) => s.includes('UPDATE marcas SET status')) }
}

describe('marcas — ciclo de vida de data_fim', () => {
  it('DELETE /v1/marcas/:id preenche/puxa data_fim para hoje (LEAST)', async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 'm1' }] }))
    const app = buildApp(query)
    await app.register(marcasRoutes)
    const res = await app.inject({ method: 'DELETE', url: '/v1/marcas/m1' })
    await app.close()
    expect(res.statusCode).toBe(204)
    expect(query.mock.calls.map((c) => String(c[0])).some((s) => s.includes(ENCERRA))).toBe(true)
  })

  it.each(['inativa', 'arquivada'])('PATCH status %s encerra o contrato', async (status) => {
    const { res, sql } = await patch(status)
    expect(res.statusCode).toBe(200)
    expect(sql).toContain(ENCERRA)
  })

  it('PATCH status pausada não mexe em data_fim', async () => {
    const { sql } = await patch('pausada')
    expect(sql).not.toContain('data_fim')
  })

  it('PATCH com data_fim explícita no body prevalece sobre o encerramento automático', async () => {
    const query = vi.fn(async (sql) => (/^(BEGIN|COMMIT)/.test(sql) ? { rows: [] } : { rows: [{ id: 'm1', tipo: 'afiliada', cliente_id: null }] }))
    const app = buildApp(query)
    await app.register(marcasRoutes)
    await app.inject({ method: 'PATCH', url: '/v1/marcas/m1', payload: { status: 'inativa', data_fim: '2026-08-31' } })
    await app.close()
    const sql = query.mock.calls.map((c) => String(c[0])).find((s) => s.includes('UPDATE marcas SET'))
    expect(sql).not.toContain('LEAST')
  })

  it('PATCH ativa: limpa data_fim futura; data_fim vencida permanece e devolve aviso', async () => {
    const limpa = await patch('ativa', { data_fim: null })
    expect(limpa.sql).toContain(`CASE WHEN data_fim >= ${HOJE} THEN NULL ELSE data_fim END`)
    expect(limpa.res.json().aviso).toBeUndefined()
    const vencida = await patch('ativa', { data_fim: '2026-05-31' })
    expect(vencida.res.json().aviso).toBe('data_fim_expirada')
  })
})

describe('ensureClienteMarca — reativação com data_fim vencida', () => {
  function db(dataFim) {
    return {
      query: vi.fn(async (sql) => {
        if (/FROM marcas\s+WHERE tenant_id/.test(sql)) return { rows: [{ id: 'm1', status: 'inativa', has_baseline_condition: true }] }
        if (/FROM clientes/.test(sql)) return { rows: [{ status: 'ativo' }] }
        if (/UPDATE marcas/.test(sql)) return { rows: [{ id: 'm1', data_fim: dataFim }] }
        return { rows: [] }
      }),
    }
  }
  it('mantém data_fim vencida e sinaliza data_fim_expirada', async () => {
    const resultado = {}
    await ensureClienteMarca(db('2026-05-31'), { tenantId: 't', clienteId: 'c', activateExisting: true, resultado })
    expect(resultado.aviso).toBe('data_fim_expirada')
  })
  it('sem data_fim após reativar: sem aviso', async () => {
    const resultado = {}
    await ensureClienteMarca(db(null), { tenantId: 't', clienteId: 'c', activateExisting: true, resultado })
    expect(resultado.aviso).toBeUndefined()
  })
})

describe('PATCH /v1/marcas/:id invalida o cache do tenant', () => {
  it('invalida todos os namespaces (receita e DRE derivam de marcas)', async () => {
    invalidateTenant.mockClear()
    await patch('inativa')
    expect(invalidateTenant).toHaveBeenCalledWith('tenant-uuid-1')
  })
})

describe('PATCH /v1/marcas/:id — só transição real mexe em data_fim', () => {
  async function patchComAnterior(statusAnterior, body, row = {}) {
    const query = vi.fn(async (sql) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] }
      if (/^\s*SELECT status FROM marcas/.test(sql)) return { rows: [{ status: statusAnterior }] }
      return { rows: [{ id: 'm1', tipo: 'afiliada', cliente_id: null, data_fim: '2099-01-31', ...row }] }
    })
    const app = buildApp(query)
    await app.register(marcasRoutes)
    const res = await app.inject({ method: 'PATCH', url: '/v1/marcas/m1', payload: body })
    await app.close()
    const sqls = query.mock.calls.map((c) => String(c[0]))
    return { res, sqls, update: sqls.find((s) => s.includes('UPDATE marcas SET status')) }
  }

  it('salvar marca já ativa (status ativa no body) preserva data_fim planejada e não avisa', async () => {
    const { res, update } = await patchComAnterior('ativa', { status: 'ativa', logo_url: 'https://x.test/l.png' })
    expect(res.statusCode).toBe(200)
    expect(update).not.toContain('data_fim')
    expect(res.json().aviso).toBeUndefined()
  })

  it('reativar marca inativa limpa data_fim futura e avisa se ainda houver data_fim', async () => {
    const { res, update } = await patchComAnterior('inativa', { status: 'ativa' })
    expect(update).toContain('CASE WHEN data_fim >=')
    expect(res.json().aviso).toBe('data_fim_expirada')
  })

  it('data_fim explícita no body não gera aviso', async () => {
    const { res } = await patchComAnterior('inativa', { status: 'ativa', data_fim: '2099-01-31' })
    expect(res.json().aviso).toBeUndefined()
  })

  it('inativar apaga títulos futuros intocados; já inativa não repete', async () => {
    const a = await patchComAnterior('ativa', { status: 'inativa' })
    expect(a.sqls.some((s) => s.includes('DELETE FROM receita_titulos'))).toBe(true)
    const b = await patchComAnterior('inativa', { status: 'inativa' })
    expect(b.sqls.some((s) => s.includes('DELETE FROM receita_titulos'))).toBe(false)
  })

  it('DELETE /v1/marcas/:id apaga títulos futuros intocados', async () => {
    const query = vi.fn(async (sql) => (/^(BEGIN|COMMIT)/.test(sql) ? { rows: [] } : { rows: [{ id: 'm1' }] }))
    const app = buildApp(query)
    await app.register(marcasRoutes)
    await app.inject({ method: 'DELETE', url: '/v1/marcas/m1' })
    await app.close()
    expect(query.mock.calls.some((c) => String(c[0]).includes('DELETE FROM receita_titulos'))).toBe(true)
  })
})
