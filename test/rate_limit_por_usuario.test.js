import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'

/**
 * O rate limit dizia (em comentário) que separava a cota por usuário e caía no IP só para
 * anônimos. Não separava: `keyGenerator` lia `request.user?.sub`, e o rate-limit roda no hook
 * onRequest — antes do preHandler que verifica o JWT. O valor era SEMPRE undefined, então a
 * chave caía sempre no IP.
 *
 * Consequência: um escritório atrás de NAT dividia 300 req/min entre todo mundo. Medido antes
 * da correção: 6 "usuários" distintos estouraram juntos com ~48 requests cada (~300 no total).
 * É o "quanto mais gente mexendo, mais erros aparecem".
 */

// A função de verdade, a mesma que o app.js registra. Antes era uma cópia
// colada aqui: cópia envelhece sem avisar, e um teste que passa sobre a cópia
// não prova nada sobre o que está no ar.
import { chaveDeRateLimit as keyGenerator } from '../src/lib/rate-limit-key.js'

const tokenCom = (sub) => {
  const parte = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${parte({ alg: 'HS256' })}.${parte({ sub })}.assinatura-irrelevante-aqui`
}

async function montar(max) {
  const app = Fastify()
  await app.register(rateLimit, { max, timeWindow: '1 minute', keyGenerator })
  app.get('/x', async () => ({ ok: true }))
  await app.ready()
  return app
}

const bater = async (app, token, n) => {
  let ok = 0, limitados = 0
  for (let i = 0; i < n; i += 1) {
    const r = await app.inject({
      method: 'GET', url: '/x',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
    if (r.statusCode === 200) ok += 1
    else if (r.statusCode === 429) limitados += 1
  }
  return { ok, limitados }
}

describe('rate limit — cota por usuário, não por IP', () => {
  it('usuários diferentes no MESMO IP não dividem a cota', async () => {
    const app = await montar(5)
    const a = await bater(app, tokenCom('usuario-a'), 5)
    const b = await bater(app, tokenCom('usuario-b'), 5)
    // Antes: o segundo usuário já chegava limitado, porque a chave era o IP compartilhado.
    expect(a).toEqual({ ok: 5, limitados: 0 })
    expect(b).toEqual({ ok: 5, limitados: 0 })
    await app.close()
  })

  it('o MESMO usuário continua limitado ao estourar a cota', async () => {
    const app = await montar(3)
    const r = await bater(app, tokenCom('usuario-c'), 6)
    expect(r).toEqual({ ok: 3, limitados: 3 })
    await app.close()
  })

  it('anônimos (sem token) continuam agrupados por IP', async () => {
    const app = await montar(3)
    const r = await bater(app, null, 5)
    expect(r.limitados).toBe(2)
    await app.close()
  })

  it('duas chaves de API não dividem cota, e cada uma respeita o próprio teto', async () => {
    const app = await montar(3)
    const bater = async (chave, n) => {
      let ok = 0, limitados = 0
      for (let i = 0; i < n; i += 1) {
        const r = await app.inject({ method: 'GET', url: '/x', headers: { 'x-api-key': chave } })
        if (r.statusCode === 200) ok += 1
        else if (r.statusCode === 429) limitados += 1
      }
      return { ok, limitados }
    }

    // O bot A estoura o próprio teto...
    expect(await bater('llk_bot-a', 5)).toEqual({ ok: 3, limitados: 2 })
    // ...e o bot B começa com a cota inteira, mesmo saindo pelo mesmo IP.
    expect(await bater('llk_bot-b', 3)).toEqual({ ok: 3, limitados: 0 })
    await app.close()
  })

  it('chave de API não divide cota com quem está logado no mesmo IP', async () => {
    const app = await montar(2)
    const bot = await app.inject({ method: 'GET', url: '/x', headers: { 'x-api-key': 'llk_bot-c' } })
    const outro = await app.inject({ method: 'GET', url: '/x', headers: { 'x-api-key': 'llk_bot-c' } })
    expect([bot.statusCode, outro.statusCode]).toEqual([200, 200])
    // A cota do bot acabou; a de uma pessoa logada não foi tocada.
    const terceiro = await app.inject({ method: 'GET', url: '/x', headers: { 'x-api-key': 'llk_bot-c' } })
    expect(terceiro.statusCode).toBe(429)
    const pessoa = await app.inject({
      method: 'GET', url: '/x', headers: { authorization: `Bearer ${tokenCom('ana')}` },
    })
    expect(pessoa.statusCode).toBe(200)
    await app.close()
  })

  it('token malformado não derruba o request — cai no balde de IP', async () => {
    const app = await montar(10)
    const r = await app.inject({ method: 'GET', url: '/x', headers: { authorization: 'Bearer lixo' } })
    expect(r.statusCode).toBe(200)
    await app.close()
  })
})
