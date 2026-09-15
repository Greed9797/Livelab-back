import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isLiveMergeEnabled } from '../src/lib/live-merge.js'

describe('rollout global autorizado da união de lives', () => {
  it('configura a imagem publicada para todas as unidades e permite desligar em runtime', () => {
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
    const configured = dockerfile.match(/^ENV LIVE_MERGE_TENANT_ALLOWLIST="([^"]*)"$/m)?.[1]
    expect(configured).toBe('*')
    for (const tenant of ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']) {
      expect(isLiveMergeEnabled(tenant, { LIVE_MERGE_TENANT_ALLOWLIST: configured })).toBe(true)
      expect(isLiveMergeEnabled(tenant, { LIVE_MERGE_TENANT_ALLOWLIST: 'off' })).toBe(false)
    }
  })
})
