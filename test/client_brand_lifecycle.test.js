import { describe, expect, it, vi } from 'vitest'

import { ensureClienteMarca } from '../src/services/client-brand.js'

describe('ensureClienteMarca lifecycle', () => {
  it('preserva uma marca inativa em chamadas normais', async () => {
    const query = vi.fn(async (sql) => {
      if (sql.includes('FROM marcas')) return { rows: [{ id: 'marca-inativa', status: 'inativa' }] }
      throw new Error(`query inesperada: ${sql}`)
    })

    await expect(ensureClienteMarca({ query }, { tenantId: 'tenant-a', clienteId: 'cliente-a' })).resolves.toBe('marca-inativa')
    expect(query).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['cancelado', 'inativa'],
    ['cancelado_automaticamente', 'inativa'],
    ['arquivado', 'arquivada'],
    ['ativo', 'ativa'],
  ])('cria o espelho com status %s como %s', async (statusCliente, statusMarca) => {
    const inserts = []
    const query = vi.fn(async (sql, params = []) => {
      if (sql.includes('FROM marcas')) return { rows: [] }
      if (sql.includes('FROM clientes')) return { rows: [{ id: 'cliente-a', nome: 'Cliente', status: statusCliente, site: null, logo_url: null }] }
      if (sql.includes('INSERT INTO marcas')) {
        inserts.push(params)
        return { rows: [{ id: 'marca-nova' }] }
      }
      throw new Error(`query inesperada: ${sql}`)
    })

    await expect(ensureClienteMarca({ query }, { tenantId: 'tenant-a', clienteId: 'cliente-a' })).resolves.toBe('marca-nova')
    expect(inserts[0][3]).toBe(statusMarca)
  })

  it.each(['cancelado', 'arquivado'])('não reativa espelho de cliente %s mesmo com pedido explícito', async (statusCliente) => {
    const calls = []
    const query = vi.fn(async (sql) => {
      calls.push(sql)
      if (sql.includes('FROM marcas')) return { rows: [{ id: 'marca-inativa', status: 'inativa' }] }
      if (sql.includes('FROM clientes')) return { rows: [{ status: statusCliente }] }
      throw new Error(`query inesperada: ${sql}`)
    })

    await expect(ensureClienteMarca({ query }, { tenantId: 'tenant-a', clienteId: 'cliente-a', activateExisting: true })).resolves.toBe('marca-inativa')
    expect(calls.some((sql) => sql.includes('UPDATE marcas'))).toBe(false)
  })
})
