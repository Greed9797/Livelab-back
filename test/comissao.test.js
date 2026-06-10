import { describe, expect, it } from 'vitest'

import {
  calcularComissaoApresentadora,
  calcularComissaoLivelab,
  isFimDeSemanaSP,
} from '../src/services/comissao.js'

// ──────────────────────────────────────────────────────────────
// isFimDeSemanaSP
// ──────────────────────────────────────────────────────────────
describe('isFimDeSemanaSP', () => {
  it('retorna true para sábado em America/Sao_Paulo', () => {
    // 2026-06-06 12:00 UTC = sáb 09:00 BRT (UTC-3)
    const sabado = new Date('2026-06-06T12:00:00Z')
    expect(isFimDeSemanaSP(sabado)).toBe(true)
  })

  it('retorna true para domingo em America/Sao_Paulo', () => {
    // 2026-06-07 15:00 UTC = dom 12:00 BRT
    const domingo = new Date('2026-06-07T15:00:00Z')
    expect(isFimDeSemanaSP(domingo)).toBe(true)
  })

  it('retorna false para uma segunda-feira em America/Sao_Paulo', () => {
    // 2026-06-08 12:00 UTC = seg 09:00 BRT
    const segunda = new Date('2026-06-08T12:00:00Z')
    expect(isFimDeSemanaSP(segunda)).toBe(false)
  })

  it('boundary: UTC que é sexta 23h SP → NÃO é fim de semana', () => {
    // Sex 2026-06-05 23:00 BRT (UTC-3) = sáb 2026-06-06 02:00 UTC
    // 23h de sexta ainda é sexta em SP → false
    const sextaNoite = new Date('2026-06-06T02:00:00Z')
    expect(isFimDeSemanaSP(sextaNoite)).toBe(false)
  })

  it('boundary: UTC que é domingo 23h SP → É fim de semana', () => {
    // Dom 2026-06-07 23:00 BRT = seg 2026-06-08 02:00 UTC
    // 23h do domingo ainda é domingo em SP → true
    const domingoNoite = new Date('2026-06-08T02:00:00Z')
    expect(isFimDeSemanaSP(domingoNoite)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────
// calcularComissaoApresentadora
// ──────────────────────────────────────────────────────────────
describe('calcularComissaoApresentadora', () => {
  // Datas auxiliares
  // Sáb 2026-06-06 12:00 UTC (09:00 BRT)
  const sabado = new Date('2026-06-06T12:00:00Z')
  // Dom 2026-06-07 12:00 UTC
  const domingo = new Date('2026-06-07T12:00:00Z')
  // Seg 2026-06-08 12:00 UTC
  const segunda = new Date('2026-06-08T12:00:00Z')

  it('sábado → pct = 2 independente do cadastro', () => {
    const result = calcularComissaoApresentadora({
      fatGerado: 1000,
      apresentadoraPct: 5,
      iniciadoEm: sabado,
      temApresentadora: true,
    })
    expect(result.pct).toBe(2)
    expect(result.valor).toBeCloseTo(20)
  })

  it('domingo → pct = 2 independente do cadastro', () => {
    const result = calcularComissaoApresentadora({
      fatGerado: 2000,
      apresentadoraPct: 3,
      iniciadoEm: domingo,
      temApresentadora: true,
    })
    expect(result.pct).toBe(2)
    expect(result.valor).toBeCloseTo(40)
  })

  it('fim de semana com apresentadoraPct null → ainda pct 2 (override fixo)', () => {
    const result = calcularComissaoApresentadora({
      fatGerado: 1000,
      apresentadoraPct: null,
      iniciadoEm: sabado,
      temApresentadora: true,
    })
    expect(result.pct).toBe(2)
    expect(result.valor).toBeCloseTo(20)
  })

  it('dia útil com apresentadoraPct definido → usa pct do cadastro', () => {
    const result = calcularComissaoApresentadora({
      fatGerado: 1000,
      apresentadoraPct: 5,
      iniciadoEm: segunda,
      temApresentadora: true,
    })
    expect(result.pct).toBe(5)
    expect(result.valor).toBeCloseTo(50)
  })

  it('dia útil sem apresentadoraPct → null/null (pct não negociado)', () => {
    const result = calcularComissaoApresentadora({
      fatGerado: 1000,
      apresentadoraPct: null,
      iniciadoEm: segunda,
      temApresentadora: true,
    })
    expect(result.pct).toBeNull()
    expect(result.valor).toBeNull()
  })

  it('sem apresentadora vinculada → null/null independente do dia', () => {
    const resultSab = calcularComissaoApresentadora({
      fatGerado: 5000,
      apresentadoraPct: 10,
      iniciadoEm: sabado,
      temApresentadora: false,
    })
    expect(resultSab.pct).toBeNull()
    expect(resultSab.valor).toBeNull()

    const resultSeg = calcularComissaoApresentadora({
      fatGerado: 5000,
      apresentadoraPct: 10,
      iniciadoEm: segunda,
      temApresentadora: false,
    })
    expect(resultSeg.pct).toBeNull()
    expect(resultSeg.valor).toBeNull()
  })

  it('fat_gerado = 0 → valor = 0 com pct registrado', () => {
    const result = calcularComissaoApresentadora({
      fatGerado: 0,
      apresentadoraPct: 5,
      iniciadoEm: segunda,
      temApresentadora: true,
    })
    expect(result.pct).toBe(5)
    expect(result.valor).toBe(0)
  })

  it('fat_gerado = 0 em fim de semana → valor = 0 com pct = 2', () => {
    const result = calcularComissaoApresentadora({
      fatGerado: 0,
      apresentadoraPct: 8,
      iniciadoEm: domingo,
      temApresentadora: true,
    })
    expect(result.pct).toBe(2)
    expect(result.valor).toBe(0)
  })
})

// ──────────────────────────────────────────────────────────────
// calcularComissaoLivelab
// ──────────────────────────────────────────────────────────────
describe('calcularComissaoLivelab', () => {
  it('calcula corretamente: 2000 * 10% = 200', () => {
    const result = calcularComissaoLivelab({ fatGerado: 2000, contratoPct: 10 })
    expect(result.pct).toBe(10)
    expect(result.valor).toBeCloseTo(200)
  })

  it('contratoPct null → pct 0, valor 0', () => {
    const result = calcularComissaoLivelab({ fatGerado: 5000, contratoPct: null })
    expect(result.pct).toBe(0)
    expect(result.valor).toBe(0)
  })

  it('fat_gerado 0 → valor 0', () => {
    const result = calcularComissaoLivelab({ fatGerado: 0, contratoPct: 15 })
    expect(result.pct).toBe(15)
    expect(result.valor).toBe(0)
  })

  it('retorna float cru (arredondamento delegado ao Postgres NUMERIC 15,2)', () => {
    // 333.33 * 3% = 9.9999 — o banco arredonda para 10.00; aqui retornamos o float puro
    // para manter paridade exata com o legado (cabines.js antes da extração).
    // toBeCloseTo(10, 1) garante que está próximo de 10 sem exigir arredondamento JS.
    const result = calcularComissaoLivelab({ fatGerado: 333.33, contratoPct: 3 })
    expect(result.valor).toBeCloseTo(10, 1)
  })
})
