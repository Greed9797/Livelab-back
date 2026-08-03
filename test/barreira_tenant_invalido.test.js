import { describe, it, expect } from 'vitest'
import { assertTenantId } from '../src/plugins/db.js'

/**
 * O crash de produção: `set_config('app.tenant_id', NULL, false)` grava STRING VAZIA
 * no GUC (verificado contra o banco real — não vira NULL). Toda query que faz
 * `current_setting('app.tenant_id', true)::uuid` então estoura
 * `22P02 invalid input syntax for type uuid: ""`, e como elas vivem dentro de
 * Promise.all a rejeição escapa e derruba o processo.
 *
 * Estes testes fixam a barreira: nada que não seja UUID chega ao set_config.
 */
describe('assertTenantId — barreira contra sessão envenenada', () => {
  const TENANT = '394b446a-bdae-4234-aac5-72021e6f15aa'

  it('deixa passar um UUID válido, devolvendo o próprio valor', () => {
    expect(assertTenantId(TENANT, 'teste')).toBe(TENANT)
  })

  it('aceita UUID em maiúsculas', () => {
    expect(assertTenantId(TENANT.toUpperCase(), 'teste')).toBe(TENANT.toUpperCase())
  })

  // Cada um destes chegaria ao set_config como string vazia e mataria o processo.
  const venenos = [
    ['undefined', undefined],
    ['null', null],
    ['string vazia', ''],
    ['só espaços', '   '],
    ['número', 12345],
    ['objeto', { tenant_id: TENANT }],
    ['UUID truncado', '394b446a-bdae-4234-aac5'],
    ['texto qualquer', 'franqueado'],
    ['SQL', "'; DROP TABLE lives; --"],
  ]

  for (const [nome, valor] of venenos) {
    it(`recusa ${nome} antes de tocar no banco`, () => {
      expect(() => assertTenantId(valor, 'tenantParallel')).toThrow(/tenant_id inválido/)
    })
  }

  it('o erro diz de onde veio e marca 400 — não vira 500 anônimo', () => {
    try {
      assertTenantId('', 'dbTenant')
      throw new Error('deveria ter lançado')
    } catch (err) {
      expect(err.code).toBe('TENANT_ID_INVALIDO')
      expect(err.statusCode).toBe(400)
      expect(err.message).toContain('dbTenant')
    }
  })
})
