import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(new URL('../migrations/178_marcas_data_fim_inativas.sql', import.meta.url), 'utf8')

describe('migration 178', () => {
  it('usa fuso de São Paulo e prefere a data do cancelamento no audit_log', () => {
    expect(sql).toContain("(atualizado_em AT TIME ZONE 'America/Sao_Paulo')::date")
    expect(sql).toContain("a.action = 'clientes.status_alterado'")
    expect(sql).toContain("(MAX(a.criado_em) AT TIME ZONE 'America/Sao_Paulo')::date")
    expect(sql).not.toMatch(/atualizado_em::date/)
  })
  it('segue idempotente (só data_fim IS NULL)', () => {
    expect(sql).toContain('AND data_fim IS NULL')
  })
})

describe('migration 178 — todos os tipos de marca', () => {
  it('não restringe o backfill a tipo = cliente', () => {
    expect(sql).not.toMatch(/WHERE\s+tipo\s*=\s*'cliente'/)
    expect(sql).toContain("status IN ('inativa', 'arquivada')")
  })
})
