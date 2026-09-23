import { describe, expect, it, vi } from 'vitest'

import { comissaoValorFromPct, resolveComissaoPctSemCabine } from '../src/lib/comissao-sem-cabine.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const marcaId = '22222222-2222-4222-8222-222222222222'
const apresentadoraId = '33333333-3333-4333-8333-333333333333'

function dbReturning(handler) {
  return { query: vi.fn(async (sql, params) => handler(String(sql), params)) }
}

describe('resolveComissaoPctSemCabine', () => {
  it('usa o percentual confirmado da marca e não consulta a faixa', async () => {
    const db = dbReturning((sql) => {
      if (sql.includes('AS condicao_pct')) return { rows: [{ condicao_pct: '12.5', marca_pct: 0 }] }
      if (sql.includes('apresentadora_comissao_faixas')) throw new Error('faixa não deveria ser consultada')
      return { rows: [] }
    })

    const pct = await resolveComissaoPctSemCabine(db, {
      tenantId, marcaId, apresentadoraId, gmv: 1000, data: '2026-09-21',
    })

    expect(pct).toBe(12.5)
    expect(comissaoValorFromPct(1000, pct)).toBe(125)
  })

  it('cai na faixa da apresentadora quando a marca não tem percentual informado', async () => {
    const db = dbReturning((sql) => {
      if (sql.includes('AS condicao_pct')) return { rows: [{ condicao_pct: null, marca_pct: 0 }] }
      if (sql.includes('FROM vendas_atribuidas')) return { rows: [{ gmv_mes: 0 }] }
      if (sql.includes('apresentadora_comissao_faixas')) return { rows: [{ comissao_pct: '1.5' }] }
      return { rows: [] }
    })

    const pct = await resolveComissaoPctSemCabine(db, {
      tenantId, marcaId, apresentadoraId, gmv: 800, data: '2026-09-21',
    })

    expect(pct).toBe(1.5)
  })

  it('devolve null quando marca e faixa não existem — não inventa 0', async () => {
    const db = dbReturning((sql) => {
      if (sql.includes('AS condicao_pct')) return { rows: [{ condicao_pct: null, marca_pct: 0 }] }
      if (sql.includes('FROM vendas_atribuidas')) return { rows: [{ gmv_mes: 0 }] }
      return { rows: [] }
    })

    const pct = await resolveComissaoPctSemCabine(db, {
      tenantId, marcaId, apresentadoraId, gmv: 800, data: '2026-09-21',
    })

    expect(pct).toBeNull()
    expect(comissaoValorFromPct(800, pct)).toBeNull()
  })

  it('não trata o placeholder 0 da franqueadora como fonte', async () => {
    const db = dbReturning((sql) => {
      expect(sql).not.toContain('comissao_franqueadora_pct')
      if (sql.includes('AS condicao_pct')) return { rows: [] }
      return { rows: [] }
    })

    const pct = await resolveComissaoPctSemCabine(db, { tenantId, marcaId, gmv: 100, data: '2026-09-21' })
    expect(pct).toBeNull()
  })
})
