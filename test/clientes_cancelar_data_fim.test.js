import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { readFileSync } from 'node:fs'
import { invalidateTenant } from '../src/lib/dashboard-cache.js'
import { clientesRoutes } from '../src/routes/clientes.js'

vi.mock('../src/lib/dashboard-cache.js', async (importOriginal) => ({
  ...(await importOriginal()),
  invalidateTenant: vi.fn(),
}))

const tenantId = '11111111-1111-4111-8111-111111111111'
const clienteId = '22222222-2222-4222-8222-222222222222'

function buildApp(query) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async (request) => {
    if (!request.user) request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('withTenant', async (_tenant, fn) => fn({ query }))
  return app
}

async function patchStatus(status) {
  const calls = []
  const query = vi.fn(async (sql, params = []) => {
    calls.push([String(sql), params])
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
    if (sql.includes('UPDATE clientes SET')) return { rows: [{ id: clienteId, nome: 'Cliente', status, onboarding_step: null, tiktok_username: null, logo_url: null }] }
    return { rows: [{ status: 'ativo', nome: 'Cliente' }] }
  })
  const app = buildApp(query)
  await app.register(clientesRoutes)
  await app.inject({ method: 'PATCH', url: `/v1/clientes/${clienteId}`, payload: { status } })
  await app.close()
  return calls
}

describe('PATCH /v1/clientes/:id status → marcas.data_fim', () => {
  it.each([
    ['cancelado', 'inativa'],
    ['arquivado', 'arquivada'],
  ])('%s preenche data_fim sem sobrescrever a existente', async (status, marcaStatus) => {
    const calls = await patchStatus(status)
    const upd = calls.find(([sql]) => sql.includes(`UPDATE marcas SET status = '${marcaStatus}'`))
    expect(upd).toBeTruthy()
    // data_fim existente no futuro é puxada para hoje (LEAST); passada é mantida
    expect(upd[0]).toContain("data_fim = LEAST(COALESCE(data_fim, (now() AT TIME ZONE 'America/Sao_Paulo')::date), (now() AT TIME ZONE 'America/Sao_Paulo')::date)")
  })

  it.each(['cancelado', 'arquivado'])('%s apaga títulos intocados de competências após o mês de data_fim', async (status) => {
    const calls = await patchStatus(status)
    const del = calls.find(([sql]) => sql.includes('DELETE FROM receita_titulos'))
    expect(del).toBeTruthy()
    expect(del[0]).toContain('t.valor_pago = 0 AND t.perdido_em IS NULL')
    expect(del[0]).toContain("t.competencia > date_trunc('month', m.data_fim::timestamp)::date")
    expect(del[1]).toEqual([tenantId, clienteId])
    // mesma transação: DELETE entre BEGIN e COMMIT
    const ord = calls.map(([sql]) => sql)
    expect(ord.indexOf('BEGIN')).toBeLessThan(ord.findIndex((q) => q.includes('DELETE FROM receita_titulos')))
    expect(ord.findIndex((q) => q.includes('DELETE FROM receita_titulos'))).toBeLessThan(ord.indexOf('COMMIT'))
  })

  it('status ativo não apaga títulos', async () => {
    const calls = await patchStatus('ativo')
    expect(calls.some(([sql]) => sql.includes('DELETE FROM receita_titulos'))).toBe(false)
  })
})

describe('PATCH /v1/clientes/:id invalida o cache do tenant', () => {
  it('chama invalidateTenant(tenant) sem lista de namespaces (receita/DRE derivam de marcas)', async () => {
    invalidateTenant.mockClear()
    await patchStatus('cancelado')
    expect(invalidateTenant).toHaveBeenCalledTimes(1)
    expect(invalidateTenant).toHaveBeenCalledWith(tenantId)
  })
})

describe('helpers de ciclo de vida vivem em marca-lifecycle-sql.js', () => {
  it.each(['src/routes/clientes.js', 'src/services/client-brand.js', 'src/routes/marcas.js'])('%s não importa marca-sql.js', (file) => {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    expect(src).not.toMatch(/from '\.\.\/lib\/marca-sql\.js'/)
    expect(src).toMatch(/marca-lifecycle-sql\.js/)
  })

  it.each(['src/routes/usuarios.js', 'src/routes/apresentadoras.js'])('%s invalida o cache do tenant nas escritas de apresentadora', (file) => {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    expect(src).toContain("from '../lib/dashboard-cache.js'")
    expect((src.match(/invalidateTenant\(/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})

describe('DELETE /v1/clientes/:id → encerra a marca', () => {
  it('inativa a marca com data_fim e apaga títulos futuros intocados', async () => {
    const calls = []
    const query = vi.fn(async (sql, params = []) => {
      calls.push([String(sql), params])
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] }
      return { rows: [{ id: clienteId }] }
    })
    const app = buildApp(query)
    await app.register(clientesRoutes)
    const res = await app.inject({ method: 'DELETE', url: `/v1/clientes/${clienteId}` })
    await app.close()
    expect(res.statusCode).toBe(200)
    const sqls = calls.map(([s]) => s)
    expect(sqls.some((s) => s.includes("UPDATE marcas SET status = 'inativa'") && s.includes('data_fim = LEAST('))).toBe(true)
    expect(sqls.some((s) => s.includes('DELETE FROM receita_titulos'))).toBe(true)
    expect(sqls).toContain('COMMIT')
  })
})
