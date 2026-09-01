// Seed do rateio PLANEJADO: turnos do evento de agenda → live_apresentadoras_v2 na
// hora em que a live abre. Três chamadores compartilham este caminho (agenda_autostart,
// POST /v1/lives e POST /v1/lives/manual), então o contrato do SQL é testado aqui uma vez.
//
// O que este arquivo protege é dinheiro: gmv_rateado e segundos_rateio TÊM que ficar de
// fora do INSERT. Os dois são o primeiro degrau do COALESCE dos rollups — gmv 0 zeraria o
// ranking e o tempo planejado congelaria as horas no palpite (live de 4h valendo 8h).

import { describe, expect, it, vi } from 'vitest'

import { seedRateioPlanejado } from '../src/lib/agenda-turnos.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const liveId = '22222222-2222-4222-8222-222222222222'
const eventoId = '33333333-3333-4333-8333-333333333333'
const ana = '44444444-4444-4444-8444-444444444444'
const bia = '55555555-5555-4555-8555-555555555555'

/**
 * db falso: devolve os turnos pedidos e guarda os INSERTs em v2.
 *
 * Modela o estado ABORTADO do Postgres. Sem isso o teste de falha na leitura provava o
 * oposto do que afirmava: o fake respondia normalmente à query seguinte, coisa que um
 * banco de verdade não faz — dentro de uma transação, qualquer erro faz TODA query
 * seguinte falhar com 25P02 até um ROLLBACK (ou ROLLBACK TO SAVEPOINT). É por isso que o
 * seed precisa de SAVEPOINT e não de um try/catch nu.
 */
function fakeDb(turnos, { falhaNaLeitura = false } = {}) {
  const inserts = []
  const sqls = []
  let abortado = false

  const query = vi.fn(async (sql, args = []) => {
    sqls.push(sql)
    const isRollback = sql.startsWith('ROLLBACK')
    if (abortado && !isRollback) {
      const err = new Error('current transaction is aborted, commands ignored until end of transaction block')
      err.code = '25P02'
      throw err
    }
    if (isRollback) {
      abortado = false
      return { rows: [] }
    }
    if (sql.includes('FROM agenda_evento_apresentadoras')) {
      if (falhaNaLeitura) {
        abortado = true
        throw new Error('relation "agenda_evento_apresentadoras" does not exist')
      }
      return { rows: turnos }
    }
    if (sql.includes('INSERT INTO live_apresentadoras_v2')) {
      inserts.push({ sql, args })
      return { rows: [] }
    }
    return { rows: [] }
  })
  return { query, inserts, sqls }
}

const turno = (apresentadora_id, hIni, hFim) => ({
  apresentadora_id,
  data_inicio: `2026-04-08T${String(hIni).padStart(2, '0')}:00:00-03:00`,
  data_fim: `2026-04-08T${String(hFim).padStart(2, '0')}:00:00-03:00`,
})

