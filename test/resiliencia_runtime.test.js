import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { esperarDesconexao } from '../src/lib/sse.js'
import { notify } from '../src/services/mailer.js'

/**
 * Cada teste aqui corresponde a um jeito concreto de o servidor cair, pendurar ou
 * mentir — todos encontrados na auditoria depois de duas quedas totais em dois dias.
 * Se algum destes voltar a falhar, produção volta a quebrar do mesmo jeito.
 */

describe('SSE — cliente que aborta antes do await não vaza listener nem timer', () => {
  // O navegador aborta a conexão SSE o tempo todo (troca de tela). Se o 'close' passa
  // ANTES do once('close'), a Promise fica pendente para sempre e leva junto o listener
  // do emitter e o setInterval do heartbeat. É o único achado que termina em OOM.
  const fakeRequest = (destroyed) => {
    const raw = new EventEmitter()
    raw.destroyed = destroyed
    return { raw }
  }

  it('resolve na hora quando a conexão JÁ foi destruída', async () => {
    // Sem a guarda, este await nunca retornaria: 'close' não vai mais ser emitido.
    await expect(
      Promise.race([
        esperarDesconexao(fakeRequest(true)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('pendurou')), 300)),
      ]),
    ).resolves.toBeUndefined()
  })

  it('espera o close quando a conexão ainda está viva', async () => {
    const req = fakeRequest(false)
    let resolveu = false
    const p = esperarDesconexao(req).then(() => { resolveu = true })
    await new Promise((r) => setTimeout(r, 20))
    expect(resolveu).toBe(false) // ainda conectado: não pode resolver cedo
    req.raw.emit('close')
    await p
    expect(resolveu).toBe(true)
  })

  it('resolve também quando a conexão morre por erro', async () => {
    const req = fakeRequest(false)
    const p = esperarDesconexao(req)
    req.raw.emit('error', new Error('ECONNRESET'))
    await expect(p).resolves.toBeUndefined()
  })

  it('não deixa listener para trás depois de resolver', async () => {
    const req = fakeRequest(false)
    const p = esperarDesconexao(req)
    req.raw.emit('close')
    await p
    // once() remove o que disparou; o irmão fica. O que não pode é ACUMULAR a cada
    // conexão — com a guarda, requests abortados nem chegam a registrar.
    expect(req.raw.listenerCount('close')).toBe(0)
  })
})

describe('mailer.notify — chamada posicional era silenciosa', () => {
  // notify('template', {...}) desestruturava a string: todo campo virava undefined, o
  // guard retornava {ok:false} sem lançar, e a rota respondia invite_enviado: true.
  // Meses de convites que nunca saíram, sem uma linha de log.
  it('lança TypeError quando chamado com string em vez de objeto', async () => {
    await expect(notify('convite_usuario', { usuario_nome: 'X' }))
      .rejects.toThrow(TypeError)
  })

  it('a mensagem do erro ensina a assinatura certa', async () => {
    await expect(notify('convite_usuario')).rejects.toThrow(/um único objeto/)
  })

  it('objeto sem destinatário continua devolvendo skipped, não erro', async () => {
    // Comportamento preservado de propósito: destinatário ausente é dado ruim do
    // tenant, não bug de programação — não pode derrubar o request.
    const r = await notify({ template: 'x' })
    expect(r).toMatchObject({ ok: false, skipped: true })
  })
})
