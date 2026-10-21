import { describe, expect, it, vi } from 'vitest'

import { getClientePortalContext } from '../src/lib/cliente_resolver.js'

describe('cliente portal reviewed context', () => {
  it('fails closed when a user has no single active cliente brand', async () => {
    const db = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'cliente-1', nome: 'Cliente', status: 'ativo' }] })
      .mockResolvedValueOnce({ rows: [
        { id: 'marca-a', nome: 'A' },
        { id: 'marca-b', nome: 'B' },
      ] }) }

    await expect(getClientePortalContext(db, 'user-1', 'tenant-1')).resolves.toBeNull()
  })

  it('uses the authenticated user link without imposing a customer lifecycle status', async () => {
    const db = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'cliente-1', nome: 'Cliente', status: 'negociacao' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'marca-1', nome: 'Marca' }] }) }

    await expect(getClientePortalContext(db, 'user-1', 'tenant-1')).resolves.toEqual({
      clienteId: 'cliente-1', marcaId: 'marca-1', marcaNome: 'Marca',
    })
  })
})