describe('seedRateioPlanejado', () => {
  it('grava uma linha por turno, com papel e percentual, e sem tocar em dinheiro realizado', async () => {
    const db = fakeDb([turno(ana, 14, 16), turno(bia, 16, 22)])

    const n = await seedRateioPlanejado(db, {
      tenantId, liveId, agendaEventoId: eventoId, apresentadoraFallbackId: null,
    })

    expect(n).toBe(2)
    expect(db.inserts).toHaveLength(2)
    // 5 colunas: tenant, live, apresentadora, papel, percentual. Nada além disso.
    expect(db.inserts.map((i) => i.args.length)).toEqual([5, 5])
    expect(db.inserts.map((i) => i.args.slice(2))).toEqual([
      [ana, 'apoio', 25],
      [bia, 'principal', 75],
    ])
    // Exatamente uma principal — duas fariam todo LEFT JOIN por papel duplicar a live.
    expect(db.inserts.filter((i) => i.args[3] === 'principal')).toHaveLength(1)
    for (const { sql } of db.inserts) {
      expect(sql).not.toContain('gmv_rateado')
      expect(sql).not.toContain('segundos_rateio')
    }
  })

  it('cai no INSERT de 3 parâmetros quando o evento tem uma apresentadora só', async () => {
    const db = fakeDb([turno(ana, 14, 18)])

    const n = await seedRateioPlanejado(db, {
      tenantId, liveId, agendaEventoId: eventoId, apresentadoraFallbackId: bia,
    })

    expect(n).toBe(1)
    // Idêntico ao insert de hoje: quem tem um turno só não vira caso especial no banco.
    expect(db.inserts).toHaveLength(1)
    expect(db.inserts[0].sql).toContain('INSERT INTO live_apresentadoras_v2 (tenant_id, live_id, apresentadora_id)')
    expect(db.inserts[0].args).toEqual([tenantId, liveId, ana])
  })

  it('usa a apresentadora escalar do evento quando não há turno nenhum', async () => {
    const db = fakeDb([])

    const n = await seedRateioPlanejado(db, {
      tenantId, liveId, agendaEventoId: eventoId, apresentadoraFallbackId: bia,
    })

    expect(n).toBe(1)
    expect(db.inserts[0].args).toEqual([tenantId, liveId, bia])
  })

  it('não relança quando a leitura dos turnos falha — a live tem que abrir mesmo assim', async () => {
    const db = fakeDb([], { falhaNaLeitura: true })
    const log = { warn: vi.fn() }

    // Chamado dentro da transação do agenda_autostart: uma exceção aqui reverteria a
    // live, a cabine e o evento que o job acabou de abrir. Só o SAVEPOINT torna isso
    // verdade — com try/catch nu o INSERT de fallback abaixo estouraria 25P02 na sessão
    // abortada e derrubaria a abertura da live inteira.
    const n = await seedRateioPlanejado(db, {
      tenantId, liveId, agendaEventoId: eventoId, apresentadoraFallbackId: bia, log,
    })

    expect(n).toBe(1)
    expect(db.inserts[0].args).toEqual([tenantId, liveId, bia])
    expect(log.warn).toHaveBeenCalled()
    expect(db.sqls).toContain('SAVEPOINT agenda_turnos_seed')
    expect(db.sqls).toContain('ROLLBACK TO SAVEPOINT agenda_turnos_seed')
  })

  it('descarta o rateio planejado quando o fechamento informa quem não está nos turnos', async () => {
    // Lançamento manual: a live já aconteceu e o operador diz que quem apresentou foi a
    // Carla. Manter o plano Ana/Bia daria 100% do GMV e da comissão para quem não
    // apresentou — os percentuais planejados já somam 1.0, então sobra R$ 0,00 para ela.
    const carla = '66666666-6666-4666-8666-666666666666'
    const db = fakeDb([turno(ana, 14, 16), turno(bia, 16, 18)])
    const log = { warn: vi.fn() }

    const n = await seedRateioPlanejado(db, {
      tenantId, liveId, agendaEventoId: eventoId,
      apresentadoraFallbackId: carla, apresentadoraConfirmadaId: carla, log,
    })

    expect(n).toBe(1)
    expect(db.inserts).toHaveLength(1)
    expect(db.inserts[0].args).toEqual([tenantId, liveId, carla])
    expect(log.warn).toHaveBeenCalled()
  })

  it('mantém o revezamento quando a apresentadora do fechamento está nos turnos', async () => {
    // Um campo escalar só nomeia a principal — não é motivo para desfazer o revezamento.
    const db = fakeDb([turno(ana, 14, 16), turno(bia, 16, 18)])

    const n = await seedRateioPlanejado(db, {
      tenantId, liveId, agendaEventoId: eventoId,
      apresentadoraFallbackId: ana, apresentadoraConfirmadaId: ana,
    })

    expect(n).toBe(2)
    expect(db.inserts.map((i) => i.args[2])).toEqual([ana, bia])
  })

  it('não escreve nada quando não há turno nem apresentadora escalar', async () => {
    const db = fakeDb([])

    const n = await seedRateioPlanejado(db, {
      tenantId, liveId, agendaEventoId: eventoId, apresentadoraFallbackId: null,
    })

    expect(n).toBe(0)
    expect(db.inserts).toHaveLength(0)
  })
})
