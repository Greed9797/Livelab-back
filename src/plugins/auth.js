import fp from 'fastify-plugin'
import jwt from '@fastify/jwt'
import { createHash } from 'node:crypto'
import * as Sentry from '@sentry/node'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Rotas que uma chave de API alcança. Tudo que não está aqui responde 403 para
// a chave, mesmo que o papel dela permitisse.
//
// A lista existe porque papel sozinho não segura: uma rota nova que use
// `app.authenticate` sem `requirePapel` nasceria aberta para a automação, e
// ninguém ia lembrar de conferir. Aqui o padrão é o contrário — nasce fechada.
//
// Não há DELETE nenhum, e de fora ficam usuários, financeiro, boletos,
// contratos e configurações (esta última guarda as chaves do gateway de
// pagamento).
const ROTAS_API_KEY = [
  ['POST', '/v1/analytics/imports'],
  ['GET', '/v1/analytics/'],
  ['GET', '/v1/lives'],
  ['POST', '/v1/lives'],
  ['PATCH', '/v1/lives/'],
  ['GET', '/v1/marcas'],
  ['POST', '/v1/marcas'],
  ['PATCH', '/v1/marcas/'],
  ['GET', '/v1/apresentadoras'],
  ['POST', '/v1/apresentadoras'],
  ['PATCH', '/v1/apresentadoras/'],
  ['GET', '/v1/comissoes'],
]

export function chaveAlcancaRota(metodo, caminho) {
  const limpo = String(caminho ?? '').split('?')[0]
  return ROTAS_API_KEY.some(([m, prefixo]) => m === metodo && limpo.startsWith(prefixo))
}

export const hashDaChave = (chave) => createHash('sha256').update(chave, 'utf8').digest('hex')

