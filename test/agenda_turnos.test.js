import { describe, it, expect, vi } from 'vitest'

import { calcularRateioPlanejado, seedRateioPlanejado } from '../src/lib/agenda-turnos.js'

const ANA = '11111111-1111-1111-1111-111111111111'
const BIA = '22222222-2222-2222-2222-222222222222'
const CAR = '33333333-3333-3333-3333-333333333333'

const turno = (apresentadora_id, hIni, hFim) => ({
  apresentadora_id,
  data_inicio: `2026-03-10T${String(hIni).padStart(2, '0')}:00:00-03:00`,
  data_fim: `2026-03-10T${String(hFim).padStart(2, '0')}:00:00-03:00`,
})

const somaPercentual = (linhas) => linhas.reduce((acc, l) => acc + Math.round((l.percentual ?? 0) * 100), 0)

describe('calcularRateioPlanejado', () => {
  it('rateia por tempo e elege principal quem apresenta mais', () => {
    const linhas = calcularRateioPlanejado([turno(ANA, 14, 16), turno(BIA, 16, 22)])

    expect(linhas).toEqual([
      { apresentadora_id: ANA, papel: 'apoio', percentual: 25 },
      { apresentadora_id: BIA, papel: 'principal', percentual: 75 },
    ])
  })

  it('colapsa turnos da mesma apresentadora numa linha só, somando o tempo', () => {
    // live_apresentadoras_v2 tem UNIQUE (live_id, apresentadora_id): manhã + noite da
    // mesma pessoa não podem virar duas linhas, viram 2h+2h = 4h contra as 4h da Bia.
    const linhas = calcularRateioPlanejado([
      turno(ANA, 8, 10),
      turno(BIA, 10, 14),
      turno(ANA, 14, 16),
    ])

    expect(linhas).toHaveLength(2)
    expect(linhas.map((l) => l.apresentadora_id)).toEqual([ANA, BIA])
    expect(linhas.map((l) => l.percentual)).toEqual([50, 50])
    // Empate de tempo desempata por quem começou antes — a Ana abriu às 8h.
    expect(linhas.map((l) => l.papel)).toEqual(['principal', 'apoio'])
  })

  it('mantém percentual null quando há uma apresentadora só', () => {
    // Percentual null é o que faz o INSERT ficar idêntico ao de hoje (3 parâmetros).
    expect(calcularRateioPlanejado([turno(ANA, 14, 16), turno(ANA, 16, 18)])).toEqual([
      { apresentadora_id: ANA, papel: 'principal', percentual: null },
    ])
  })

  it('devolve lista vazia sem turnos', () => {
    expect(calcularRateioPlanejado([])).toEqual([])
    expect(calcularRateioPlanejado(null)).toEqual([])
    expect(calcularRateioPlanejado(undefined)).toEqual([])
  })

  it('fecha exatamente 100% em divisão que não termina', () => {
    const linhas = calcularRateioPlanejado([turno(ANA, 8, 9), turno(BIA, 9, 10), turno(CAR, 10, 11)])

    expect(linhas.map((l) => l.percentual)).toEqual([33.34, 33.33, 33.33])
    expect(somaPercentual(linhas)).toBe(10000)
  })

  it('aceita turnos sobrepostos (co-apresentação) sem lançar', () => {
    // A soma dos turnos passa da duração do evento de propósito: o que importa aqui é a
    // fração de cada uma, não fechar contra a janela.
    const linhas = calcularRateioPlanejado([turno(ANA, 14, 18), turno(BIA, 16, 18)])

    expect(somaPercentual(linhas)).toBe(10000)
    expect(linhas.find((l) => l.papel === 'principal').apresentadora_id).toBe(ANA)
  })

  it('ignora turno com data inválida ou invertida em vez de lançar', () => {
    // Esta função roda dentro da transação que abre a live: lançar aqui reverteria a live.
    const linhas = calcularRateioPlanejado([
      turno(ANA, 14, 16),
      { apresentadora_id: BIA, data_inicio: '2026-03-10T18:00:00-03:00', data_fim: '2026-03-10T16:00:00-03:00' },
      { apresentadora_id: CAR, data_inicio: 'nao-e-data', data_fim: 'nem-isso' },
      { apresentadora_id: null, data_inicio: '2026-03-10T14:00:00-03:00', data_fim: '2026-03-10T15:00:00-03:00' },
    ])

    expect(linhas).toEqual([{ apresentadora_id: ANA, papel: 'principal', percentual: null }])
  })

  it('nunca devolve gmv nem segundos', () => {
    // gmv_rateado = 0 zeraria o ranking; segundos_rateio planejado congelaria as horas.
    const linhas = calcularRateioPlanejado([turno(ANA, 14, 16), turno(BIA, 16, 22)])

    for (const linha of linhas) {
      expect(Object.keys(linha).sort()).toEqual(['apresentadora_id', 'papel', 'percentual'])
    }
  })
})

