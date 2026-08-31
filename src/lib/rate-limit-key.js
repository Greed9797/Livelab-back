import { createHash } from 'node:crypto'

/**
 * Quem divide cota com quem, no rate limit global.
 *
 * Mora aqui fora, e não inline no registro do plugin, porque errar a chave não
 * derruba nada de imediato — só junta no mesmo balde gente que deveria estar
 * separada, e isso aparece como "o sistema trava quando várias pessoas mexem",
 * bem longe da causa. Fora do app.js dá para exercitar os três caminhos.
 *
 * Nenhum dos valores é verificado: a chave só reparte cota. Quem forjar um
 * `sub` ou mandar uma chave inválida ganha um balde próprio e nada mais — a
 * autenticação de verdade acontece no preHandler e recusa do mesmo jeito.
 */
export function chaveDeRateLimit(request) {
  // Automação primeiro: sem isto ela cairia no IP e disputaria a cota com todo
  // mundo que sai pelo mesmo endereço.
  const apiKey = request.headers?.['x-api-key']
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    // Hash, e não a chave: o valor vira rótulo de balde em memória e chega a
    // logs de diagnóstico do plugin.
    return `k:${createHash('sha256').update(apiKey, 'utf8').digest('hex').slice(0, 32)}`
  }

  const auth = request.headers?.authorization
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    try {
      const payload = JSON.parse(
        Buffer.from(auth.slice(7).split('.')[1], 'base64url').toString('utf8'),
      )
      if (typeof payload?.sub === 'string' && payload.sub.length > 0) return `u:${payload.sub}`
    } catch {
      // token malformado: cai no IP, como qualquer anônimo
    }
  }

  return `ip:${request.ip}`
}
