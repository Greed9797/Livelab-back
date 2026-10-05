import { describe, expect, it } from 'vitest'
import { allocateCentsByWeight, centsToExactMoney, exactMoneyToCents } from '../src/lib/money.js'

describe('dinheiro exato para fatos financeiros', () => {
  it('preserva centavos na conversão decimal e rejeita arredondamento implícito', () => {
    expect(exactMoneyToCents('100.00')).toBe(10_000n)
    expect(exactMoneyToCents('0.01')).toBe(1n)
    expect(centsToExactMoney(exactMoneyToCents('-12.30'))).toBe('-12.30')
    expect(() => exactMoneyToCents('0.001')).toThrow(RangeError)
    expect(() => exactMoneyToCents('R$ 1,00')).toThrow(RangeError)
    expect(() => exactMoneyToCents('10000000000000.00')).toThrow(RangeError)
  })

  it('distribui R$ 100,00 em três sem perder centavo e sem depender da ordem de entrada', () => {
    const weights = [{ id: 'c', weight: 1n }, { id: 'a', weight: 1n }, { id: 'b', weight: 1n }]
    const expected = [{ id: 'a', cents: 3334n }, { id: 'b', cents: 3333n }, { id: 'c', cents: 3333n }]
    expect(allocateCentsByWeight(10_000n, weights)).toEqual(expected)
    expect(allocateCentsByWeight(10_000n, [...weights].reverse())).toEqual(expected)
  })

  it('respeita pesos desiguais e não aceita pesos ambíguos', () => {
    expect(allocateCentsByWeight(101n, [{ id: 'a', weight: 2n }, { id: 'b', weight: 1n }]))
      .toEqual([{ id: 'a', cents: 67n }, { id: 'b', cents: 34n }])
    expect(() => allocateCentsByWeight(100n, [{ id: 'a', weight: 0n }])).toThrow(RangeError)
    expect(() => allocateCentsByWeight(100n, [{ id: 'a', weight: 1n }, { id: 'a', weight: 1n }])).toThrow(RangeError)
  })
})
