// PATCH /v1/lives/:id/encerrar grava papel EXPLÍCITO em live_apresentadoras_v2.
//
// A coluna tem DEFAULT 'principal'. Numa live aberta com revezamento (duas linhas
// semeadas a partir dos turnos da agenda) o encerramento acrescentava uma SEGUNDA
// 'principal', e todo LEFT JOIN por papel='principal' passava a devolver a live duas
// vezes — GMV e horas dobrados na tela de operacional.

import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { livesRoutes } from '../src/routes/lives.js'

const tenantId = 'tenant-1'
const liveId = '11111111-1111-4111-8111-111111111111'
const cabineId = '22222222-2222-4222-8222-222222222222'
const marcaId = '33333333-3333-4333-8333-333333333333'
const apresentadoraId = '44444444-4444-4444-8444-444444444444'

function buildApp(queryMock) {
  const app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: '99999999-9999-4999-8999-999999999999', papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async () => {})
  app.decorate('dbTenant', async () => ({ query: queryMock, release: vi.fn() }))
  app.decorate('withTenant', async (_t, fn) => {
    const db = await app.dbTenant(_t)
    try {
      return await fn(db)
    } finally {
      db.release()
    }
  })
  return app
}

function makeQueryMock() {
  const query = vi.fn(async (sql) => {
    if (sql.includes('FROM lives') && sql.includes("status = 'em_andamento'")) {
      return {
        rows: [{
          id: liveId,
          cabine_id: cabineId,
          cliente_id: null,
          apresentador_id: null,
          status: 'em_andamento',
          iniciado_em: '2026-04-08T17:00:00.000Z',
          marca_id: marcaId,
          agenda_evento_id: null,
        }],
      }
    }
    if (sql.includes('FROM cabines')) return { rows: [{ id: cabineId, contrato_id: null, status: 'ao_vivo' }] }
    if (sql.includes('FROM apresentadoras')) return { rows: [{ user_id: null, comissao_pct: null }] }
    return { rows: [] }
  })
  return query
}

describe('PATCH /v1/lives/:id/encerrar — papel da apresentadora', () => {
  it('deriva o papel por CASE em vez de aceitar o DEFAULT da coluna', async () => {
    const query = makeQueryMock()
    const app = buildApp(query)
    await app.register(livesRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/lives/${liveId}/encerrar`,
      payload: { fat_gerado: 1000, apresentadora_id: apresentadoraId },
    })

    expect(response.statusCode).toBe(200)

    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO live_apresentadoras_v2'))
    expect(insert).toBeTruthy()
    const [sql, params] = insert
    expect(sql).toContain('(tenant_id, live_id, apresentadora_id, papel)')
    expect(sql).toContain("THEN 'apoio' ELSE 'principal' END")
    // A decisão é do banco, dentro do mesmo statement: um SELECT antes abriria janela
    // para duas requisições de encerramento gravarem 'principal' as duas.
    expect(sql).toContain("WHERE live_id = $2::uuid AND tenant_id = $1::uuid")
    expect(params).toEqual([tenantId, liveId, apresentadoraId])
    // Nem gmv nem tempo: quem escreve dinheiro realizado é applyApresentadorasToLive.
    expect(sql).not.toContain('gmv_rateado')
    expect(sql).not.toContain('segundos_rateio')
  })

  it('não escreve em v2 quando o encerramento não informa apresentadora', async () => {
    const query = makeQueryMock()
    const app = buildApp(query)
    await app.register(livesRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/lives/${liveId}/encerrar`,
      payload: { fat_gerado: 1000 },
    })

    expect(response.statusCode).toBe(200)
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO live_apresentadoras_v2'))).toBe(false)
  })
})