async function authPlugin(app) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET deve ter no mínimo 32 caracteres')
  }

  await app.register(jwt, {
    secret: process.env.JWT_SECRET,
    sign: {
      algorithm: 'HS256',
      // TTL 60min cobre modais longos (cadastrar usuário, agendar live com
      // múltiplos selects). Antes 15min causava 401 mid-mutation → redirect
      // loop /login. Refresh rotation continua válida (7 dias).
      expiresIn: process.env.JWT_EXPIRES_IN ?? '60m',
    },
    verify: {
      algorithms: ['HS256'],
    },
  })

  // Helper: valida que JWT.token_version está atualizado vs DB.
  // Se DB.token_version > JWT.token_version, o JWT foi invalidado por
  // /redefinir-senha ou /usuarios/:id/force-logout — retorna 401.
  //
  // Tolerante a falhas: se a query falhar (db down) ou o user não existir,
  // não bloqueia (cai pra comportamento atual). Se token_version não estiver
  // no payload (JWT antigo emitido antes do deploy), trata como version 1
  // (compatibilidade durante rollout — JWTs anteriores expiram em 15min).
  // Cache curto do token_version por usuário.
  //
  // Este SELECT roda em TODA request autenticada. Com a API longe do banco
  // (Railway us-west ↔ Supabase sa-east ≈ 180ms de RTT), ele sozinho somava
  // ~180ms a cada chamada de página. O TTL curto mantém a invalidação de sessão
  // (redefinir senha / force-logout) efetiva em poucos segundos.
  const TOKEN_VERSION_TTL_MS = Number(process.env.TOKEN_VERSION_CACHE_TTL_MS ?? 10_000)
  const tokenVersionCache = new Map() // userId -> { version, expiresAt }

  async function _getTokenVersion(userId, fallback) {
    const hit = tokenVersionCache.get(userId)
    if (hit && hit.expiresAt > Date.now()) return hit.version
    const { rows } = await app.db.query(
      `SELECT token_version FROM users WHERE id = $1`,
      [userId]
    )
    const version = rows[0]?.token_version ?? fallback
    tokenVersionCache.set(userId, { version, expiresAt: Date.now() + TOKEN_VERSION_TTL_MS })
    // Poda preguiçosa: evita crescer sem limite em tenants com muitos usuários.
    if (tokenVersionCache.size > 5000) {
      const now = Date.now()
      for (const [key, value] of tokenVersionCache) {
        if (value.expiresAt <= now) tokenVersionCache.delete(key)
      }
    }
    return version
  }

  // Invalida o cache na hora quando a sessão é derrubada de propósito.
  app.decorate('invalidateTokenVersionCache', (userId) => tokenVersionCache.delete(userId))

  async function _verifyTokenVersion(request, reply) {
    // Chave de API não tem sessão para expirar: quem a derruba é a revogação na
    // própria tabela, conferida a cada request. O `sub` dela nem é um UUID de
    // usuário, então o SELECT abaixo só geraria erro de cast.
    if (request.viaApiKey) return
    // Dedup por request: rotas que empilham [authenticate, requirePapel(...)]
    // chamariam este check 2× (1 SELECT token_version + 1 jwtVerify redundante
    // cada). Após a 1ª verificação bem-sucedida na request, marcamos a flag e
    // pulamos a 2ª — segurança idêntica (verifica exatamente 1× por request).
    if (request._tokenVersionChecked) return
    const userId = request.user?.sub
    if (!userId) return // sem sub: outros checks vão recusar
    const jwtVersion = Number.isInteger(request.user?.token_version)
      ? request.user.token_version
      : 1
    try {
      const dbVersion = await _getTokenVersion(userId, jwtVersion)
      if (dbVersion > jwtVersion) {
        return reply.code(401).send({ error: 'Sessão expirada' })
      }
    } catch (err) {
      app.log.warn({ err }, 'token_version check falhou — permitindo (fail-open)')
    }
    // Sucesso (ou fail-open): marca para que o 2º middleware da mesma request
    // não repita o SELECT. Em caso de 401 acima já retornamos — a request morre.
    request._tokenVersionChecked = true
  }

  // preHandler reutilizável: app.authenticate
  // Um token com assinatura válida mas SEM tenant_id chegava até o banco: as rotas
  // fazem `const { tenant_id } = request.user` e passam adiante, o set_config grava
  // string vazia no GUC e a primeira query com `::uuid` derruba o processo inteiro.
  // Ou seja: qualquer portador de um token assim tirava a API do ar. Barrar aqui é o
  // que transforma isso em 401 para um cliente em vez de apagão para todos.
  const tenantDoTokenEhValido = (request, reply) => {
    const tid = request.user?.tenant_id
    if (typeof tid === 'string' && UUID_RE.test(tid)) return true
    app.log.error(
      { user_id: request.user?.sub, papel: request.user?.papel, tenant_id: tid, rota: request.url },
      'token autenticado sem tenant_id válido — recusado antes de tocar no banco',
    )
    reply.code(401).send({ error: 'Token sem vínculo de unidade. Faça login novamente.' })
    return false
  }

  // Autenticação de máquina. Devolve `true` quando a request veio com chave e a
  // chave passou; `false` quando não veio chave nenhuma (segue o caminho do
  // JWT); e `reply` quando veio chave e ela foi recusada.
  //
  // A consulta usa `app.db` (pool de sistema, sem contexto de tenant) pelo mesmo
  // motivo do token_version logo acima: neste ponto ainda não se sabe qual é o
  // tenant — é a chave que diz.
  async function autenticarPorChave(request, reply) {
    const bruta = request.headers['x-api-key']
    if (typeof bruta !== 'string' || bruta.length === 0) return false

    const { rows } = await app.db.query(
      `SELECT id, tenant_id, papel, nome, revogada_em, expira_em
         FROM api_keys
        WHERE key_hash = $1`,
      [hashDaChave(bruta)],
    )
    const chave = rows[0]
    // Chave inexistente, revogada e vencida dão a mesma resposta de propósito:
    // quem está tentando adivinhar não aprende em qual dos três estados errou.
    if (!chave || chave.revogada_em || (chave.expira_em && new Date(chave.expira_em) <= new Date())) {
      app.log.warn({ rota: request.url }, 'chave de API inválida, revogada ou expirada')
      return reply.code(401).send({ error: 'Chave de API inválida' })
    }
    if (!chaveAlcancaRota(request.method, request.url)) {
      app.log.warn(
        { api_key_id: chave.id, metodo: request.method, rota: request.url },
        'chave de API tentou rota fora da allowlist',
      )
      return reply.code(403).send({ error: 'Esta chave não tem acesso a esta rota' })
    }

    request.user = { sub: `apikey:${chave.id}`, tenant_id: chave.tenant_id, papel: chave.papel }
    request.viaApiKey = chave
    // requirePapel, quando empilhado depois, pula o jwtVerify — não existe JWT
    // nesta request e tentar verificar um daria 401 numa chave válida.
    request._jwtVerified = true

    // Carimbo de uso, sem prender a resposta: serve para o Vitor ver na lista
    // qual chave ainda está viva. Falhar aqui não pode derrubar a request.
    app.db
      .query(`UPDATE api_keys SET ultimo_uso = NOW() WHERE id = $1`, [chave.id])
      .catch((err) => app.log.warn({ err }, 'não deu para carimbar ultimo_uso da chave'))

    return true
  }
  app.decorate('autenticarPorChave', autenticarPorChave)

  app.decorate('authenticate', async function (request, reply) {
    const porChave = await autenticarPorChave(request, reply)
    if (porChave !== false) return porChave === true ? undefined : porChave
    try {
      await request.jwtVerify()
    } catch (err) {
      app.log.warn({ msg: err.message, code: err.code }, 'JWT verification failed')
      return reply.code(401).send({ error: 'Token inválido ou expirado' })
    }
    if (!tenantDoTokenEhValido(request, reply)) return reply
    // Marca o JWT como já verificado nesta request — permite que requirePapel,
    // quando empilhado depois, pule o 2º jwtVerify redundante (segurança igual:
    // o token já foi validado por jwtVerify aqui).
    request._jwtVerified = true
    // Sentry breadcrumb — observabilidade sem PII (apenas user_id e papel)
    if (process.env.SENTRY_DSN) {
      try {
        Sentry.addBreadcrumb({
          category: 'auth',
          message: 'authenticated',
          level: 'info',
          data: { user_id: request.user?.sub, papel: request.user?.papel },
        })
      } catch {
        // breadcrumb nunca pode quebrar fluxo
      }
    }
    return _verifyTokenVersion(request, reply)
  })

  // preHandler: verifica papel específico
  app.decorate('requirePapel', (requiredPapeis) => async (request, reply) => {
    const papeis = Array.isArray(requiredPapeis) ? requiredPapeis : [requiredPapeis]

    // Várias rotas usam requirePapel sozinho, sem app.authenticate empilhado
    // antes. Sem isto, uma chave válida levaria 401 nelas — a request não tem
    // JWT nenhum para verificar.
    if (!request.viaApiKey) {
      const porChave = await autenticarPorChave(request, reply)
      if (porChave !== false && porChave !== true) return porChave
    }

    // S-04: SEMPRE valida JWT — nunca confia em request.user pré-existente
    // (evita bypass se outro plugin popular request.user antes). Exceção segura:
    // se app.authenticate JÁ rodou jwtVerify nesta MESMA request (flag setada por
    // nós, não pelo payload do JWT), o token já está provado — não revalidamos.
    if (!request._jwtVerified) {
      try {
        await request.jwtVerify()
      } catch {
        return reply.code(401).send({ error: 'Não autenticado' })
      }
      request._jwtVerified = true
    }

    // requirePapel é usado sozinho em várias rotas (ex.: /v1/home/dashboard), sem
    // app.authenticate empilhado antes — a checagem precisa existir nos dois caminhos.
    if (!tenantDoTokenEhValido(request, reply)) return reply

    if (!papeis.includes(request.user.papel)) {
      return reply.code(403).send({ error: 'Acesso não autorizado para este papel' })
    }

    return _verifyTokenVersion(request, reply)
  })

  // preHandler para rotas /v1/master/* compartilhadas entre franqueador_master
  // e gerente_regional. Injeta:
  //   request.isMaster: boolean       (true = franqueador_master)
  //   request.allowedTenantIds: string[]  (lista pra filtro SQL; vazia se
  //                                        gerente_regional sem acesso)
  //
  // Decisão: SEMPRE consulta o banco a cada request — nunca confia em claims
  // do JWT. Assim, revogar acesso tem efeito imediato (sem esperar exp do
  // token de 15min). Se virar gargalo, cachear em Redis com invalidação por
  // tenant_id, mas hoje 1 SELECT por request /v1/master/* é negligenciável.
  app.decorate('requireTenantAccess', async (request, reply) => {
    // jwtVerify já é assumido (rota usa também app.authenticate ou
    // requirePapel antes) — mas chamamos defensivamente.
    if (!request.user) {
      try {
        await request.jwtVerify()
      } catch {
        return reply.code(401).send({ error: 'Não autenticado' })
      }
    }

    const papel = request.user.papel
    if (papel === 'franqueador_master') {
      request.isMaster = true
      request.allowedTenantIds = null // null = sem restrição = vê tudo
      return
    }

    if (papel === 'gerente_regional') {
      try {
        const { rows } = await app.db.query(
          `SELECT tenant_id FROM user_tenant_access WHERE user_id = $1`,
          [request.user.sub ?? request.user.id]
        )
        request.isMaster = false
        request.allowedTenantIds = rows.map((r) => r.tenant_id)
        return
      } catch (err) {
        request.log.error({ err }, 'requireTenantAccess: falha consulta user_tenant_access')
        return reply.code(500).send({ error: 'Falha verificando permissões' })
      }
    }

    return reply.code(403).send({ error: 'Acesso não autorizado para este papel' })
  })
}

export default fp(authPlugin, { name: 'auth', dependencies: ['db'] })
export { authPlugin }
