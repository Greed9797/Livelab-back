import { describe, expect, it, vi } from 'vitest'
import { applyApresentadorasToLive } from '../src/lib/live-rateio.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const liveId = '22222222-2222-4222-8222-222222222222'
const ana = '33333333-3333-4333-8333-333333333333'
const bia = '44444444-4444-4444-8444-444444444444'

/** db falso que responde os totais da live e guarda o que foi escrito. */
function fakeDb({ gmv, segundos }) {
  const inserts = []
  const outras = []
  const query = vi.fn(async (sql, args = []) => {
    if (sql.includes('FROM lives WHERE id')) {
      return { rows: [{ gmv, segundos }] }
    }
    if (sql.includes('INSERT INTO live_apresentadoras_v2')) {
      inserts.push(args)
      return { rows: [] }
    }
    outras.push({ sql, args })
    return { rows: [] }
  })
  return { query, inserts, outras }
}

describe('applyApresentadorasToLive — dividir a live entre quem se revezou', () => {
  it('grava uma linha por apresentadora com o R$ e o tempo informados', async () => {
    const db = fakeDb({ gmv: '10000.00', segundos: 36000 })

    await applyApresentadorasToLive(db, {
      tenantId,
      liveId,
      apresentadoras: [
        { apresentadora_id: ana, gmv: 6000, segundos: 21600 },
        { apresentadora_id: bia, gmv: 4000, segundos: 14400 },
      ],
    })

    expect(db.inserts).toHaveLength(2)
    // [tenant, live, apresentadora, papel, percentual, gmv, segundos]
    expect(db.inserts[0].slice(2)).toEqual([ana, 'principal', 60, 6000, 21600])
    expect(db.inserts[1].slice(2)).toEqual([bia, 'apoio', 40, 4000, 14400])
    // O percentual continua gravado porque parte do sistema ainda lê essa coluna.
    expect(db.inserts[0][4] + db.inserts[1][4]).toBe(100)
  })

  it('principal é quem trouxe mais GMV, não quem foi digitada primeiro', async () => {
    const db = fakeDb({ gmv: '1000.00', segundos: 7200 })

    await applyApresentadorasToLive(db, {
      tenantId,
      liveId,
      apresentadoras: [
        { apresentadora_id: ana, gmv: 300, segundos: 3600 },
        { apresentadora_id: bia, gmv: 700, segundos: 3600 },
      ],
    })

    expect(db.inserts.map((args) => [args[2], args[3]])).toEqual([
      [ana, 'apoio'],
      [bia, 'principal'],
    ])
  })

  it('recusa rateio cujo R$ não fecha o GMV da live — dinheiro não pode sumir nem nascer', async () => {
    const db = fakeDb({ gmv: '10000.00', segundos: 36000 })

    await expect(applyApresentadorasToLive(db, {
      tenantId,
      liveId,
      apresentadoras: [
        { apresentadora_id: ana, gmv: 6000, segundos: 21600 },
        { apresentadora_id: bia, gmv: 3000, segundos: 14400 },
      ],
    })).rejects.toThrow(/GMV do rateio soma/)

    expect(db.inserts).toHaveLength(0)
  })

  it('limpa a venda de quem saiu do rateio, preservando o que já foi aprovado', async () => {
    const db = fakeDb({ gmv: '1000.00', segundos: 3600 })

    await applyApresentadorasToLive(db, {
      tenantId,
      liveId,
      apresentadoras: [{ apresentadora_id: ana, gmv: 1000, segundos: 3600 }],
    })

    const limpeza = db.outras.find((q) => q.sql.includes('DELETE FROM vendas_atribuidas'))
    expect(limpeza).toBeTruthy()
    expect(limpeza.sql).toContain("COALESCE(status_aprovacao, '') <> 'aprovada'")
    expect(limpeza.args[2]).toEqual([ana])
  })
})
