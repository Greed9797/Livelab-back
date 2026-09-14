import { describe, expect, it } from 'vitest'
import { parsePortalCount, parsePortalMoney } from '../src/lib/portal-submission-input.js'
import { requiresCurrentPortalMonth } from '../src/routes/portal_apresentadora.js'

describe('portal submission input', () => {
  it.each([
    ['1234', '1234.00'],
    ['1234,56', '1234.56'],
    ['1.234,56', '1234.56'],
    ['1,234.56', '1234.56'],
    ['1.234', '1234.00'],
  ])('canonicalizes money %s', (input, value) => {
    expect(parsePortalMoney(input)).toEqual({ ok: true, value })
  })

  it.each(['1,234', '1,2345', '1e3', '-1'])('rejects ambiguous or unsafe money %s', (input) => {
    expect(parsePortalMoney(input)).toMatchObject({ ok: false })
  })

  it('parses grouped counts without accepting decimal punctuation', () => {
    expect(parsePortalCount('1.234', 2_147_483_647)).toEqual({ ok: true, value: 1234 })
    expect(parsePortalCount('1,234', 2_147_483_647)).toMatchObject({ ok: false })
  })

  it('accepts only finished intervals from the current São Paulo month and day', () => {
    const now = new Date('2026-10-01T02:30:00Z') // 30/09 in São Paulo
    expect(requiresCurrentPortalMonth({ iniciado_em: '2026-09-30T18:00:00-03:00', encerrado_em: '2026-09-30T20:00:00-03:00' }, now)).toBe(true)
    expect(requiresCurrentPortalMonth({ iniciado_em: '2026-10-01T00:10:00-03:00', encerrado_em: '2026-10-01T01:10:00-03:00' }, now)).toBe(false)
    expect(requiresCurrentPortalMonth({ iniciado_em: '2026-09-30T22:00:00-03:00', encerrado_em: '2026-10-01T00:10:00-03:00' }, now)).toBe(false)
  })
})
