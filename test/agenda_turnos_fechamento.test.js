// Quem o operador informa NO FECHAMENTO é quem realmente apresentou — e essa informação
// é mais nova que o plano de revezamento da agenda. Dois caminhos erravam isso:
//
// - POST /v1/lives/manual herdava os turnos do evento mesmo quando o operador escolhia
//   outra pessoa. Com 2+ turnos os percentuais planejados somam 100%, então quem
//   apresentou ficava com R$ 0,00 em vendas_atribuidas (commission-engine.js:148-152).
//
// - PATCH /v1/lives/:id/encerrar acrescentava a apresentadora informada como 'apoio' ao
//   lado da linha PLANEJADA de quem não apresentou. Com percentual/gmv/segundos NULL nas
//   duas, a cascata de COALESCE dos rollups (performance-rollups.js:224-249) cai no degrau
//   `papel = 'principal'`: 100% do GMV e das horas para quem não estava lá, zero para quem
//   estava.

import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { livesRoutes } from '../src/routes/lives.js'

const tenantId = 'tenant-1'
const liveId = '11111111-1111-4111-8111-111111111111'
const cabineId = '22222222-2222-4222-8222-222222222222'
const marcaId = '33333333-3333-4333-8333-333333333333'
const agendaId = '44444444-4444-4444-8444-444444444444'
const ana = '55555555-5555-4555-8555-555555555555'
const bia = '66666666-6666-4666-8666-666666666666'
const carla = '77777777-7777-4777-8777-777777777777'

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
  app.decorate('audit', { log: async () => {} })
  return app
}

const turno = (apresentadora_id, hIni, hFim) => ({
  apresentadora_id,
  data_inicio: `2026-05-01T${String(hIni).padStart(2, '0')}:00:00-03:00`,
  data_fim: `2026-05-01T${String(hFim).padStart(2, '0')}:00:00-03:00`,
})

describe('POST /v1/lives/manual — apresentadora do fechamento x turnos do evento', () => {
  function makeQueryMock() {
    const v2Inserts = []
    const query = vi.fn(async (sql, args = []) => {
      if (sql.includes('FROM agenda_evento_apresentadoras')) {
        return { rows: [turno(ana, 14, 16), turno(bia, 16, 18)] }
      }
      if (sql.includes('FROM marcas') && sql.includes('WHERE id = $1')) {
        return { rows: [{ id: marcaId, cliente_id: null, tipo: 'afiliada' }] }
      }
      if (sql.includes('FROM cabines')) return { rows: [{ comissao_pct: '0', contrato_id: null }] }
      if (sql.includes('FROM apresentadoras')) return { rows: [{ user_id: 'user-carla', comissao_pct: null }] }
      if (sql.includes('INSERT INTO lives')) return { rows: [{ id: liveId }] }
      if (sql.includes('INSERT INTO live_apresentadoras_v2')) {
        v2Inserts.push(args)
        return { rows: [] }
      }
      return { rows: [] }
    })
    return { query, v2Inserts }
  }

  it('descarta o revezamento planejado quando o operador informa outra apresentadora', async () => {
    const { query, v2Inserts } = makeQueryMock()
    const app = buildApp(query)
    await app.register(livesRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/lives/manual',
      payload: {
        cabine_id: cabineId,
        marca_id: marcaId,
        tipo: 'afiliado',
        data: '2026-05-01',
        hora_inicio: '14:00',
        hora_fim: '18:00',
        fat_gerado: 1000,
        qtd_pedidos: 10,
        apresentador_id: carla,
        agenda_evento_id: agendaId,
      },
    })

    expect(res.statusCode).toBe(201)
    // Uma linha só, da Carla — não duas com Ana 50% / Bia 50%.
    expect(v2Inserts).toHaveLength(1)
    expect(v2Inserts[0]).toEqual([tenantId, liveId, carla])
    await app.close()
  })
})

