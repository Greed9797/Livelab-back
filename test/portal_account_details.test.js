import { describe, expect, it, vi } from 'vitest'
import { getAccountPhoto } from '../src/services/account-photo.js'
import { getOwnPortalRemuneration } from '../src/services/portal-apresentadora-remuneracao.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const apresentadoraId = '22222222-2222-4222-8222-222222222222'

describe('presenter account details', () => {
  it('uses the canonical monthly total and scopes every source before reading', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ apresentadora_id: apresentadoraId, nome: 'Ana', valor: '1440.00' }] })
      .mockResolvedValueOnce({ rows: [{ apresentadora_id: apresentadoraId, nome: 'Ana', valor: '35.50' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'extra', apresentadora_id: apresentadoraId, nome: 'Ana', tipo: 'bonificacao', descricao: 'Meta', valor: '100.25' }] })
    const result = await getOwnPortalRemuneration({ query }, { tenantId, apresentadoraId, mes: '2026-09' })
    expect(result).toMatchObject({ mes: '2026-09', fixo: 1440, comissao: 35.5, adicionais: 100.25, total: 1575.75 })
    expect(result.extras).toHaveLength(1)
    for (const [sql, params] of query.mock.calls) {
      expect(params[0]).toBe(tenantId)
      expect(params.at(-1)).toBe(apresentadoraId)
      expect(sql).toMatch(/AND (?:a\.id|va\.apresentadora_id|ara\.apresentadora_id) = \$[34]::uuid/)
    }
  })

  it('never falls back to reading the whole unit when profile is missing', async () => {
    const query = vi.fn()
    for (const id of [undefined, null, '', 'invalid']) {
      await expect(getOwnPortalRemuneration({ query }, { tenantId, apresentadoraId: id, mes: '2026-09' })).rejects.toThrow()
    }
    expect(query).not.toHaveBeenCalled()
  })

  it('returns zero for an empty own monthly closing', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    expect(await getOwnPortalRemuneration({ query }, { tenantId, apresentadoraId, mes: '2026-09' }))
      .toEqual({ mes: '2026-09', fixo: 0, comissao: 0, adicionais: 0, total: 0, extras: [] })
  })

  it('reads photo only through the authenticated explicit tenant/account link', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ foto_url: 'https://example.com/photo.jpg' }] })
    expect(await getAccountPhoto({ query }, { id: apresentadoraId, tenant_id: tenantId, papel: 'apresentadora' })).toBe('https://example.com/photo.jpg')
    expect(query.mock.calls[0][1]).toEqual([apresentadoraId, tenantId])
    expect(query.mock.calls[0][0]).toContain('user_id=$1::uuid AND tenant_id=$2::uuid')
    expect(query.mock.calls[0][0]).not.toContain('email')
  })

  it('does not guess a photo for missing or ambiguous links, or other roles', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ foto_url: 'one' }, { foto_url: 'two' }] })
    const user = { id: apresentadoraId, tenant_id: tenantId, papel: 'apresentador' }
    expect(await getAccountPhoto({ query }, user)).toBeNull()
    expect(await getAccountPhoto({ query }, user)).toBeNull()
    expect(await getAccountPhoto({ query }, { ...user, papel: 'admin' })).toBeNull()
    expect(query).toHaveBeenCalledTimes(2)
  })
})
