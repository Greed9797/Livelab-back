import { describe, expect, it } from 'vitest'

import { officialGmvFromPayload, officialLiveGmv } from '../src/lib/official-gmv.js'

describe('GMV oficial', () => {
  it('escolhe ads, depois manual, depois fat; zero gravado continua zero', () => {
    expect(officialLiveGmv({ ads_gmv: 0, manual_gmv: 1592, fat_gerado: 2533.69 })).toBe(0)
    expect(officialLiveGmv({ ads_gmv: null, manual_gmv: 1592, fat_gerado: 2533.69 })).toBe(1592)
    expect(officialLiveGmv({ fat_gerado: 10 })).toBe(10)
  })

  it('três colunas ausentes não viram zero', () => {
    expect(officialLiveGmv({ ads_gmv: null, manual_gmv: null, fat_gerado: null })).toBeNull()
    expect(officialLiveGmv({})).toBeNull()
  })

  it('um payload só com fat_gerado não esconde o manual_gmv já gravado', () => {
    expect(officialGmvFromPayload(
      { fat_gerado: 2533.69 },
      { ads_gmv: null, manual_gmv: 1592, fat_gerado: 2533.69 },
    )).toBe(1592)
  })

  it('um manual_gmv explícito no payload substitui o valor gravado', () => {
    expect(officialGmvFromPayload(
      { manual_gmv: 800 },
      { manual_gmv: 1592, fat_gerado: 2533.69 },
    )).toBe(800)
  })
})
