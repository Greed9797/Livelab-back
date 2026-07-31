import { describe, expect, it, vi } from 'vitest'
import { calcularComissoesDaLive } from '../src/services/commission-engine.js'

const AP1 = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa'
const AP2 = 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb'
const MARCA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

/**
 * node-postgres devolve NUMERIC como STRING. Os mocks abaixo respeitam isso de propósito:
 * um `Number()` esquecido em cima de '3000.00' passaria num mock com número e quebraria em produção.
 */
function makeDb(apresentadoras) {
  const inserted = []
  const query = vi.fn(async (sql, values) => {
    if (sql.includes('FROM lives l')) {
      return {
        rows: [{
          id: 'live-1',
          cliente_id: 'cliente-1',
          apresentador_id: 'user-1',
          iniciado_em: '2026-05-20T18:00:00.000Z',
          contrato_id: 'contrato-1',
          comissao_pct: '10',
          valor_fixo_comissao: '0',
          marca_id: MARCA,
          comissao_franquia_pct: '10',
          comissao_franqueadora_pct: '2',
        }],
      }
    }
    if (sql.includes('SELECT DISTINCT ap.id AS apresentadora_id')) return { rows: apresentadoras }
    if (sql.includes('FROM vendas_atribuidas')) return { rows: [{ gmv_mes: '0' }] }
    if (sql.includes('FROM apresentadora_comissao_faixas')) return { rows: [] }
    if (sql.includes('INSERT INTO vendas_atribuidas')) {
      const row = {
        apresentadora_id: values[3],
        gmv: values[5],
        // $1..$10 → índices 0..9: comissao_franquia é $9, franqueadora é $10.
        comissao_franquia: values[8],
        comissao_franqueadora: values[9],
      }
      inserted.push(row)
      return { rows: [row] }
    }
    return { rows: [] }
  })
  return { db: { query }, inserted }
}

const soma = (linhas, campo) => linhas.reduce((acc, r) => acc + Number(r[campo]), 0)

describe('commission engine — rateio por valor absoluto', () => {
  it('usa gmv_rateado em vez do percentual quando ele existe', async () => {
    const { db, inserted } = makeDb([
      { apresentadora_id: AP1, percentual_rateio: '50.00', gmv_rateado: '3000.00' },
      { apresentadora_id: AP2, percentual_rateio: '50.00', gmv_rateado: '2000.00' },
    ])

    await calcularComissoesDaLive(db, { tenantId: 't1', liveId: 'live-1', gmv: 5000, pedidos: 10 })

    // 60/40 pelo valor absoluto — e não 50/50, que é o que o percentual gravado diria.
    expect(inserted.map((r) => Number(r.gmv))).toEqual([3000, 2000])
  })

  it('a soma das linhas fecha o GMV total mesmo quando ele foi recalculado depois', async () => {
    const { db, inserted } = makeDb([
      { apresentadora_id: AP1, percentual_rateio: null, gmv_rateado: '3000.00' },
      { apresentadora_id: AP2, percentual_rateio: null, gmv_rateado: '2000.00' },
    ])

    // GMV da live corrigido para 6000 depois do rateio ter sido salvo somando 5000.
    await calcularComissoesDaLive(db, { tenantId: 't1', liveId: 'live-1', gmv: 6000, pedidos: 10 })

    // Peso, não valor fixo: 60/40 de 6000. Se fosse valor fixo, sobrariam R$ 1.000 sem dono e
    // o invariante comissao_calculada == SUM(comissao_franquia) quebraria.
    expect(inserted.map((r) => Number(r.gmv))).toEqual([3600, 2400])
    expect(soma(inserted, 'gmv')).toBe(6000)
    expect(soma(inserted, 'comissao_franquia')).toBeCloseTo(600, 6)
  })

  it('ignora o rateio absoluto quando só uma das apresentadoras tem valor', async () => {
    const { db, inserted } = makeDb([
      { apresentadora_id: AP1, percentual_rateio: null, gmv_rateado: '3000.00' },
      { apresentadora_id: AP2, percentual_rateio: null, gmv_rateado: null },
    ])

    await calcularComissoesDaLive(db, { tenantId: 't1', liveId: 'live-1', gmv: 5000, pedidos: 10 })

    // Um subconjunto com valor não define o rateio do resto: cai no 1/N em vez de inventar.
    expect(inserted.map((r) => Number(r.gmv))).toEqual([2500, 2500])
  })

  it('não divide por zero quando todo o rateio absoluto é zero', async () => {
    const { db, inserted } = makeDb([
      { apresentadora_id: AP1, percentual_rateio: '70.00', gmv_rateado: '0.00' },
      { apresentadora_id: AP2, percentual_rateio: '30.00', gmv_rateado: '0.00' },
    ])

    await calcularComissoesDaLive(db, { tenantId: 't1', liveId: 'live-1', gmv: 1000, pedidos: 0 })

    // Live sem venda mas com percentual gravado: volta para o percentual, sem NaN.
    expect(inserted.map((r) => Number(r.gmv))).toEqual([700, 300])
    expect(inserted.every((r) => Number.isFinite(Number(r.gmv)))).toBe(true)
  })

  it('apresentadora que não vendeu fica com zero, sem contaminar a outra', async () => {
    const { db, inserted } = makeDb([
      { apresentadora_id: AP1, percentual_rateio: null, gmv_rateado: '5000.00' },
      { apresentadora_id: AP2, percentual_rateio: null, gmv_rateado: '0.00' },
    ])

    await calcularComissoesDaLive(db, { tenantId: 't1', liveId: 'live-1', gmv: 5000, pedidos: 4 })

    expect(inserted.map((r) => Number(r.gmv))).toEqual([5000, 0])
    expect(soma(inserted, 'gmv')).toBe(5000)
  })

  it('continua respeitando o percentual em lives antigas sem valor absoluto', async () => {
    const { db, inserted } = makeDb([
      { apresentadora_id: AP1, percentual_rateio: '70.00', gmv_rateado: null },
      { apresentadora_id: AP2, percentual_rateio: '30.00', gmv_rateado: null },
    ])

    await calcularComissoesDaLive(db, { tenantId: 't1', liveId: 'live-1', gmv: 1000, pedidos: 0 })

    expect(inserted.map((r) => Number(r.gmv))).toEqual([700, 300])
  })
})
