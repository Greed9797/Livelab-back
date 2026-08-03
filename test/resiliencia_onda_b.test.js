import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import { TikTokService } from '../src/services/tiktok.js'

describe('setErrorHandler precisa valer para as rotas registradas via register()', () => {
  // Nenhum módulo de rota usa fastify-plugin, então cada register encapsula e fotografa
  // o errorHandler vigente. Registrado no fim do arquivo, o handler custom não valia para
  // NENHUMA das 48 rotas: o Sentry nunca via erro de rota e a mensagem crua do Postgres
  // ia para o navegador. Este teste fixa a ordem correta.
  const montar = async (ordem) => {
    const app = Fastify()
    const handler = (error, request, reply) => {
      const status = error.statusCode ?? 500
      const msg = status >= 500 ? 'Erro interno do servidor' : error.message
      return reply.code(status).send({ statusCode: status, error: msg, message: msg })
    }
    const rotas = async (instance) => {
      instance.get('/quebra', async () => { throw new Error('detalhe cru do postgres') })
    }
    if (ordem === 'antes') app.setErrorHandler(handler)
    await app.register(rotas)
    if (ordem === 'depois') app.setErrorHandler(handler)
    await app.ready()
    return app
  }

  it('handler registrado ANTES do register captura o erro da rota', async () => {
    const app = await montar('antes')
    const r = await app.inject({ method: 'GET', url: '/quebra' })
    expect(r.statusCode).toBe(500)
    expect(r.json()).toEqual({
      statusCode: 500, error: 'Erro interno do servidor', message: 'Erro interno do servidor',
    })
    await app.close()
  })

  it('registrado DEPOIS, a mensagem crua vaza — o comportamento que tínhamos', async () => {
    const app = await montar('depois')
    const r = await app.inject({ method: 'GET', url: '/quebra' })
    expect(r.json().message).toContain('detalhe cru do postgres')
    await app.close()
  })

  it('as três chaves são emitidas — clientes antigos leem statusCode/message', async () => {
    const app = await montar('antes')
    const body = (await app.inject({ method: 'GET', url: '/quebra' })).json()
    expect(Object.keys(body).sort()).toEqual(['error', 'message', 'statusCode'])
    await app.close()
  })
})

describe('TikTok: falha de rede NÃO pode encerrar live (encerrar = cobrar)', () => {
  // getLiveData devolvia offlineState no catch. offlineState leva ao ramo que faz
  // UPDATE lives SET status='encerrada', e billing_engine + recalcular_comissoes leem
  // exatamente 'encerrada' para gerar boleto e comissão. Timeout de rede viraria fatura.
  let fetchOriginal
  beforeEach(() => { fetchOriginal = globalThis.fetch })
  afterEach(() => { globalThis.fetch = fetchOriginal })

  it('timeout devolve null, não um estado "offline"', async () => {
    globalThis.fetch = vi.fn(async () => {
      const err = new Error('The operation was aborted due to timeout')
      err.name = 'TimeoutError'
      throw err
    })
    const r = await TikTokService.getLiveData('tenant-x', 'token-y')
    expect(r).toBeNull()
    // O contrário do que precisamos: qualquer objeto com status seguiria para o ramo
    // que encerra a live.
    expect(r?.status).toBeUndefined()
  })

  it('queda de conexão também devolve null', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNRESET') })
    expect(await TikTokService.getLiveData('tenant-x', 'token-y')).toBeNull()
  })

  it('a chamada leva AbortSignal — sem ele o default do undici é 300s', async () => {
    let recebido
    globalThis.fetch = vi.fn(async (_url, opts) => {
      recebido = opts
      throw new Error('parou aqui de propósito')
    })
    await TikTokService.getLiveData('tenant-x', 'token-y')
    expect(recebido?.signal).toBeDefined()
  })
})
