import { readFile } from 'node:fs/promises'
import Fastify from 'fastify'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const recalc = vi.hoisted(() => vi.fn(async () => ({ updated: 0 })))
vi.mock('../src/routes/vendas_atribuidas.js', () => ({ recalcularVendasAtribuidasApresentadora: recalc }))

const { feriadosRoutes } = await import('../src/routes/feriados.js')
const { feriadosDoPeriodo } = await import('../src/services/feriados.js')

const tenant = '11111111-1111-4111-8111-111111111111'
const user = '44444444-4444-4444-8444-444444444444'
const ana = '22222222-2222-4222-8222-222222222222'
let db
let app

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE livelab_portal_runtime;
    CREATE TABLE tenants(id uuid PRIMARY KEY);
    CREATE TABLE users(id uuid PRIMARY KEY);
    CREATE TABLE vendas_atribuidas(tenant_id uuid, apresentadora_id uuid, data date);
    INSERT INTO tenants VALUES ('${tenant}');
    INSERT INTO users VALUES ('${user}');
    INSERT INTO vendas_atribuidas VALUES ('${tenant}', '${ana}', '2026-11-21'), ('${tenant}', NULL, '2026-11-21'), ('${tenant}', '${ana}', '2026-10-31');
  `)
  const sql = await readFile(new URL('../migrations/188_feriados.sql', import.meta.url), 'utf8')
  await db.exec(sql)
  await db.exec(sql) // idempotente
  app = Fastify()
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    request.user = { tenant_id: tenant, sub: user, papel: request.headers['x-papel'] ?? 'franqueado' }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'forbidden' })
  })
  app.decorate('withTenant', async (_tenant, fn) => fn(db))
  app.decorate('audit', { log: vi.fn().mockResolvedValue(undefined) })
  await app.register(feriadosRoutes)
})

afterAll(async () => {
  await app?.close()
  await db?.close()
})

const get = async (papel) => (await app.inject({ method: 'GET', url: '/v1/feriados?ano=2026', headers: papel ? { 'x-papel': papel } : {} })).json()
const item = (lista, data) => lista.items.find((f) => f.data === data)

describe('feriados da unidade', () => {
  it('lista o calendário embutido; financeiro vê, mas não edita', async () => {
    const lista = await get('financeiro')
    expect(item(lista, '2026-11-20')).toEqual({ data: '2026-11-20', nome: 'Consciência Negra', ativo: true, origem: 'calendario', ajustado: false })
    expect(lista.pode_editar).toBe(false)
    const put = await app.inject({ method: 'PUT', url: '/v1/feriados/2026-11-20', headers: { 'x-papel': 'financeiro' }, payload: { nome: 'x', ativo: false } })
    expect(put.statusCode).toBe(403)
  })

  it('desliga um feriado embutido, recalcula o mês e volta ao calendário ao remover o ajuste', async () => {
    const put = await app.inject({ method: 'PUT', url: '/v1/feriados/2026-11-20', payload: { nome: 'Consciência Negra', ativo: false } })
    expect(put.statusCode).toBe(200)
    expect(put.json()).toEqual({ data: '2026-11-20', nome: 'Consciência Negra', ativo: false })
    expect(recalc).toHaveBeenCalledTimes(1)
    expect(recalc).toHaveBeenCalledWith(db, { tenantId: tenant, apresentadoraId: ana, mesReferencia: '2026-11' })
    expect(item(await get(), '2026-11-20')).toMatchObject({ ativo: false, origem: 'calendario', ajustado: true })
    expect((await feriadosDoPeriodo(db, tenant, '2026-11-01', '2026-11-30')).has('2026-11-20')).toBe(false)

    expect((await app.inject({ method: 'DELETE', url: '/v1/feriados/2026-11-20' })).statusCode).toBe(200)
    expect((await feriadosDoPeriodo(db, tenant, '2026-11-01', '2026-11-30')).get('2026-11-20')).toBe('Consciência Negra')
    expect((await app.inject({ method: 'DELETE', url: '/v1/feriados/2026-11-20' })).statusCode).toBe(404)
  })

  it('acrescenta feriado da unidade e valida a entrada', async () => {
    const put = await app.inject({ method: 'PUT', url: '/v1/feriados/2026-03-19', payload: { nome: '  São José  ' } })
    expect(put.json()).toEqual({ data: '2026-03-19', nome: 'São José', ativo: true })
    expect(item(await get(), '2026-03-19')).toMatchObject({ origem: 'unidade', ajustado: true, ativo: true })
    expect((await app.inject({ method: 'PUT', url: '/v1/feriados/2026-02-30', payload: { nome: 'x' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PUT', url: '/v1/feriados/2026-03-20', payload: { nome: ' ' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PUT', url: '/v1/feriados/2026-03-20', payload: { nome: 'x', extra: 1 } })).statusCode).toBe(400)
  })
})
