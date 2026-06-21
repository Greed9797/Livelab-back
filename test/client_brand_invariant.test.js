import { describe, expect, it, vi } from 'vitest'

import { ensureClienteMarca } from '../src/services/client-brand.js'

describe('ensureClienteMarca (invariante cliente->marca)', () => {
  it('retorna a marca existente sem criar outra', async () => {
    const query = vi.fn(async (sql) => {
      if (sql.includes('FROM marcas')) {
        return { rows: [{ id: 'marca-existente', status: 'ativa' }] }
      }
      throw new Error(`query inesperada: ${sql}`)
    })

    const id = await ensureClienteMarca({ query }, {
      tenantId: 'tenant-a',
      clienteId: 'cliente-1',
    })

    expect(id).toBe('marca-existente')
    // Não deve inserir nem buscar o cliente — só o SELECT da marca.
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('reativa a marca quando ela está inativa', async () => {
    const calls = []
    const query = vi.fn(async (sql, params) => {
      calls.push(sql)
      if (sql.includes('SELECT id, status') && sql.includes('FROM marcas')) {
        return { rows: [{ id: 'marca-inativa', status: 'inativa' }] }
      }
      if (sql.includes('UPDATE marcas') && sql.includes("status = 'ativa'")) {
        return { rows: [{ id: params[0] }] }
      }
      throw new Error(`query inesperada: ${sql}`)
    })

    const id = await ensureClienteMarca({ query }, { tenantId: 'tenant-a', clienteId: 'cliente-1' })

    expect(id).toBe('marca-inativa')
    expect(calls.some((s) => s.includes('UPDATE marcas'))).toBe(true)
  })

  it('cria a marca a partir do cliente quando não existe nenhuma', async () => {
    const query = vi.fn(async (sql, params) => {
      if (sql.includes('FROM marcas')) return { rows: [] }
      if (sql.includes('FROM clientes')) {
        return { rows: [{ id: params[0], nome: 'Cliente Blumenau', tiktok_username: 'blu', site: null, logo_url: null }] }
      }
      if (sql.includes('INSERT INTO marcas')) return { rows: [{ id: 'marca-nova' }] }
      throw new Error(`query inesperada: ${sql}`)
    })

    const id = await ensureClienteMarca({ query }, { tenantId: 'tenant-a', clienteId: 'cliente-1' })

    expect(id).toBe('marca-nova')
  })

  it('retorna null quando faltam tenantId ou clienteId', async () => {
    const query = vi.fn()
    expect(await ensureClienteMarca({ query }, { tenantId: null, clienteId: 'x' })).toBeNull()
    expect(await ensureClienteMarca({ query }, { tenantId: 't', clienteId: null })).toBeNull()
    expect(query).not.toHaveBeenCalled()
  })
})
