import Fastify from 'fastify'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clienteInsightsRoutes } from '../src/routes/cliente_insights.js'

const tenant = '11111111-1111-4111-8111-111111111111'
const otherTenant = '22222222-2222-4222-8222-222222222222'
const user = '33333333-3333-4333-8333-333333333333'
const clienteA = '44444444-4444-4444-8444-444444444444'
const clienteB = '55555555-5555-4555-8555-555555555555'
const marcaA = '66666666-6666-4666-8666-666666666666'
const marcaB = '77777777-7777-4777-8777-777777777777'

let db
let app

beforeEach(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE clientes (id uuid, tenant_id uuid, user_id uuid, nome text, status text);
    CREATE TABLE marcas (id uuid, tenant_id uuid, cliente_id uuid, nome text, tipo text);
    CREATE TABLE lives (
      id uuid, tenant_id uuid, cliente_id uuid, marca_id uuid, status text, status_publicacao text,
      iniciado_em timestamptz, encerrado_em timestamptz, previsto_fim timestamptz,
      ads_gmv numeric, manual_gmv numeric, fat_gerado numeric,
      manual_orders integer, final_orders_count integer,
      arquivada_em timestamptz, uniao_destino_id uuid, uniao_desfeita_em timestamptz
    );
  `)
  await db.query(`INSERT INTO clientes VALUES
    ($1,$2,$3,'Cliente A','negociacao'), ($4,$2,NULL,'Cliente B','ativo')`, [clienteA, tenant, user, clienteB])
  await db.query(`INSERT INTO marcas VALUES
    ($1,$2,$3,'Marca A','cliente'), ($4,$2,$5,'Marca B','cliente')`, [marcaA, tenant, clienteA, marcaB, clienteB])
  await db.query(`INSERT INTO lives VALUES
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$1,$2,$3,'encerrada','revisado','2026-10-03 12:00Z','2026-10-03 14:00Z',NULL,100,NULL,NULL,3,NULL,NULL,NULL,NULL),
    ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',$1,$2,$3,'encerrada','publicado','2026-10-04 12:00Z','2026-10-04 13:00Z',NULL,0,NULL,NULL,0,NULL,NULL,NULL,NULL),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',$1,$2,$4,'encerrada','publicado','2026-10-05 12:00Z','2026-10-05 13:00Z',NULL,999,NULL,NULL,9,NULL,NULL,NULL,NULL),
    ('dddddddd-dddd-4ddd-8ddd-dddddddddddd',$1,$2,$3,'encerrada','rascunho','2026-10-06 12:00Z','2026-10-06 13:00Z',NULL,999,NULL,NULL,9,NULL,NULL,NULL,NULL),
    ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',$1,$2,$3,'em_andamento','publicado','2026-10-07 12:00Z',NULL,NULL,999,NULL,NULL,9,NULL,NULL,NULL,NULL),
    ('ffffffff-ffff-4fff-8fff-ffffffffffff',$1,$2,$3,'encerrada','publicado','2026-10-08 12:00Z','2026-10-08 13:00Z',NULL,999,NULL,NULL,9,NULL,'2026-10-09 00:00Z',NULL,NULL),
    ('12121212-1212-4212-8212-121212121212',$1,$2,$3,'encerrada','publicado','2026-10-09 12:00Z','2026-10-09 13:00Z',NULL,999,NULL,NULL,9,NULL,NULL,'13131313-1313-4313-8313-131313131313',NULL),
    ('14141414-1414-4414-8414-141414141414',$1,$2,$3,'encerrada','publicado','2026-10-10 12:00Z','2026-10-10 13:00Z',NULL,999,NULL,NULL,9,NULL,NULL,NULL,'2026-10-11 00:00Z'),
    -- Cliente e marca autorizados, mas tenant forjado: o filtro de tenant precisa excluí-la.
    ('15151515-1515-4515-8515-151515151515',$5,$2,$3,'encerrada','publicado','2026-10-03 12:00Z','2026-10-03 13:00Z',NULL,999999,NULL,NULL,999,NULL,NULL,NULL,NULL)
  `, [tenant, clienteA, marcaA, marcaB, otherTenant])

  app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { sub: user, tenant_id: tenant, papel: 'cliente_parceiro' }
  })
  app.decorate('requirePapel', () => async () => {})
  app.decorate('withTenant', async (_tenantId, fn) => fn(db))
  await app.register(clienteInsightsRoutes)
})

afterEach(async () => {
  if (app) await app.close()
  if (db) await db.close()
})

describe('cliente portal reviewed routes against PostgreSQL semantics', () => {
  it('shows only reviewed or published ended lives for the exact linked brand', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/cliente/home?ano=2026&mes=10' })

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('private, no-store')
    expect(response.json()).toMatchObject({
      marca: { id: marcaA, nome: 'Marca A' }, gmv_mes: 100, lives_mes: 2,
      horas_live_mes: 3, pedidos: 3, gmv_por_live: 50, gmv_por_hora: 33.33,
    })
  })

  it('returns sanitized paginated history and daily aggregates', async () => {
    const history = await app.inject({ method: 'GET', url: '/v1/cliente/conteudo/lives?ano=2026&mes=10&offset=0' })
    expect(history.statusCode).toBe(200)
    expect(history.json()).toMatchObject({ total: 2, limit: 50, offset: 0, resumo: { gmv: 100, lives: 2, pedidos: 3, horas: 3 } })
    expect(history.json().lives).toHaveLength(2)
    expect(Object.keys(history.json().lives[0]).sort()).toEqual(['duracao_min', 'encerrado_em', 'gmv', 'id', 'iniciado_em', 'pedidos', 'status', 'status_publicacao'])

    const daily = await app.inject({ method: 'GET', url: '/v1/cliente/analytics/diario?from=2026-10-03&to=2026-10-04' })
    expect(daily.statusCode).toBe(200)
    expect(daily.json()).toEqual([
      expect.objectContaining({ dia: '2026-10-03', gmv_total: 100, total_lives: 1, gmv_por_hora: 50 }),
      expect.objectContaining({ dia: '2026-10-04', gmv_total: 0, total_lives: 1, gmv_por_hora: 0 }),
    ])
  })

  it('keeps whole-period totals when the history page is beyond the first 50 lives', async () => {
    await db.query(`
      INSERT INTO lives
      SELECT ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
        $1::uuid, $2::uuid, $3::uuid, 'encerrada', 'revisado',
        '2026-10-15 12:00Z'::timestamptz, '2026-10-15 13:00Z'::timestamptz,
        NULL, 1, NULL, NULL, 1, NULL, NULL, NULL, NULL
      FROM generate_series(1, 51) AS i`, [tenant, clienteA, marcaA])

    const response = await app.inject({ method: 'GET', url: '/v1/cliente/conteudo/lives?ano=2026&mes=10&offset=50' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      total: 53, limit: 50, offset: 50,
      resumo: { gmv: 151, lives: 53, pedidos: 54, horas: 54 },
    })
    expect(response.json().lives).toHaveLength(3)
  })

  it('keeps unknown GMV and duration null while preserving measured zero', async () => {
    await db.query(`INSERT INTO lives VALUES
      ('16161616-1616-4616-8616-161616161616',$1,$2,$3,'encerrada','revisado','2026-10-12 12:00Z',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`,
    [tenant, clienteA, marcaA])

    const response = await app.inject({ method: 'GET', url: '/v1/cliente/conteudo/lives?ano=2026&mes=10' })
    expect(response.statusCode).toBe(200)
    expect(response.json().lives.find((live) => live.id === '16161616-1616-4616-8616-161616161616')).toMatchObject({
      gmv: null, pedidos: null, duracao_min: null,
    })
    expect(response.json().lives.find((live) => live.id === 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toMatchObject({
      gmv: 0, pedidos: 0, duracao_min: 60,
    })
    expect(response.json().resumo).toMatchObject({ gmv: null, horas: null })
    const home = await app.inject({ method: 'GET', url: '/v1/cliente/home?ano=2026&mes=10' })
    expect(home.json()).toMatchObject({ gmv_mes: null, horas_live_mes: null, gmv_por_live: null, gmv_por_hora: null })
  })

  it('rejects invalid calendar ranges before querying reviewed lives', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/cliente/analytics/diario?from=2026-02-31&to=2026-03-01' })
    expect(response.statusCode).toBe(400)
    expect(response.headers['cache-control']).toBe('private, no-store')
  })

  it('rejects malformed month and pagination inputs', async () => {
    const [month, offset] = await Promise.all([
      app.inject({ method: 'GET', url: '/v1/cliente/home?ano=2026&mes=10oops' }),
      app.inject({ method: 'GET', url: '/v1/cliente/conteudo/lives?ano=2026&mes=10&offset=50junk' }),
    ])
    expect(month.statusCode).toBe(400)
    expect(offset.statusCode).toBe(400)
  })

  it('calculates GMV per hour from raw positive duration before display rounding', async () => {
    await db.query(`INSERT INTO lives VALUES
      ('17171717-1717-4717-8717-171717171717',$1,$2,$3,'encerrada','revisado','2026-10-13 12:00Z','2026-10-13 12:00:10Z',NULL,10,NULL,NULL,1,NULL,NULL,NULL,NULL)`,
    [tenant, clienteA, marcaA])

    const response = await app.inject({ method: 'GET', url: '/v1/cliente/analytics/diario?from=2026-10-13&to=2026-10-13' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([expect.objectContaining({
      gmv_total: 10, horas_live: 0, gmv_por_hora: 3600, gmv_por_live: 10,
    })])
  })
})