describe('PATCH /v1/lives/:id/encerrar — apresentadora informada x rateio planejado', () => {
  function makeQueryMock(linhasV2) {
    const escritas = []
    const query = vi.fn(async (sql, args = []) => {
      if (sql.includes('FROM lives') && sql.includes("status = 'em_andamento'")) {
        return {
          rows: [{
            id: liveId,
            cabine_id: cabineId,
            cliente_id: null,
            apresentador_id: 'user-ana',
            status: 'em_andamento',
            iniciado_em: '2026-05-01T17:00:00.000Z',
            marca_id: marcaId,
            agenda_evento_id: agendaId,
          }],
        }
      }
      if (sql.includes('FROM cabines')) return { rows: [{ id: cabineId, contrato_id: null, status: 'ao_vivo' }] }
      if (sql.includes('FROM apresentadoras')) return { rows: [{ user_id: 'user-carla', comissao_pct: null }] }
      // Escritas antes da leitura: o DELETE e o INSERT também contêm
      // "FROM live_apresentadoras_v2" (o INSERT tem o CASE WHEN EXISTS).
      if (sql.includes('DELETE FROM live_apresentadoras_v2') || sql.includes('INSERT INTO live_apresentadoras_v2')) {
        escritas.push({ sql, args })
        return { rows: [] }
      }
      if (sql.includes('FROM live_apresentadoras_v2')) return { rows: linhasV2 }
      return { rows: [] }
    })
    return { query, escritas }
  }

  const planejadaDaAna = {
    apresentadora_id: ana,
    percentual_rateio: null,
    gmv_rateado: null,
    segundos_rateio: null,
  }

  it('substitui a linha planejada solitária por quem realmente apresentou', async () => {
    const { query, escritas } = makeQueryMock([planejadaDaAna])
    const app = buildApp(query)
    await app.register(livesRoutes)

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/lives/${liveId}/encerrar`,
      payload: { fat_gerado: 1000, apresentadora_id: carla },
    })

    expect(res.statusCode).toBe(200)
    const del = escritas.find((e) => e.sql.includes('DELETE FROM live_apresentadoras_v2'))
    expect(del).toBeTruthy()
    expect(del.args).toEqual([liveId, tenantId, ana])
    // Sem 'principal' sobrando, o CASE do INSERT elege a Carla como principal.
    expect(escritas.some((e) => e.sql.includes('INSERT INTO live_apresentadoras_v2'))).toBe(true)
    await app.close()
  })

  it('não toca num rateio já confirmado em "Dividir entre apresentadoras"', async () => {
    const { query, escritas } = makeQueryMock([
      { apresentadora_id: ana, percentual_rateio: 100, gmv_rateado: 1000, segundos_rateio: 14400 },
    ])
    const app = buildApp(query)
    await app.register(livesRoutes)

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/lives/${liveId}/encerrar`,
      payload: { fat_gerado: 1000, apresentadora_id: carla },
    })

    expect(res.statusCode).toBe(200)
    expect(escritas.some((e) => e.sql.includes('DELETE FROM live_apresentadoras_v2'))).toBe(false)
    await app.close()
  })

  it('não desfaz um revezamento planejado de duas pessoas', async () => {
    // Aqui o plano tem informação real que o encerramento não sabe recalcular: de quem
    // tirar o tempo da substituta. Fica como está e o conserto é o modal de rateio.
    const { query, escritas } = makeQueryMock([
      { apresentadora_id: ana, percentual_rateio: 50, gmv_rateado: null, segundos_rateio: null },
      { apresentadora_id: bia, percentual_rateio: 50, gmv_rateado: null, segundos_rateio: null },
    ])
    const app = buildApp(query)
    await app.register(livesRoutes)

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/lives/${liveId}/encerrar`,
      payload: { fat_gerado: 1000, apresentadora_id: carla },
    })

    expect(res.statusCode).toBe(200)
    expect(escritas.some((e) => e.sql.includes('DELETE FROM live_apresentadoras_v2'))).toBe(false)
    await app.close()
  })
})