describe('seedRateioPlanejado', () => {
  const tenantId = 'tenant-1'
  const liveId = '44444444-4444-4444-4444-444444444444'
  const eventoId = '55555555-5555-5555-5555-555555555555'

  const dbComTurnos = (rows) => ({
    query: vi.fn(async (sql) => (sql.includes('FROM agenda_evento_apresentadoras') ? { rows } : { rows: [] })),
  })

  it('grava uma linha por apresentadora com papel e percentual, sem gmv nem segundos', async () => {
    const db = dbComTurnos([turno(ANA, 14, 16), turno(BIA, 16, 22)])

    const n = await seedRateioPlanejado(db, { tenantId, liveId, agendaEventoId: eventoId, apresentadoraFallbackId: null })

    expect(n).toBe(2)
    const inserts = db.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO live_apresentadoras_v2'))
    expect(inserts).toHaveLength(2)
    for (const [sql, params] of inserts) {
      expect(params).toHaveLength(5)
      expect(sql).not.toContain('gmv_rateado')
      expect(sql).not.toContain('segundos_rateio')
    }
    expect(inserts.map(([, p]) => [p[2], p[3], p[4]])).toEqual([
      [ANA, 'apoio', 25],
      [BIA, 'principal', 75],
    ])
  })

  it('cai no INSERT de 3 parâmetros com um turno só', async () => {
    const db = dbComTurnos([turno(ANA, 14, 18)])

    const n = await seedRateioPlanejado(db, { tenantId, liveId, agendaEventoId: eventoId, apresentadoraFallbackId: BIA })

    expect(n).toBe(1)
    const [sql, params] = db.query.mock.calls.at(-1)
    expect(sql).toContain('INSERT INTO live_apresentadoras_v2 (tenant_id, live_id, apresentadora_id)')
    expect(params).toEqual([tenantId, liveId, ANA])
  })

  it('usa o fallback escalar quando o evento não tem turno', async () => {
    const db = dbComTurnos([])

    const n = await seedRateioPlanejado(db, { tenantId, liveId, agendaEventoId: eventoId, apresentadoraFallbackId: BIA })

    expect(n).toBe(1)
    expect(db.query.mock.calls.at(-1)[1]).toEqual([tenantId, liveId, BIA])
  })

  it('não grava nada quando não há turno nem fallback', async () => {
    const db = dbComTurnos([])

    const n = await seedRateioPlanejado(db, { tenantId, liveId, agendaEventoId: null, apresentadoraFallbackId: null })

    expect(n).toBe(0)
    expect(db.query).not.toHaveBeenCalled()
  })

  it('não relança quando a leitura dos turnos falha — a live tem que abrir mesmo assim', async () => {
    // Roda dentro da transação do agenda_autostart: exceção aqui reverteria cabine + evento.
    const db = {
      query: vi.fn(async (sql) => {
        if (sql.includes('FROM agenda_evento_apresentadoras')) throw new Error('relation does not exist')
        return { rows: [] }
      }),
    }
    const log = { warn: vi.fn() }

    const n = await seedRateioPlanejado(db, {
      tenantId, liveId, agendaEventoId: eventoId, apresentadoraFallbackId: BIA, log,
    })

    expect(n).toBe(1)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(db.query.mock.calls.at(-1)[1]).toEqual([tenantId, liveId, BIA])
  })
})
