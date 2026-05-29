// test/oauth-state.test.js
import { describe, it, expect, beforeEach } from 'vitest'
import { createSignedState, verifySignedState } from '../src/services/oauth-state.js'

describe('oauth-state', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-32-chars-minimum-please-ok'
  })

  it('round-trip de state válido retorna tenantId e nonce', () => {
    const state = createSignedState({ tenantId: '00000000-0000-0000-0000-000000000001', nonce: 'abc' })
    const verified = verifySignedState(state)
    expect(verified).not.toBeNull()
    expect(verified.tenantId).toBe('00000000-0000-0000-0000-000000000001')
    expect(verified.nonce).toBe('abc')
  })

  it('rejeita state com assinatura tampered', () => {
    const state = createSignedState({ tenantId: 'tenant-1', nonce: 'abc' })
    const tampered = state.slice(0, -4) + 'XXXX'
    expect(verifySignedState(tampered)).toBeNull()
  })

  it('rejeita state expirado', async () => {
    const state = createSignedState({ tenantId: 'tenant-1', nonce: 'abc' })
    // Aguarda 50ms e valida com TTL de 10ms → garantido expirado
    await new Promise(r => setTimeout(r, 50))
    expect(verifySignedState(state, 10)).toBeNull()
  })

  it('rejeita state com formato inválido', () => {
    expect(verifySignedState('foo')).toBeNull()
    expect(verifySignedState('foo:bar')).toBeNull()
    expect(verifySignedState('foo:bar:baz')).toBeNull()
  })

  it('rejeita state com tenantId alterado', () => {
    const state = createSignedState({ tenantId: 'tenant-1', nonce: 'abc' })
    const parts = state.split(':')
    parts[0] = 'tenant-2'
    const tampered = parts.join(':')
    expect(verifySignedState(tampered)).toBeNull()
  })

  it('rejeita input não-string', () => {
    expect(verifySignedState(null)).toBeNull()
    expect(verifySignedState(undefined)).toBeNull()
    expect(verifySignedState(123)).toBeNull()
  })

  it('createSignedState exige tenantId e nonce', () => {
    expect(() => createSignedState({ tenantId: '', nonce: 'abc' })).toThrow()
    expect(() => createSignedState({ tenantId: 'x', nonce: '' })).toThrow()
  })
})
