import { describe, expect, it } from 'vitest'

import { ajustarLimitesDePool } from '../src/plugins/db.js'

// O pooler do Supabase em session mode (porta 5432) aceita 15 clientes e RECUSA o
// excedente com "(EMAXCONNSESSION) max clients reached in session mode" — o request
// vira 500, não espera na fila. Os pools pediam 20 + 5 = 25 contra esse teto, e o
// /home/dashboard sozinho toma várias conexões de uma vez: bastavam duas abas abertas
// para o dashboard quebrar de forma intermitente e "voltar sozinho" depois.
const LIMITE_POOLER = 15
const RESERVA = 2 // migrations, psql e health checks externos

describe('limites de pool contra a cota do pooler', () => {
  it('reduces both pools so they fit the pooler quota', () => {
    const r = ajustarLimitesDePool({
      appMax: 20,
      systemMax: 5,
      compartilhamPooler: true,
      limiteTotal: LIMITE_POOLER,
    })
    expect(r.ajustado).toBe(true)
    expect(r.appMax + r.systemMax).toBeLessThanOrEqual(LIMITE_POOLER - RESERVA)
    // cada pool continua utilizável
    expect(r.systemMax).toBeGreaterThanOrEqual(2)
    expect(r.appMax).toBeGreaterThanOrEqual(2)
  })

  it('leaves the configuration alone when it already fits', () => {
    const r = ajustarLimitesDePool({
      appMax: 8,
      systemMax: 3,
      compartilhamPooler: true,
      limiteTotal: LIMITE_POOLER,
    })
    expect(r).toMatchObject({ appMax: 8, systemMax: 3, ajustado: false })
  })

  it('does not clamp when the pools do not share the pooler', () => {
    const r = ajustarLimitesDePool({
      appMax: 20,
      systemMax: 5,
      compartilhamPooler: false,
      limiteTotal: LIMITE_POOLER,
    })
    expect(r).toMatchObject({ appMax: 20, systemMax: 5, ajustado: false })
  })

  it('clamps the final value, not the default — prod may set DB_POOL_MAX above the quota', () => {
    const r = ajustarLimitesDePool({
      appMax: 100,
      systemMax: 40,
      compartilhamPooler: true,
      limiteTotal: LIMITE_POOLER,
    })
    expect(r.appMax + r.systemMax).toBeLessThanOrEqual(LIMITE_POOLER - RESERVA)
  })

  it('scales up when the pooler allows more clients', () => {
    const r = ajustarLimitesDePool({
      appMax: 20,
      systemMax: 5,
      compartilhamPooler: true,
      limiteTotal: 50,
    })
    expect(r).toMatchObject({ appMax: 20, systemMax: 5, ajustado: false })
  })
})
