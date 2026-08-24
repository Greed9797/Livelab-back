import { describe, it, expect } from 'vitest'
import { normalizarRateio } from '../src/lib/live-rateio.js'

const AP1 = '11111111-1111-1111-1111-111111111111'
const AP2 = '22222222-2222-2222-2222-222222222222'
const AP3 = '33333333-3333-3333-3333-333333333333'

const somaPercentual = (rateio) => rateio.reduce((acc, r) => acc + Math.round(r.percentual * 100), 0)

describe('normalizarRateio — formato absoluto (R$ e tempo digitados)', () => {
  it('aceita o rateio quando GMV e tempo fecham com a live', () => {
    // 4h + 5h = 9h; R$ 3.000 + R$ 2.000 = R$ 5.000
    const rateio = normalizarRateio(
      [
        { apresentadora_id: AP1, gmv: 3000, segundos: 4 * 3600 },
        { apresentadora_id: AP2, gmv: 2000, segundos: 5 * 3600 },
      ],
      { gmvLive: 5000, segundosLive: 9 * 3600 },
    )

    expect(rateio.map((r) => r.gmv)).toEqual([3000, 2000])
    expect(rateio.map((r) => r.segundos)).toEqual([14400, 18000])
    expect(rateio.map((r) => r.percentual)).toEqual([60, 40])
  })

  it('recusa quando a soma do GMV não bate com a live', () => {
    expect(() => normalizarRateio(
      [
        { apresentadora_id: AP1, gmv: 3000, segundos: 3600 },
        { apresentadora_id: AP2, gmv: 1500, segundos: 3600 },
      ],
      { gmvLive: 5000, segundosLive: 7200 },
    )).toThrow(/GMV do rateio soma R\$ 4500,00 e a live tem R\$ 5000,00/)
  })

  it('recusa quando a soma do tempo não bate com a duração da live', () => {
    expect(() => normalizarRateio(
      [
        { apresentadora_id: AP1, gmv: 3000, segundos: 3600 },
        { apresentadora_id: AP2, gmv: 2000, segundos: 3600 },
      ],
      { gmvLive: 5000, segundosLive: 9 * 3600 },
    )).toThrow(/Tempo do rateio soma 2h00 e a live durou 9h00/)
  })

  it('tolera até 60s de diferença no tempo — arredondamento de minuto da UI', () => {
    // Live de 2h37m17s: a tela trabalha em minutos cheios e fecharia em 2h37m.
    const rateio = normalizarRateio(
      [
        { apresentadora_id: AP1, gmv: 200, segundos: 4710 },
        { apresentadora_id: AP2, gmv: 300, segundos: 4710 },
      ],
      { gmvLive: 500, segundosLive: 9437 },
    )
    expect(rateio).toHaveLength(2)
  })

  it('não cobra o tempo quando a live ainda não encerrou', () => {
    const rateio = normalizarRateio(
      [
        { apresentadora_id: AP1, gmv: 100, segundos: 3600 },
        { apresentadora_id: AP2, gmv: 400, segundos: 60 },
      ],
      { gmvLive: 500, segundosLive: null },
    )
    expect(rateio.map((r) => r.percentual)).toEqual([20, 80])
  })

  it('fecha exatamente 100% mesmo com divisão que não termina', () => {
    // 1/3 de R$ 1.000 em NUMERIC(5,2) daria 33.33 × 3 = 99.99. A sobra vai para a maior linha.
    const rateio = normalizarRateio(
      [
        { apresentadora_id: AP1, gmv: 333.34, segundos: 3600 },
        { apresentadora_id: AP2, gmv: 333.33, segundos: 3600 },
        { apresentadora_id: AP3, gmv: 333.33, segundos: 3600 },
      ],
      { gmvLive: 1000, segundosLive: 10800 },
    )
    expect(somaPercentual(rateio)).toBe(10000)
    // O GMV gravado é o digitado, não o reconstruído a partir do percentual arredondado.
    expect(rateio.map((r) => r.gmv)).toEqual([333.34, 333.33, 333.33])
  })

  it('live sem GMV rateia o percentual pelo tempo', () => {
    const rateio = normalizarRateio(
      [
        { apresentadora_id: AP1, gmv: 0, segundos: 3 * 3600 },
        { apresentadora_id: AP2, gmv: 0, segundos: 1 * 3600 },
      ],
      { gmvLive: 0, segundosLive: 4 * 3600 },
    )
    expect(rateio.map((r) => r.percentual)).toEqual([75, 25])
    expect(somaPercentual(rateio)).toBe(10000)
  })

  it('aceita centavos: soma exata em R$ não pode ser recusada por float', () => {
    const rateio = normalizarRateio(
      [
        { apresentadora_id: AP1, gmv: 248.14, segundos: 3600 },
        { apresentadora_id: AP2, gmv: 165.43, segundos: 3600 },
      ],
      { gmvLive: 413.57, segundosLive: 7200 },
    )
    expect(somaPercentual(rateio)).toBe(10000)
  })
})

describe('normalizarRateio — formato percentual (lotes salvos antes da mudança)', () => {
  it('deriva R$ e tempo a partir do percentual', () => {
    const rateio = normalizarRateio(
      [
        { apresentadora_id: AP1, percentual: 60 },
        { apresentadora_id: AP2, percentual: 40 },
      ],
      { gmvLive: 1000, segundosLive: 36000 },
    )
    expect(rateio.map((r) => r.gmv)).toEqual([600, 400])
    expect(rateio.map((r) => r.segundos)).toEqual([21600, 14400])
  })

  it('continua exigindo soma de 100%', () => {
    expect(() => normalizarRateio(
      [
        { apresentadora_id: AP1, percentual: 60 },
        { apresentadora_id: AP2, percentual: 30 },
      ],
      { gmvLive: 1000, segundosLive: 36000 },
    )).toThrow(/soma 90% \(precisa somar 100%\)/)
  })

  it('não quebra quando a live não tem duração fechada', () => {
    const rateio = normalizarRateio(
      [{ apresentadora_id: AP1, percentual: 100 }],
      { gmvLive: 900, segundosLive: null },
    )
    expect(rateio[0].segundos).toBeNull()
    expect(rateio[0].gmv).toBe(900)
  })
})
