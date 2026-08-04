import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

/**
 * Regressão de isolamento entre tenants.
 *
 * Uma otimização guardava o tenant numa marca no objeto do client (`client.__tenantId`) para
 * pular o `set_config` quando a conexão já estivesse no tenant certo. A marca MENTE: `dbTenant`
 * e os ~24 `pool.connect()` crus de jobs e rotas trocam o tenant da MESMA conexão sem saber que
 * ela existe. Bastava um deles rodar no meio para a query seguinte rodar sob o tenant errado —
 * sem erro nenhum, porque `current_setting('app.tenant_id', true)` com o tenant errado vira
 * `WHERE tenant_id = <outro>` e devolve 0 linhas em silêncio.
 *
 * Efeito em produção: GMV e horas zerados na Home enquanto ranking e grade mostravam dados,
 * piorando conforme o pool circulava. Contra o banco real, 469 lives viraram 0.
 *
 * Este teste fixa a invariante: TODA query de tenantParallel manda o set_config antes.
 */

const registrado = []
let clientCompartilhado

vi.mock('pg', () => {
  class PoolFalso {
    constructor() { this.__id = registrado.length }
    async connect() { return clientCompartilhado }
    async query() { return { rows: [{ ok: 1 }], rowCount: 1 } }
    async end() {}
    on() {}
  }
  // `types` é obrigatório: src/lib/pg-date-string.js registra parsers no import do plugin.
  const types = { setTypeParser: () => {}, builtins: { DATE: 1082, TIMESTAMP: 1114, TIMESTAMPTZ: 1184, NUMERIC: 1700 } }
  return { default: { Pool: PoolFalso, types }, Pool: PoolFalso, types }
})

const TENANT_A = '394b446a-bdae-4234-aac5-72021e6f15aa'
const TENANT_B = '11111111-1111-4111-8111-111111111111'

async function montar() {
  registrado.length = 0
  clientCompartilhado = {
    query: vi.fn(async (text, params) => {
      registrado.push({ text: String(text), params })
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  const { dbPlugin } = await import('../src/plugins/db.js')
  const app = Fastify()
  await app.register(dbPlugin)
  registrado.length = 0 // descarta o que o boot do plugin emitiu
  return app
}

const setConfigs = () => registrado.filter((q) => q.text.includes('set_config'))

describe('tenantParallel — set_config em toda query, sem cache', () => {
  beforeEach(() => { registrado.length = 0 })

  it('manda set_config antes de CADA query, mesmo repetindo o mesmo tenant', async () => {
    const app = await montar()
    const db = app.tenantParallel(TENANT_A)
    await db.query('SELECT 1')
    await db.query('SELECT 2')
    await db.query('SELECT 3')
    // A versão com cache mandaria apenas 1. É exatamente essa economia que quebrava tudo.
    expect(setConfigs()).toHaveLength(3)
    expect(setConfigs().every((q) => q.params[0] === TENANT_A)).toBe(true)
    await app.close()
  })

  it('não confia em marca deixada no client por outro caminho de código', async () => {
    const app = await montar()
    clientCompartilhado.__tenantId = TENANT_A // resíduo que a otimização antiga deixava
    await app.tenantParallel(TENANT_A).query('SELECT 1')
    expect(setConfigs()).toHaveLength(1)
    await app.close()
  })

  it('troca de tenant na mesma conexão sempre reconfigura a sessão', async () => {
    const app = await montar()
    await app.tenantParallel(TENANT_A).query('SELECT 1')
    await app.tenantParallel(TENANT_B).query('SELECT 2')
    await app.tenantParallel(TENANT_A).query('SELECT 3')
    expect(setConfigs().map((q) => q.params[0])).toEqual([TENANT_A, TENANT_B, TENANT_A])
    await app.close()
  })

  it('dbTenant também configura a sessão ao adquirir a conexão', async () => {
    const app = await montar()
    const db = await app.dbTenant(TENANT_B)
    expect(setConfigs().map((q) => q.params[0])).toEqual([TENANT_B])
    db.release()
    await app.close()
  })
})
