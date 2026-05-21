import { describe, expect, it, vi } from 'vitest'

import { calcularComissoesDaLive } from '../src/services/commission-engine.js'

describe('commission engine', () => {
  it('splits weekend live GMV and presenter commission across two presenters', async () => {
    const insertedRows = []
    const queryMock = vi.fn(async (sql, values) => {
      if (sql.includes('FROM lives l')) {
        return {
          rows: [{
            id: 'live-1',
            cliente_id: 'cliente-1',
            apresentador_id: 'user-1',
            iniciado_em: '2026-05-23T18:00:00.000Z',
            contrato_id: 'contrato-1',
            comissao_pct: '10',
            valor_fixo_comissao: '0',
            marca_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            comissao_franquia_pct: '10',
            comissao_franqueadora_pct: '2',
          }],
        }
      }

      if (sql.includes('SELECT DISTINCT ap.id AS apresentadora_id')) {
        return {
          rows: [
            { apresentadora_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', comissao_live_pct: '0.5', percentual_rateio: null },
            { apresentadora_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', comissao_live_pct: '0.5', percentual_rateio: null },
          ],
        }
      }

      if (sql.includes('INSERT INTO vendas_atribuidas')) {
        const row = {
          apresentadora_id: values[3],
          gmv: values[5],
          comissao_apresentadora: values[7],
          comissao_franquia: values[8],
          comissao_franqueadora: values[9],
        }
        insertedRows.push(row)
        return { rows: [row] }
      }

      return { rows: [] }
    })

    const result = await calcularComissoesDaLive({ query: queryMock }, {
      tenantId: 'tenant-1',
      liveId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      gmv: 2000,
    })

    expect(result).toHaveLength(2)
    expect(insertedRows).toEqual([
      { apresentadora_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', gmv: 1000, comissao_apresentadora: 20, comissao_franquia: 100, comissao_franqueadora: 20 },
      { apresentadora_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', gmv: 1000, comissao_apresentadora: 20, comissao_franquia: 100, comissao_franqueadora: 20 },
    ])
  })
})
