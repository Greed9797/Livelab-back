import { describe, expect, it } from 'vitest'

import { calcularComissoesDaLive } from '../src/services/commission-engine.js'

describe('commission engine commercial condition snapshot', () => {
  it('uses the live competence condition and stores its id on each attribution', async () => {
    const conditionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    let inserted
    const db = {
      query: async (sql, values) => {
        const text = String(sql)
        if (text.includes('FROM lives l')) return { rows: [{
          id: 'live-1', cliente_id: 'cliente-1', apresentador_id: 'user-1',
          iniciado_em: '2026-09-15T15:00:00.000Z', marca_id: 'marca-1',
          comissao_franquia_pct: '8', comissao_franqueadora_pct: '2',
          marca_condicao_id: conditionId,
        }] }
        if (text.includes('SELECT DISTINCT ap.id AS apresentadora_id')) {
          return { rows: [{ apresentadora_id: 'ap-1', percentual_rateio: null }] }
        }
        if (text.includes('INSERT INTO vendas_atribuidas')) {
          inserted = { marca_condicao_id: values[10], comissao_franquia: values[8] }
          return { rows: [{ ...inserted, apresentadora_id: values[3], gmv: values[5] }] }
        }
        return { rows: [] }
      },
    }

    await calcularComissoesDaLive(db, {
      tenantId: 'tenant-1', liveId: 'live-1', gmv: 1000, pedidos: 4,
    })

    expect(inserted).toEqual({ marca_condicao_id: conditionId, comissao_franquia: 80 })
  })
})
