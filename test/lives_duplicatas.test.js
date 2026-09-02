// GET /v1/lives/duplicatas — a heurística que a operação chamou de quebrada.
//
// A regra "mesma marca + mesma apresentadora no mesmo dia" foi removida porque descrevia a
// operação normal: uma apresentadora faz várias lives da mesma marca no mesmo dia, todo dia.
// Sozinha, ela gerava da ordem de um cluster por apresentadora ativa por dia e, sem janela de
// tempo, o total só crescia — o aviso acendia sempre e por isso não significava nada.
//
// O que sobra é impossibilidade física: duas lives na MESMA cabine ao mesmo tempo. É também a
// assinatura do único caso real relatado — a mesma live lançada duas vezes à mão.

import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { livesRoutes } from '../src/routes/lives.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const liveA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const liveB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const liveC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function detalheRow(id, overrides = {}) {
  return {
    id,
    iniciado_em: '2026-09-01T17:00:00.000Z',
    encerrado_em: '2026-09-01T21:00:00.000Z',
    status: 'encerrada',
    status_publicacao: 'publicada',
    gmv: 1000,
    cabine_numero: 1,
    marca_nome: 'Rovitex',
    apresentadora_nome: 'Ana',
    ...overrides,
  }
}

function buildApp({ pares = [], detalhe = [] } = {}) {
  const app = Fastify()
  const calls = []

  const query = vi.fn(async (sql, params = []) => {
    const text = String(sql)
    calls.push({ sql: text, params })
    if (text.includes('WITH base AS')) return { rows: pares }
    if (text.includes('FROM lives l') && text.includes('cabine_numero')) return { rows: detalhe }
    return { rows: [] }
  })

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async (request) => {
    if (!request.user) request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('withTenant', async (_t, fn) => fn({ query }))
  app.decorate('audit', { log: async () => {} })
  app.decorate('cache', { invalidate: async () => {}, get: async () => null, set: async () => {} })

  return { app, query, calls }
}

function get(app, qs = '') {
  return app.inject({ method: 'GET', url: `/v1/lives/duplicatas${qs}` })
}

async function sqlDaHeuristica(qs = '') {
  const { app, calls } = buildApp()
  await app.register(livesRoutes)
  await get(app, qs)
  await app.close()
  return calls.find((c) => c.sql.includes('WITH base AS'))
}

describe('GET /v1/lives/duplicatas — regra', () => {
  it('não usa mais marca + apresentadora + dia', async () => {
    const { sql } = await sqlDaHeuristica()
    // Era a regra que transformava a operação normal em alerta.
    expect(sql).not.toContain('marca_apresentadora_dia')
    expect(sql).not.toMatch(/a\.marca_id\s*=\s*b\.marca_id/)
    expect(sql).not.toMatch(/a\.apresentadora_id\s*=\s*b\.apresentadora_id/)
    expect(sql).not.toMatch(/a\.dia\s*=\s*b\.dia/)
  })

  it('só compara lives da mesma cabine, e ignora live sem cabine', async () => {
    const { sql } = await sqlDaHeuristica()
    expect(sql).toMatch(/JOIN base b ON b\.id > a\.id AND b\.cabine_id = a\.cabine_id/)
    expect(sql).toContain('l.cabine_id IS NOT NULL')
  })

  it('exige que a sobreposição cubra metade da live mais curta', async () => {
    const { sql } = await sqlDaHeuristica()
    // Sem isso, live que começa quando a outra acaba (sobreposição de segundos) vira alerta.
    expect(sql).toContain('0.5 * LEAST')
    expect(sql).toContain('LEAST(a.fim, b.fim) - GREATEST(a.iniciado_em, b.iniciado_em)')
  })

  it('põe piso e teto na duração para não casar com tudo nem com nada', async () => {
    const { sql } = await sqlDaHeuristica()
    // Teto: live zumbi fechada com até 24h engolia a cabine inteira do dia.
    expect(sql).toContain("l.iniciado_em + INTERVAL '12 hours'")
    // Piso: live do import com encerrado_em = iniciado_em tem duração zero, e 0 >= 50% de 0.
    expect(sql).toContain("l.iniciado_em + INTERVAL '15 minutes'")
    expect(sql).toContain("l.iniciado_em + INTERVAL '4 hours'")
  })
})

describe('GET /v1/lives/duplicatas — janela de tempo', () => {
  it('limita a 90 dias por padrão', async () => {
    const { sql, params } = await sqlDaHeuristica()
    expect(sql).toContain("NOW() - ($1::int || ' days')::interval")
    expect(params[0]).toBe(90)
  })

  it('aceita ?dias e prende o valor entre 1 e 365', async () => {
    expect((await sqlDaHeuristica('?dias=7')).params[0]).toBe(7)
    expect((await sqlDaHeuristica('?dias=9999')).params[0]).toBe(365)
    expect((await sqlDaHeuristica('?dias=0')).params[0]).toBe(90)
    expect((await sqlDaHeuristica('?dias=abc')).params[0]).toBe(90)
  })
})

describe('GET /v1/lives/duplicatas — clusters', () => {
  it('devolve vazio quando não há par', async () => {
    const { app } = buildApp({ pares: [] })
    await app.register(livesRoutes)
    const res = await get(app)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ clusters: [] })
    await app.close()
  })

  it('agrupa lives ligadas transitivamente num cluster só', async () => {
    const { app } = buildApp({
      pares: [
        { id_a: liveA, id_b: liveB, motivo: 'cabine_horario' },
        { id_a: liveB, id_b: liveC, motivo: 'cabine_horario' },
      ],
      detalhe: [detalheRow(liveA), detalheRow(liveB), detalheRow(liveC)],
    })
    await app.register(livesRoutes)

    const { clusters } = (await get(app)).json()
    expect(clusters).toHaveLength(1)
    expect(clusters[0].total).toBe(3)
    expect(clusters[0].motivos).toEqual(['cabine_horario'])
    await app.close()
  })

  it('ordena as lives do cluster por início, para o operador comparar lado a lado', async () => {
    const { app } = buildApp({
      pares: [{ id_a: liveA, id_b: liveB, motivo: 'cabine_horario' }],
      detalhe: [
        detalheRow(liveA, { iniciado_em: '2026-09-01T20:00:00.000Z' }),
        detalheRow(liveB, { iniciado_em: '2026-09-01T17:00:00.000Z' }),
      ],
    })
    await app.register(livesRoutes)

    const { clusters } = (await get(app)).json()
    expect(clusters[0].lives.map((l) => l.id)).toEqual([liveB, liveA])
    await app.close()
  })
})
