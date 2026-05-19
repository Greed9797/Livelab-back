import { describe, expect, it } from 'vitest'
import { parseMoneyToDecimal } from '../src/lib/money.js'

describe('parseMoneyToDecimal', () => {
  it.each([
    ['1142', 1142],
    ['1.142', 1142],
    ['1142,00', 1142],
    ['1.142,50', 1142.5],
    ['R$ 1.142,50', 1142.5],
    ['1142.00', 1142],
  ])('parses %s as decimal reais', (input, expected) => {
    expect(parseMoneyToDecimal(input)).toBe(expected)
  })
})
