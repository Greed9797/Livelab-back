import { describe, expect, it, vi } from 'vitest'

import { atualizarVencimentoCondicao } from '../src/services/marca-condicoes.js'

const tenantId = '00000000-0000-4000-8000-000000000001'
const marcaId = '00000000-0000-4000-8000-000000000002'
const condicaoId = '00000000-0000-4000-8000-000000000005'

function dbMock() {
  return {
    query: vi.fn(async (sql) => (/FROM marcas[\s\S]*FOR UPDATE/.test(sql) ? { rows: [{ id: marcaId }] } : /^\s*UPDATE marca_condicoes_comerciais/.test(sql)
      ? { rows: [{ id: condicaoId, marca_id: marcaId, inicio_vigencia: '2026-09-01', comissao_janela_inicio_dia: 16 }] }
      : { rows: [] })),
  }
}

describe('atualizarVencimentoCondicao com janela', () => {
  it('envia comissao_janela_inicio_dia ao UPDATE (COALESCE) e devolve no shape público', async () => {
    const db = dbMock()
    const out = await atualizarVencimentoCondicao(db, { tenantId, marcaId, condicaoId, vencimento: { comissao_janela_inicio_dia: 16 } })
    const update = db.query.mock.calls.find(([sql]) => /^\s*UPDATE marca_condicoes_comerciais/.test(sql))
    expect(update[0]).toContain('comissao_janela_inicio_dia = COALESCE($8::smallint, comissao_janela_inicio_dia)')
    expect(update[1][7]).toBe(16)
    expect(update[1].slice(3, 7)).toEqual([null, null, null, null])
    expect(out.comissao_janela_inicio_dia).toBe(16)
    expect(db.query.mock.calls.some(([sql]) => sql.includes('pg_advisory_xact_lock'))).toBe(true)
    expect(update[0]).toContain('MAX(revision)')
  })

  it('rejeita janela fora de 1..28 sem tocar o banco', async () => {
    const db = dbMock()
    await expect(atualizarVencimentoCondicao(db, { tenantId, marcaId, condicaoId, vencimento: { comissao_janela_inicio_dia: 29 } }))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(db.query).not.toHaveBeenCalled()
  })
})

describe('atualizarVencimentoCondicao — janela retroativa', () => {
  function db(tem) {
    return {
      query: vi.fn(async (sql) => {
        if (/FROM marcas[\s\S]*FOR UPDATE/.test(sql)) return { rows: [{ id: marcaId }] }
        if (/SELECT EXISTS/.test(sql)) return { rows: [{ tem }] }
        if (/^\s*UPDATE marca_condicoes_comerciais/.test(sql)) return { rows: [{ id: condicaoId, marca_id: marcaId, inicio_vigencia: '2026-09-01', comissao_janela_inicio_dia: 16 }] }
        return { rows: [] }
      }),
    }
  }

  it('com títulos materializados na vigência: 400 JANELA_RETROATIVA e rollback, sem UPDATE', async () => {
    const d = db(true)
    await expect(atualizarVencimentoCondicao(d, { tenantId, marcaId, condicaoId, vencimento: { comissao_janela_inicio_dia: 16 } }))
      .rejects.toMatchObject({ statusCode: 400, code: 'JANELA_RETROATIVA', message: expect.stringContaining('nova versão') })
    const sqls = d.query.mock.calls.map(([s]) => String(s))
    expect(sqls.some((s) => /^\s*UPDATE marca_condicoes_comerciais/.test(s))).toBe(false)
    expect(sqls).toContain('ROLLBACK')
  })

  it('versão sem títulos: permite definir a janela', async () => {
    const d = db(false)
    const out = await atualizarVencimentoCondicao(d, { tenantId, marcaId, condicaoId, vencimento: { comissao_janela_inicio_dia: 16 } })
    expect(out.comissao_janela_inicio_dia).toBe(16)
  })

  it('só vencimento (sem janela) não consulta títulos', async () => {
    const d = db(true)
    await atualizarVencimentoCondicao(d, { tenantId, marcaId, condicaoId, vencimento: { fixo_vencimento_dia: 10 } })
    expect(d.query.mock.calls.some(([s]) => /SELECT EXISTS/.test(s))).toBe(false)
  })
})
