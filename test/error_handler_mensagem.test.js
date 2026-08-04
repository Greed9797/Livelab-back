import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'

/**
 * O errorHandler global passou a ser registrado ANTES dos plugins (senão não valia para
 * nenhuma das 48 rotas). Com isso ele passou a interceptar também os erros que os PLUGINS
 * montam — e nem todos usam `.message`.
 *
 * O @fastify/rate-limit monta o erro pelo errorResponseBuilder e põe o texto em `.error`,
 * sem `.message`. Sem fallback, o 429 chegava ao navegador como {"statusCode":429}: nenhuma
 * palavra explicando, e a UI mostra "erro de servidor" em vez de "excedeu, tente de novo".
 */
describe('errorHandler — nunca responder sem mensagem', () => {
  const handler = (error, request, reply) => {
    const status = error.statusCode ?? 500
    if (status >= 500) {
      const msg = 'Erro interno do servidor'
      return reply.code(500).send({ statusCode: 500, error: msg, message: msg })
    }
    const msg = error.message || error.error || 'Erro ao processar a requisição'
    return reply.code(status).send({ statusCode: status, error: msg, message: msg })
  }

  async function responder(lancar) {
    const app = Fastify()
    app.setErrorHandler(handler)
    app.get('/x', async () => { throw lancar })
    await app.ready()
    const r = await app.inject({ method: 'GET', url: '/x' })
    await app.close()
    return { status: r.statusCode, body: r.json() }
  }

  it('erro no formato do rate-limit (texto em .error, sem .message) sai com mensagem', async () => {
    const erroRateLimit = Object.assign(new Error(), {
      statusCode: 429,
      error: 'Muitas requisições. Tente novamente em breve.',
      message: '', // é isso que o rate-limit entrega
    })
    const { status, body } = await responder(erroRateLimit)
    expect(status).toBe(429)
    expect(body.error).toBe('Muitas requisições. Tente novamente em breve.')
    expect(body.message).toBe('Muitas requisições. Tente novamente em breve.')
  })

  it('erro comum de 4xx preserva a própria mensagem', async () => {
    const { body } = await responder(Object.assign(new Error('Marca não encontrada'), { statusCode: 404 }))
    expect(body.error).toBe('Marca não encontrada')
  })

  it('nenhum 4xx sai sem texto, mesmo sem message e sem error', async () => {
    const { status, body } = await responder(Object.assign(new Error(''), { statusCode: 400 }))
    expect(status).toBe(400)
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
  })

  it('5xx não vaza o texto cru do banco', async () => {
    const { status, body } = await responder(new Error('invalid input syntax for type uuid: ""'))
    expect(status).toBe(500)
    expect(body.error).toBe('Erro interno do servidor')
    expect(JSON.stringify(body)).not.toContain('uuid')
  })
})
