// PATCH /v1/lives/:id com apresentador_id numa live que já tem rateio entre duas
// apresentadoras.
//
// O caminho escalar apaga TODAS as linhas de live_apresentadoras_v2 e insere uma —
// destruindo um rateio de revezamento sem recalcular nada e sem passar pelo guard de
// comissão aprovada que o caminho `apresentadoras` tem. A UI já esconde o campo nesse
// caso (EditarLiveModal.tsx:362); faltava a API recusar.

import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { livesRoutes } from '../src/routes/lives.js'

const tenantId = 'tenant-1'
const liveId = '11111111-1111-4111-8111-111111111111'
const cabineId = '22222222-2222-4222-8222-222222222222'
const apresentadoraId = '33333333-3333-4333-8333-333333333333'
const userId = '44444444-4444-4444-8444-444444444444'
const marcaId = '55555555-5555-4555-8555-555555555555'

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

/** @param linhasV2 quantas apresentadoras a live tem em live_apresentadoras_v2 */
function makeQueryMock(linhasV2) {
  return vi.fn(async (sql) => {
    if (sql.includes('FROM lives l')) {
      return {
        rows: [{
          id: liveId,
          cabine_id: cabineId,
          cliente_id: null,
          marca_id: marcaId,
          apresentador_id: null,
          gestor_id: null,
          agenda_evento_id: null,
          status: 'encerrada',
          iniciado_em: '2026-04-08T17:00:00.000Z',
          encerrado_em: '2026-04-08T21:00:00.000Z',
          contrato_id: null,
        }],
      }
    }
    if (sql.includes('SELECT user_id FROM apresentadoras')) return { rows: [{ user_id: userId }] }
    // Totais que applyApresentadorasToLive usa para conferir se o rateio fecha a live.
    if (sql.includes('FROM lives WHERE id')) return { rows: [{ gmv: '0.00', segundos: 3600 }] }
    if (sql.includes('COUNT(*)::int AS n FROM live_apresentadoras_v2')) return { rows: [{ n: linhasV2 }] }
    return { rows: [] }
  })
}

describe('PATCH /v1/lives/:id — guard do rateio múltiplo', () => {
  it('recusa trocar a apresentadora escalar quando a live tem rateio, sem apagar nada', async () => {
    const query = makeQueryMock(2)
    const app = buildApp(query)
    await app.register(livesRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/lives/${liveId}`,
      payload: { apresentador_id: apresentadoraId },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ code: 'RATEIO_MULTIPLO' })
    // O rateio das duas continua no banco: nem DELETE, nem INSERT.
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM live_apresentadoras_v2'))).toBe(false)
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO live_apresentadoras_v2'))).toBe(false)
    expect(query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true)
  })

  it('deixa passar quando a live tem uma apresentadora só', async () => {
    const query = makeQueryMock(1)
    const app = buildApp(query)
    await app.register(livesRoutes)

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/lives/${liveId}`,
      payload: { apresentador_id: apresentadoraId },
    })

    expect(response.statusCode).toBe(200)
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM live_apresentadoras_v2'))).toBe(true)
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO live_apresentadoras_v2'))).toBe(true)
  })

  it('não interfere no caminho `apresentadoras`, que tem validação própria', async () => {
    const query = makeQueryMock(2)
    const app = buildApp(query)
    await app.register(livesRoutes)

    // Mandar os dois no mesmo PATCH é o fluxo de "dividir entre apresentadoras" com troca
    // da principal: quem manda é applyApresentadorasToLive, não o caminho escalar.
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/lives/${liveId}`,
      payload: {
        apresentador_id: apresentadoraId,
        apresentadoras: [
          { apresentadora_id: apresentadoraId, gmv: 0, segundos: 3600 },
        ],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(query.mock.calls.some(([sql]) => sql.includes('COUNT(*)::int AS n FROM live_apresentadoras_v2'))).toBe(false)
  })
})
