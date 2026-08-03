import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { esperarDesconexao } from '../src/lib/sse.js'
import { notify } from '../src/services/mailer.js'
import { runBillingTick } from '../src/jobs/billing_engine.js'

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

describe('billing engine — um tenant quebrado não pode parar o faturamento', () => {
  // Quatro defeitos moravam neste callback. O pior: connect() fora do try deixava
  // _billingRunning=true para sempre e o faturamento morria em silêncio até o próximo
  // deploy. Nenhuma correção aqui introduz retry — repetir faturamento é repetir cobrança.
  const fakePool = ({ tenants, falhaNoConnect = false, quebrarUnlock = false }) => {
    const client = {
      query: vi.fn(async (sql) => {
        if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] }
        if (/pg_advisory_unlock/.test(sql)) {
          if (quebrarUnlock) throw new Error('unlock falhou')
          return { rows: [{}] }
        }
        return { rows: [] }
      }),
      release: vi.fn(),
    }
    return {
      client,
      connect: async () => {
        if (falhaNoConnect) throw new Error('EMAXCONNSESSION: max clients reached')
        return client
      },
      query: async (sql) => (/FROM tenants/.test(sql) ? { rows: tenants } : { rows: [] }),
    }
  }

  it('conexão indisponível propaga o erro em vez de travar a flag', async () => {
    const pool = fakePool({ tenants: [], falhaNoConnect: true })
    // O que importa é o callback do cron ter um finally que reseta _billingRunning.
    // Aqui provamos que a falha SAI (antes ela sumia junto com a flag presa).
    await expect(runBillingTick(pool, { hoje: new Date('2026-08-01T05:00:00Z') }))
      .rejects.toThrow(/EMAXCONNSESSION/)
  })

  it('unlock que falha devolve a conexão COM erro, para o pg destruí-la', async () => {
    // Sem isso a conexão volta ao pool ainda segurando o advisory lock; com
    // idleTimeout de 10min ela sobrevive e o faturamento nunca mais roda.
    const pool = fakePool({ tenants: [], quebrarUnlock: true })
    await runBillingTick(pool, { hoje: new Date('2026-08-01T05:00:00Z') })
    expect(pool.client.release).toHaveBeenCalledTimes(1)
    expect(pool.client.release.mock.calls[0][0]).toBeInstanceOf(Error)
  })

  it('fora do dia 1 ou 16 não fatura ninguém', async () => {
    const pool = fakePool({ tenants: [{ id: 'a' }, { id: 'b' }] })
    const r = await runBillingTick(pool, { hoje: new Date('2026-08-07T05:00:00Z') })
    expect(r).toMatchObject({ rodou: false, total: 0 })
  })
})
