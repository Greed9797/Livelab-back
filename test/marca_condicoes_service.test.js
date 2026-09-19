import { beforeEach, describe, expect, it, vi } from 'vitest'
import { confirmarCondicaoMarca, preverCondicaoMarca } from '../src/services/marca-condicoes.js'

const tenantId = '00000000-0000-4000-8000-000000000001'
const marcaId = '00000000-0000-4000-8000-000000000002'
const conditionId = '00000000-0000-4000-8000-000000000003'

function fakeDb({ closed = false, failInsert = false, existingIdempotency = null } = {}) {
  const calls = []
  const db = {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params })
      if (sql === 'BEGIN' || sql.startsWith('BEGIN TRANSACTION') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
      if (sql.includes('FROM marcas') && sql.includes('FOR UPDATE')) return { rows: [{ id: marcaId }] }
      if (sql.includes('FROM marcas') && !sql.includes('marca_condicoes')) return { rows: [{ id: marcaId }] }
      if (sql.includes('idempotency_key') && sql.includes('FOR UPDATE')) return { rows: existingIdempotency ? [existingIdempotency] : [] }
      if (sql.includes('FROM marca_condicoes_comerciais') && sql.includes('ORDER BY')) return { rows: [{ id: 'baseline', inicio_vigencia: '1900-01-01', fixo_mensal: '0.00', comissao_franquia_pct: '0.00', comissao_franqueadora_pct: '0.00', tipo_cobranca: 'fixo_mais_comissao', fixo_confirmado: false, comissao_confirmada: false, origem: 'legado_nao_verificado', revision: 1 }] }
      if (sql.includes('COUNT(*) FILTER') && sql.includes('FROM lives')) return { rows: [{ fechados: closed ? 1 : 0, abertos: closed ? 0 : 1, gmv_aberto: '10000' }] }
      if (sql.includes('COUNT(*) FILTER') && sql.includes('FROM vendas_atribuidas')) return { rows: [{ fechados: 0, abertos: 0, gmv_aberto: '0' }] }
      if (sql.includes('GROUP BY va.data')) return { rows: [] }
      if (sql.startsWith('INSERT INTO marca_condicoes')) {
        if (failInsert) throw new Error('injected failure')
        return { rows: [{ id: conditionId, inicio_vigencia: '2026-09-01', fixo_mensal: '1200.00', comissao_franquia_pct: '8.00', comissao_franqueadora_pct: '0.00', tipo_cobranca: 'fixo_mais_comissao', revision: 2, payload_hash: params.at(-1) }] }
      }
      return { rows: [], rowCount: 0 }
    },
  }
  return db
}

const proposal = { inicio_vigencia: '2026-09', fixo_mensal: 1200, comissao_franquia_pct: 8, comissao_franqueadora_pct: 0, tipo_cobranca: 'fixo_mais_comissao', fixo_confirmado: true, comissao_confirmada: true }

describe('serviço transacional de condições comerciais', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('preview abre leitura repetível, informa impacto e não grava', async () => {
    const db = fakeDb()
    const result = await preverCondicaoMarca(db, { tenantId, marcaId, proposta: proposal })
    expect(result.impacto.movimentos_abertos).toBe(1)
    expect(result.bloqueada).toBe(false)
    expect(result.competencia).toBe('2026-09')
    expect(result.proposta).toMatchObject({
      competencia: '2026-09',
      inicio_vigencia: '2026-09-01',
      fixo_mensal: 1200,
      comissao_franquia_pct: 8,
      tipo_cobranca: 'fixo_mais_comissao',
    })
    expect(result.proposta).not.toHaveProperty('fixo_mensal_cents')
    expect(result.condicao_anterior).toMatchObject({
      competencia: '1900-01',
      a_revisar: true,
      origem: 'legado_nao_verificado',
    })
    expect(db.calls.map((call) => call.sql)).toContain('ROLLBACK')
    expect(db.calls.some((call) => call.sql.startsWith('INSERT') || call.sql.startsWith('UPDATE'))).toBe(false)
  })

  it('rejeita período fechado e desfaz a transação inteira', async () => {
    const db = fakeDb({ closed: true })
    await expect(confirmarCondicaoMarca(db, { tenantId, marcaId, proposta: proposal, expectedRevision: 1, idempotencyKey: 'closed-1' })).rejects.toMatchObject({ code: 'FINANCIAL_PERIOD_CLOSED', statusCode: 409 })
    expect(db.calls.map((call) => call.sql)).toContain('ROLLBACK')
    expect(db.calls.some((call) => call.sql.startsWith('INSERT INTO marca_condicoes'))).toBe(false)
  })

  it('rollbacka falha intermediária e não deixa condição parcial', async () => {
    const db = fakeDb({ failInsert: true })
    await expect(confirmarCondicaoMarca(db, { tenantId, marcaId, proposta: proposal, expectedRevision: 1, idempotencyKey: 'fail-1' })).rejects.toThrow('injected failure')
    expect(db.calls.map((call) => call.sql)).toContain('ROLLBACK')
    expect(db.calls.map((call) => call.sql)).not.toContain('COMMIT')
  })

  it('retry idempotente devolve a condição existente sem recalcular', async () => {
    const db = fakeDb({ existingIdempotency: { id: conditionId, payload_hash: JSON.stringify({ inicio_vigencia: '2026-09-01', fixo_mensal_cents: 120000, comissao_franquia_basis: 800, comissao_franqueadora_basis: 0, tipo_cobranca: 'fixo_mais_comissao', fixo_confirmado: true, comissao_confirmada: true, origem: 'gestao', motivo: null }) } })
    const result = await confirmarCondicaoMarca(db, { tenantId, marcaId, proposta: proposal, expectedRevision: 1, idempotencyKey: 'retry-1' })
    expect(result.idempotent).toBe(true)
    expect(db.calls.map((call) => call.sql)).toContain('COMMIT')
    expect(db.calls.some((call) => call.sql.startsWith('UPDATE lives'))).toBe(false)
  })
})
