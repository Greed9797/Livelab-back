/**
 * Testes do serviço de comissão — src/services/comissao.js
 *
 * Cobre:
 *  1. isFimDeSemanaSP — detecção de sábado/domingo no fuso America/Sao_Paulo
 *  2. calcularComissaoApresentadora — regras de fim de semana, dia útil, sem vínculo
 *  3. calcularComissaoLivelab — cálculo direto, contratoPct null, arredondamento delegado ao Postgres
 */

import { describe, expect, it } from 'vitest'
import {
  calcularComissaoApresentadora,
  calcularComissaoLivelab,
  isFimDeSemanaSP,
} from '../src/services/comissao.js'

// ── Datas de referência (UTC) ─────────────────────────────────────────────
// 2026-06-06 02:00 UTC = sábado 23h no dia 05/06 UTC−3 → SÁBADO SP
const sabado   = new Date('2026-06-06T05:00:00.000Z')   // sábado 02h SP
// 2026-06-07 15:00 UTC = domingo 12h SP
const domingo  = new Date('2026-06-07T15:00:00.000Z')
// 2026-06-09 15:00 UTC = segunda-feira 12h SP
const segunda  = new Date('2026-06-09T15:00:00.000Z')
// 2026-06-10 15:00 UTC = terça-feira 12h SP
const terca    = new Date('2026-06-10T15:00:00.000Z')

// ──────────────────────────────────────────────────────────────────────────
// isFimDeSemanaSP
// ──────────────────────────────────────────────────────────────────────────
describe('isFimDeSemanaSP', () => {
  it('sábado UTC → true', () => {
    expect(isFimDeSemanaSP(sabado)).toBe(true)
  })

  it('domingo UTC → true', () => {
    expect(isFimDeSemanaSP(domingo)).toBe(true)
  })

  it('segunda → false', () => {
    expect(isFimDeSemanaSP(segunda)).toBe(false)
  })

  it('terça → false', () => {
    expect(isFimDeSemanaSP(terca)).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// calcularComissaoApresentadora
// ──────────────────────────────────────────────────────────────────────────
describe('calcularComissaoApresentadora', () => {
  it('fim de semana → pct = 2 independente do cadastro', () => {
    const result = calcularComissaoApresentadora({
      fatGerado: 1000,
      apresentadoraPct: 8,
      iniciadoEm: sabado,
      temApresentadora: true,
    })
    expect(result.pct).toBe(2)
    expect(result.valor).toBeCloseTo(20)
  })

  it('domingo → pct = 2', () => {
    const result = calcularComissaoApresentadora({
      fatGerado: 5000,
      apresentadoraPct: 10,
      iniciadoEm: domingo,
      temApresentadora: true,
    })
    expect(result.pct).toBe(2)
    expect(result.valor).toBeCloseTo(100)
  })

  it('dia útil com pct cadastrado → usa pct do cadastro', () => {
    const result = calcularComissaoApresentadora({
      fatGerado: 2000,
      apresentadoraPct: 5,
      iniciadoEm: segunda,
      temApresentadora: true,
    })
    expect(result.pct).toBe(5)
    expect(result.valor).toBeCloseTo(100)
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

// ──────────────────────────────────────────────────────────────────────────
// calcularComissaoLivelab
// ──────────────────────────────────────────────────────────────────────────
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
    // 333.33 * 3% = 9.9999 — o banco arredonda para 10.00
    const result = calcularComissaoLivelab({ fatGerado: 333.33, contratoPct: 3 })
    expect(result.valor).toBeCloseTo(10, 1)
  })
})
