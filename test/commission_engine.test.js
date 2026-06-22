import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

import { calcularComissoesDaLive } from '../src/services/commission-engine.js'

describe('commission engine', () => {
  it('delegates presenter percentage rules to the central presenter commission helper', () => {
    const source = readFileSync(new URL('../src/services/commission-engine.js', import.meta.url), 'utf8')

    expect(source).toContain("resolvePresenterCommissionPct")
    expect(source).not.toContain('WEEKEND_PRESENTER_PCT')
    expect(source).not.toContain('function isWeekendSaoPaulo')
  })

  it('uses the 0.5% minimum live commission when weekday presenter has no configured tier', async () => {
    const insertedRows = []
    const queryMock = vi.fn(async (sql, values) => {
      if (sql.includes('FROM lives l')) {
        return {
          rows: [{
            id: 'live-2',
            cliente_id: 'cliente-1',
            apresentador_id: 'user-1',
            iniciado_em: '2026-05-20T18:00:00.000Z',
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
            { apresentadora_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', comissao_live_pct: null, percentual_rateio: null },
          ],
        }
      }

      if (sql.includes('FROM vendas_atribuidas')) return { rows: [{ gmv_mes: '0' }] }
      if (sql.includes('FROM apresentadora_comissao_faixas')) return { rows: [] }

      if (sql.includes('INSERT INTO vendas_atribuidas')) {
        const row = {
          apresentadora_id: values[3],
          gmv: values[5],
          comissao_apresentadora: values[7],
        }
        insertedRows.push(row)
        return { rows: [row] }
      }

      return { rows: [] }
    })

    await calcularComissoesDaLive({ query: queryMock }, {
      tenantId: 'tenant-1',
      liveId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      gmv: 1000,
    })

    expect(insertedRows).toEqual([
      { apresentadora_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', gmv: 1000, comissao_apresentadora: 5 },
    ])
  })

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

  it('grava pedidos 100% no principal e reconcilia lives.comissao_calculada = Σ comissao_franquia', async () => {
    const insertedRows = []
    let comissaoCalculadaPersistida = null
    const queryMock = vi.fn(async (sql, values) => {
      if (sql.includes('FROM lives l')) {
        return {
          rows: [{
            id: 'live-1', cliente_id: 'cliente-1', live_marca_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            apresentador_id: 'user-1', iniciado_em: '2026-05-20T18:00:00.000Z',
            contrato_id: 'contrato-1', comissao_pct: '10',
            marca_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            comissao_franquia_pct: '10', comissao_franqueadora_pct: '2', valor_fixo_minimo: '0',
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
      if (sql.includes('FROM vendas_atribuidas')) return { rows: [{ gmv_mes: '0' }] }
      if (sql.includes('FROM apresentadora_comissao_faixas')) return { rows: [] }
      if (sql.includes('INSERT INTO vendas_atribuidas')) {
        const row = { apresentadora_id: values[3], gmv: values[5], pedidos: values[6], comissao_franquia: values[8] }
        insertedRows.push(row)
        return { rows: [row] }
      }
      if (sql.includes('UPDATE lives SET comissao_calculada')) {
        comissaoCalculadaPersistida = values[0]
        return { rows: [] }
      }
      return { rows: [] }
    })

    await calcularComissoesDaLive({ query: queryMock }, {
      tenantId: 'tenant-1', liveId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', gmv: 2000, pedidos: 10,
    })

    // pedidos 100% na 1ª linha (principal), 0 nas demais
    expect(insertedRows.map(r => r.pedidos)).toEqual([10, 0])
    // dia útil, gmv 2000 × 10% = franquia total 200, rateada 100+100
    expect(insertedRows.map(r => r.comissao_franquia)).toEqual([100, 100])
    // INVARIANTE: comissao_calculada = soma das linhas (200) → Financeiro == Comissões
    expect(comissaoCalculadaPersistida).toBe(200)
  })

  it('lança erro (não zera silenciosamente) quando a live não resolve marca', async () => {
    const db = { query: async (sql) => String(sql).includes('FROM lives l') ? { rows: [{ id: 'L', marca_id: null }] } : { rows: [] } }
    await expect(calcularComissoesDaLive(db, { liveId: 'L', tenantId: 'T', gmv: 1000 }))
      .rejects.toThrow(/marca/i)
  })

  it('resolve marca independentemente do status (status não zera comissão)', async () => {
    const calls = []
    const db = { query: async (sql, params) => { calls.push(String(sql));
      if (String(sql).includes('FROM lives l')) return { rows: [{ id: 'L', marca_id: 'M', comissao_franquia_pct: 10 }] }
      return { rows: [] } } }
    await calcularComissoesDaLive(db, { liveId: 'L', tenantId: 'T', gmv: 1000, pedidos: 1 }).catch(() => {})
    const joinSql = calls.find(s => s.includes('LEFT JOIN marcas m'))
    expect(joinSql).toBeTruthy()
    expect(joinSql).not.toContain("m.status = 'ativa'")
  })

  it('não persiste auto-heal de marca_id (bloco removido: marca é NOT NULL por invariante)', async () => {
    const marcaUpdates = []
    const queryMock = vi.fn(async (sql, values) => {
      if (sql.includes('FROM lives l')) {
        return {
          rows: [{
            id: 'live-9',
            cliente_id: 'cliente-1',
            live_marca_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            apresentador_id: 'user-1',
            iniciado_em: '2026-05-20T18:00:00.000Z',
            comissao_pct: '10',
            marca_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            comissao_franquia_pct: '10',
            comissao_franqueadora_pct: '2',
            valor_fixo_minimo: '0',
          }],
        }
      }
      if (sql.includes('UPDATE lives SET marca_id')) {
        marcaUpdates.push(values)
        return { rows: [] }
      }
      if (sql.includes('SELECT DISTINCT ap.id AS apresentadora_id')) {
        return { rows: [{ apresentadora_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', comissao_live_pct: null, percentual_rateio: null }] }
      }
      if (sql.includes('FROM vendas_atribuidas')) return { rows: [{ gmv_mes: '0' }] }
      if (sql.includes('FROM apresentadora_comissao_faixas')) return { rows: [] }
      if (sql.includes('INSERT INTO vendas_atribuidas')) return { rows: [{ comissao_franquia: 0 }] }
      return { rows: [] }
    })

    await calcularComissoesDaLive({ query: queryMock }, {
      tenantId: 'tenant-1', liveId: 'live-9', gmv: 1000,
    })

    // Auto-heal removido: o engine não deve mais emitir UPDATE lives SET marca_id.
    expect(marcaUpdates).toHaveLength(0)
  })
})
