import { describe, expect, it } from 'vitest'

import { chaveDeRateLimit } from '../src/lib/rate-limit-key.js'

const req = ({ headers = {}, ip = '203.0.113.7' } = {}) => ({ headers, ip })

const jwtCom = (sub) => {
  const payload = Buffer.from(JSON.stringify({ sub }), 'utf8').toString('base64url')
  return `Bearer cabecalho.${payload}.assinatura`
}

describe('chave do rate limit', () => {
  it('dá balde próprio a cada chave de API', () => {
    const umBot = chaveDeRateLimit(req({ headers: { 'x-api-key': 'llk_bot-a' } }))
    const outroBot = chaveDeRateLimit(req({ headers: { 'x-api-key': 'llk_bot-b' } }))

    expect(umBot).toMatch(/^k:/)
    // O ponto: um bot em loop não pode consumir a cota do outro.
    expect(umBot).not.toBe(outroBot)
    // Nem a cota de quem sai pelo mesmo IP.
    expect(umBot).not.toBe(chaveDeRateLimit(req()))
  })

  it('não usa a chave crua como rótulo do balde', () => {
    const chave = chaveDeRateLimit(req({ headers: { 'x-api-key': 'llk_segredo-do-bot' } }))
    expect(chave).not.toContain('llk_segredo-do-bot')
  })

  it('mesma chave cai sempre no mesmo balde', () => {
    const a = chaveDeRateLimit(req({ headers: { 'x-api-key': 'llk_bot-a' }, ip: '1.1.1.1' }))
    const b = chaveDeRateLimit(req({ headers: { 'x-api-key': 'llk_bot-a' }, ip: '2.2.2.2' }))
    // O IP não entra na conta: a cota acompanha a chave, não a origem.
    expect(a).toBe(b)
  })

  it('separa usuários logados pelo sub do token', () => {
    const ana = chaveDeRateLimit(req({ headers: { authorization: jwtCom('ana') } }))
    const wagner = chaveDeRateLimit(req({ headers: { authorization: jwtCom('wagner') } }))

    expect(ana).toBe('u:ana')
    expect(wagner).toBe('u:wagner')
    // Escritório atrás de NAT: mesmo IP, cotas separadas.
    expect(ana).not.toBe(wagner)
  })

  it('cai no IP quando não há chave nem token utilizável', () => {
    expect(chaveDeRateLimit(req())).toBe('ip:203.0.113.7')
    // Token quebrado não pode virar exceção: vale como anônimo.
    expect(chaveDeRateLimit(req({ headers: { authorization: 'Bearer nao-e-um-jwt' } })))
      .toBe('ip:203.0.113.7')
    expect(chaveDeRateLimit(req({ headers: { 'x-api-key': '' } }))).toBe('ip:203.0.113.7')
  })

  it('a chave de API tem precedência sobre o token na mesma request', () => {
    const chave = chaveDeRateLimit(req({
      headers: { 'x-api-key': 'llk_bot-a', authorization: jwtCom('ana') },
    }))
    expect(chave).toMatch(/^k:/)
  })
})
