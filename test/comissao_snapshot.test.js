import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { sincronizarSnapshotComissaoApresentadora } from '../src/services/comissao-snapshot.js'

// lives.comissao_apresentadora_* passou a ser derivado de vendas_atribuidas (motor). Antes era
// uma segunda calculadora com apresentadoras.comissao_pct chapado, e a tabela de lives dizia
// "—" para 571 de 624 lives enquanto o Financeiro mostrava comissão em 497.
describe('sincronizarSnapshotComissaoApresentadora', () => {
  it('agrega vendas_atribuidas da live e grava valor + pct derivado', async () => {
    const query = vi.fn(async () => ({ rowCount: 2 }))
    const n = await sincronizarSnapshotComissaoApresentadora({ query }, { tenantId: 't1', liveIds: ['a', 'b', 'a', null] })
    expect(n).toBe(2)
    const [sql, params] = query.mock.calls[0]
    expect(sql).toMatch(/UPDATE lives l[\s\S]*SET comissao_apresentadora_valor = agg\.valor[\s\S]*comissao_apresentadora_pct\s+= agg\.pct/)
    expect(sql).toMatch(/FROM vendas_atribuidas[\s\S]*origem = 'live'[\s\S]*origem_id = ANY\(\$2::uuid\[\]\)/)
    expect(sql).toContain("NULLIF(SUM(gmv), 0)")
    expect(params).toEqual(['t1', ['a', 'b']])
  })

  it('não consulta o banco sem lives', async () => {
    const query = vi.fn()
    expect(await sincronizarSnapshotComissaoApresentadora({ query }, { tenantId: 't1', liveIds: [null] })).toBe(0)
    expect(query).not.toHaveBeenCalled()
  })
})

describe('todo escritor de vendas_atribuidas (origem=live) sincroniza o snapshot', () => {
  const engine = readFileSync(new URL('../src/services/commission-engine.js', import.meta.url), 'utf8')
  const rota = readFileSync(new URL('../src/routes/vendas_atribuidas.js', import.meta.url), 'utf8')

  it('commission-engine sincroniza a live após gravar comissao_calculada', () => {
    const i = engine.indexOf('UPDATE lives SET comissao_calculada')
    expect(engine.slice(i)).toContain("sincronizarSnapshotComissaoApresentadora(db, { tenantId, liveIds: [liveId] })")
  })

  it('upsert, recálculo mensal (retro-lift) e PATCH da rota sincronizam', () => {
    // upsert: UPDATE e INSERT; PATCH /:id; recalcular: uma chamada com as lives tocadas
    expect(rota.match(/await sincronizarSnapshotDaVenda\(db, /g)?.length).toBe(3)
    expect(rota).toContain("sincronizarSnapshotComissaoApresentadora(db, { tenantId, liveIds: livesTocadas })")
    // vídeo não tem snapshot por live
    expect(rota).toMatch(/if \(!venda \|\| venda\.origem !== 'live'\) return/)
  })
})
