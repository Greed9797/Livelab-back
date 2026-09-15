import { afterEach, expect, it, vi } from 'vitest'
import { monthRangeFromQuery } from '../src/lib/presenter-ranking.js'
afterEach(() => vi.useRealTimers())
it('defaults to the Sao Paulo month before local midnight', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T01:30:00Z'))
  expect(monthRangeFromQuery()).toEqual({ mes: '2026-09', start: '2026-09-01', end: '2026-10-01' })
})
