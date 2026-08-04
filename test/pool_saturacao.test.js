import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'

/**
 * "Quanto mais tempo mexendo, mais erros aparecem."
 *
 * O semáforo do tenantParallel era criado por CHAMADA, não por processo. Isso limita um
 * handler isolado e não limita nada no conjunto: dois /home/dashboard simultâneos pediam
 * 2×PARALLEL_MAX conexões, enquanto as rotas de página (withTenant, 1 conexão cada, ~8 em
 * paralelo ao abrir uma tela) disputavam o resto. Com o pool clampado em 10 pela cota do
 * pooler, bastava pouca gente mexendo junto para o pool.connect() encostar no
 * connectionTimeoutMillis de 8s e virar erro.
 *
 * Este teste mede o PICO de conexões simultaneamente em uso. Ele tem que respeitar o teto
 * global mesmo com vários handlers concorrendo.
 */

let emUso = 0
let pico = 0

vi.mock('pg', () => {
  class PoolFalso {
    async connect() {
      emUso += 1
      if (emUso > pico) pico = emUso
      return {
        query: async () => {
          // segura a conexão por um tick, como uma query real seguraria
          await new Promise((r) => setTimeout(r, 5))
          return { rows: [], rowCount: 0 }
        },
        release: () => { emUso -= 1 },
      }
    }
    async query() { return { rows: [{ ok: 1 }], rowCount: 1 } }
    async end() {}
    on() {}
  }
  const types = { setTypeParser: () => {}, builtins: {} }
  return { default: { Pool: PoolFalso, types }, Pool: PoolFalso, types }
})

const TENANT_A = '394b446a-bdae-4234-aac5-72021e6f15aa'
const TENANT_B = '11111111-1111-4111-8111-111111111111'

describe('tenantParallel — teto global de conexões', () => {
  it('vários handlers simultâneos não estouram o teto do pool', async () => {
    emUso = 0; pico = 0
    process.env.DB_POOL_MAX = '10'
    process.env.DB_SYSTEM_POOL_MAX = '3'
    const { dbPlugin } = await import('../src/plugins/db.js')
    const app = Fastify()
    await app.register(dbPlugin)

    // 4 "requests" simultâneos, cada um disparando 20 queries — é o que a home faz
    const handler = (tenant) => {
      const db = app.tenantParallel(tenant)
      return Promise.all(Array.from({ length: 20 }, (_, i) => db.query(`SELECT ${i}`)))
    }
    await Promise.all([
      handler(TENANT_A), handler(TENANT_B), handler(TENANT_A), handler(TENANT_B),
    ])

    // Sem o teto global, 4 handlers × PARALLEL_MAX (6) chegariam a 24 conexões pedidas ao
    // mesmo tempo — muito além do pool de 10, que é o que virava timeout e erro.
    expect(pico).toBeLessThanOrEqual(10)
    // E precisa sobrar espaço para as rotas de conexão única não ficarem atrás da home.
    expect(pico).toBeLessThanOrEqual(6)
    expect(emUso).toBe(0) // toda conexão devolvida
    await app.close()
  })

  it('todas as queries completam mesmo enfileiradas', async () => {
    emUso = 0; pico = 0
    const { dbPlugin } = await import('../src/plugins/db.js')
    const app = Fastify()
    await app.register(dbPlugin)
    const db = app.tenantParallel(TENANT_A)
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => db.query(`SELECT ${i}`)))
    expect(rs).toHaveLength(50)
    expect(emUso).toBe(0)
    await app.close()
  })
})
