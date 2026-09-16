import { describe, expect, it, vi } from 'vitest'
import { calcularComissoesDaLive } from '../src/services/commission-engine.js'
import { readFileSync } from 'node:fs'

function fixture(rows) {
  const inserted = []
  const db = { query: vi.fn(async (sql, values) => {
    if (sql.includes('FROM lives l')) return { rows: [{ id: 'live', marca_id: 'brand', iniciado_em: '2026-09-01T15:00Z', comissao_franquia_pct: 10, comissao_franqueadora_pct: 2 }] }
    if (sql.includes('SELECT DISTINCT ap.id')) return { rows }
    if (sql.includes('INSERT INTO vendas_atribuidas')) {
      const row = { apresentadora_id: values[3], gmv: values[5], pedidos: values[6], comissao_franquia: values[8] }
      inserted.push(row)
      return { rows: [row] }
    }
    if (sql.includes('SUM(gmv)')) return { rows: [{ gmv_mes: 0 }] }
    return { rows: [] }
  }) }
  return { db, inserted }
}

describe('pedidos preservados após união de lives', () => {
  it('o faturamento bloqueia as lives antes de enviar qualquer cobrança ao gateway', () => {
    const source = readFileSync(new URL('../src/jobs/billing_engine.js', import.meta.url), 'utf8')
    const selection = source.slice(source.indexOf('const livesQ ='), source.indexOf('const livesPorCliente ='))
    expect(selection).toMatch(/ORDER BY l\.id\s+FOR UPDATE OF l/)
    expect(selection).toContain('uniao_destino_id IS NULL')
  })
  it('recalcular mantém os pedidos atribuídos a cada apresentadora', async () => {
    const { db, inserted } = fixture([
      { apresentadora_id: 'ana', gmv_rateado: '2000', percentual_rateio: 40, pedidos_rateados: 20 },
      { apresentadora_id: 'bia', gmv_rateado: '3000', percentual_rateio: 60, pedidos_rateados: 30 },
    ])
    await calcularComissoesDaLive(db, { tenantId: 'tenant', liveId: 'live', gmv: 5000, pedidos: 50, retroLift: false })
    expect(inserted.map(row => row.pedidos)).toEqual([20, 30])
    expect(inserted.map(row => row.gmv)).toEqual([2000, 3000])
  })

  it('não altera a regra das lives antigas sem pedidos rateados', async () => {
    const { db, inserted } = fixture([
      { apresentadora_id: 'ana', gmv_rateado: 2000, pedidos_rateados: null },
      { apresentadora_id: 'bia', gmv_rateado: 3000, pedidos_rateados: null },
    ])
    await calcularComissoesDaLive(db, { tenantId: 'tenant', liveId: 'live', gmv: 5000, pedidos: 50, retroLift: false })
    expect(inserted.map(row => row.pedidos)).toEqual([50, 0])
  })

  it('não substitui rateio explícito inconsistente pela regra da principal', async () => {
    const { db } = fixture([
      { apresentadora_id: 'ana', gmv_rateado: 2000, pedidos_rateados: 20 },
      { apresentadora_id: 'bia', gmv_rateado: 3000, pedidos_rateados: 29 },
    ])
    await expect(calcularComissoesDaLive(db, { tenantId: 'tenant', liveId: 'live', gmv: 5000, pedidos: 50, retroLift: false })).rejects.toThrow(/pedidos/i)
    expect(db.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO vendas_atribuidas'))).toBe(false)
  })
})
