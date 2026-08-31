import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Estes jobs rodam em cron: quando o SQL não bate com o schema, a falha some no log e
// ninguém percebe. Foi o que aconteceu com o agenda_autostart — ele nunca conseguiu
// abrir uma live (0 registros criados) por três motivos ao mesmo tempo.
const autostart = readFileSync(new URL('../src/jobs/agenda_autostart.js', import.meta.url), 'utf8')
const zumbi = readFileSync(new URL('../src/jobs/encerrar_lives_zumbi.js', import.meta.url), 'utf8')

/** Só o VALUES do INSERT em lives — comentários ao redor não contam. */
function valuesDoInsertEmLives(src) {
  const bloco = src.match(/INSERT INTO lives[\s\S]*?VALUES \(([\s\S]*?)\)\s*\n\s*RETURNING/)
  return bloco?.[1] ?? ''
}

describe('contrato SQL dos jobs de cron', () => {
  const values = valuesDoInsertEmLives(autostart)

  it('extrai o VALUES do insert (guarda do próprio teste)', () => {
    expect(values).not.toBe('')
  })

  // CHECK ((tipo = ANY (ARRAY['cliente','afiliado','teste'])))
  it('agenda_autostart inserts a valid lives.tipo', () => {
    expect(values).not.toContain("'live'")
    expect(values).toContain("'cliente'")
  })

  // CHECK ((origem_dados = ANY (ARRAY['manual','api'])))
  it('agenda_autostart inserts a valid lives.origem_dados', () => {
    expect(values).not.toContain("'auto_agenda'")
    expect(values).toContain("'api'")
  })

  // audit_log tem user_id; actor_user_id pertence a cabine_eventos/contrato_eventos.
  it('cron jobs write audit_log with the column that exists', () => {
    for (const [nome, src] of [['agenda_autostart', autostart], ['encerrar_lives_zumbi', zumbi]]) {
      const insert = src.match(/INSERT INTO audit_log \(([^)]*)\)/)
      expect(insert, `${nome} deveria inserir em audit_log`).toBeTruthy()
      expect(insert[1], nome).not.toContain('actor_user_id')
      expect(insert[1], nome).toContain('user_id')
    }
  })
})

// O errorResponseBuilder do rate limit precisa carregar o statusCode: sem ele o
// errorHandler global cai no `?? 500` e o cliente recebe 500 no lugar de 429 —
// o front trata como "servidor quebrou" e derruba a tela em vez de esperar.
describe('contrato do rate limit', () => {
  const appSrc = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')
  const bloco = appSrc.match(/register\(rateLimit, \{([\s\S]*?)\n  \}\)/)?.[1] ?? ''

  it('extrai o bloco de configuração (guarda do próprio teste)', () => {
    expect(bloco).not.toBe('')
  })

  it('responds 429 on excess, not 500', () => {
    expect(bloco).toContain('statusCode: 429')
  })

  it('keys the limit by user when authenticated, so NAT does not share one quota', () => {
    // Este teste checava `request.user?.sub` no fonte — e assim congelou justamente o bug:
    // o rate-limit roda no hook onRequest, ANTES do preHandler que verifica o JWT, então
    // `request.user` é sempre undefined e a chave caía sempre no IP. Um escritório atrás de
    // NAT dividia 300 req/min entre todos.
    //
    // A chave agora sai do payload do próprio header. O comportamento de verdade (usuários
    // distintos no mesmo IP não dividem cota) está coberto em test/rate_limit_por_usuario.js,
    // com requests reais — aqui fica só a guarda contra alguém voltar ao request.user.
    //
    // A função saiu do app.js para src/lib/rate-limit-key.js, onde dá para
    // exercitá-la — o comportamento (usuários e chaves de API não dividem cota)
    // está em test/rate_limit_por_usuario.test.js e test/rate_limit_key.test.js,
    // com requests reais. Aqui fica só a guarda contra alguém voltar a montar a
    // chave a partir de request.user, que no onRequest é sempre undefined.
    expect(bloco).not.toMatch(/keyGenerator:[\s\S]*request\.user\?\.sub/)
    expect(bloco).toMatch(/keyGenerator: chaveDeRateLimit/)
  })
})
