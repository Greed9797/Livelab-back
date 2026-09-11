import { describe, expect, it } from 'vitest'
import {
  buildResumoDia,
  formatMinsToHours,
  formatMoneyBRL,
  formatSaoPauloDate,
  formatSaoPauloTimestamp,
} from '../src/lib/resumo-dia.js'

describe('resumo-dia helpers', () => {
  it('formats money in BRL with standard spaces', () => {
    expect(formatMoneyBRL(1234.56)).toMatch(/R\$\s?1\.234,56/)
    expect(formatMoneyBRL(0)).toMatch(/R\$\s?0,00/)
    expect(formatMoneyBRL(null)).toMatch(/R\$\s?0,00/)
  })

  it('formats minutes to hours', () => {
    expect(formatMinsToHours(0)).toBe('0h 00min')
    expect(formatMinsToHours(45)).toBe('0h 45min')
    expect(formatMinsToHours(60)).toBe('1h 00min')
    expect(formatMinsToHours(125)).toBe('2h 05min')
  })

  it('formats SP date with weekday capitalized', () => {
    const formatted = formatSaoPauloDate('2026-09-11')
    expect(formatted.toLowerCase()).toContain('11/09/2026')
    expect(formatted.charAt(0)).toBe(formatted.charAt(0).toUpperCase())
  })

  it('formats SP timestamp with "às"', () => {
    const testDate = new Date('2026-09-11T16:25:00.000Z')
    const formatted = formatSaoPauloTimestamp(testDate)
    expect(formatted).toContain('às')
  })

  it('handles empty lives array gracefully', () => {
    const result = buildResumoDia({
      data: '2026-09-11',
      lives: [],
      now: new Date('2026-09-11T16:25:00.000Z'),
    })

    expect(result.totais.gmv).toBe(0)
    expect(result.totais.pedidos).toBe(0)
    expect(result.totais.lives_count).toBe(0)
    expect(result.marcas).toEqual([])
    expect(result.apresentadoras).toEqual([])
    expect(result.texto_whatsapp).toContain('Nenhuma live registrada neste dia.')
  })

  it('aggregates single-presenter and multi-presenter lives with GMV/h correctly', () => {
    const lives = [
      {
        id: 'live-1',
        iniciado_em: '2026-09-11T13:00:00-03:00',
        encerrado_em: '2026-09-11T15:00:00-03:00', // 120 mins = 2h
        gmv: 2000,
        pedidos: 20,
        marca_nome: 'Marca A',
        apresentadora_nome: 'Camila Santos',
      },
      {
        id: 'live-2',
        iniciado_em: '2026-09-11T15:30:00-03:00',
        encerrado_em: '2026-09-11T18:30:00-03:00', // 180 mins = 3h
        gmv: 3000,
        pedidos: 30,
        marca_nome: 'Marca B',
        apresentadoras: [
          {
            nome: 'Camila Santos',
            papel: 'principal',
            gmv: 1800,
            segundos: 7200, // 2h = 120 mins
          },
          {
            nome: 'Mariana Costa',
            papel: 'apoio',
            gmv: 1200,
            segundos: 3600, // 1h = 60 mins
          },
        ],
      },
    ]

    const result = buildResumoDia({
      data: '2026-09-11',
      lives,
      now: new Date('2026-09-11T19:00:00-03:00'),
    })

    // Totais:
    // Total GMV: 2000 + 3000 = 5000
    // Total Pedidos: 20 + 30 = 50
    // Total Minutos: 120 + 180 = 300 mins (5h)
    // GMV/h: 5000 / 5 = 1000
    expect(result.totais.gmv).toBe(5000)
    expect(result.totais.pedidos).toBe(50)
    expect(result.totais.minutos).toBe(300)
    expect(result.totais.horas_formatadas).toBe('5h 00min')
    expect(result.totais.gmv_por_hora).toBe(1000)
    expect(result.totais.lives_count).toBe(2)

    // Marcas:
    expect(result.marcas).toHaveLength(2)
    // Marca B teve maior GMV (3000 vs 2000)
    expect(result.marcas[0].nome).toBe('Marca B')
    expect(result.marcas[0].gmv).toBe(3000)
    expect(result.marcas[0].pedidos).toBe(30)
    expect(result.marcas[0].horas_formatadas).toBe('3h 00min')
    expect(result.marcas[0].gmv_por_hora).toBe(1000)

    expect(result.marcas[1].nome).toBe('Marca A')
    expect(result.marcas[1].gmv).toBe(2000)
    expect(result.marcas[1].pedidos).toBe(20)
    expect(result.marcas[1].horas_formatadas).toBe('2h 00min')
    expect(result.marcas[1].gmv_por_hora).toBe(1000)

    // Apresentadoras:
    // Camila: 2000 (live 1) + 1800 (live 2) = 3800 GMV, 120 + 120 = 240 mins (4h), GMV/h: 3800 / 4 = 950
    // Mariana: 1200 GMV, 60 mins (1h), GMV/h: 1200 / 1 = 1200
    expect(result.apresentadoras).toHaveLength(2)
    expect(result.apresentadoras[0].nome).toBe('Camila Santos')
    expect(result.apresentadoras[0].gmv).toBe(3800)
    expect(result.apresentadoras[0].horas_formatadas).toBe('4h 00min')
    expect(result.apresentadoras[0].gmv_por_hora).toBe(950)

    expect(result.apresentadoras[1].nome).toBe('Mariana Costa')
    expect(result.apresentadoras[1].gmv).toBe(1200)
    expect(result.apresentadoras[1].horas_formatadas).toBe('1h 00min')
    expect(result.apresentadoras[1].gmv_por_hora).toBe(1200)

    // WhatsApp formatting checks (Option 2)
    expect(result.texto_whatsapp).toContain('📊 *RESUMO DO DIA — LIVES*')
    expect(result.texto_whatsapp).toContain('💰 *GMV Total:*')
    expect(result.texto_whatsapp).toContain('⚡ *GMV/h:*')
    expect(result.texto_whatsapp).toContain('🛒 *Vendas:* 50 pedidos')
    expect(result.texto_whatsapp).toContain('⏱️ *Tempo no Ar:* 5h 00min (2 lives)')
    expect(result.texto_whatsapp).toContain('🏷️ *POR MARCA*')
    expect(result.texto_whatsapp).toContain('*Marca B*')
    expect(result.texto_whatsapp).toContain('🎤 *POR APRESENTADORA*')
    expect(result.texto_whatsapp).toContain('*Camila Santos*')
    // Verify no bullet list indentation character
    expect(result.texto_whatsapp).not.toContain('• ')
  })
})
