import fp from 'fastify-plugin'
import jwt from '@fastify/jwt'
import { createHash } from 'node:crypto'
import * as Sentry from '@sentry/node'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_BODY = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const MES_BODY = '[0-9]{4}-(?:0[1-9]|1[0-2])'

// Papéis de chave de API (coluna api_keys.papel). Cada um tem a SUA allowlist:
// a chave do bot de lives não alcança rota financeira nem pela lista, e a chave
// financeira não alcança lives/marcas/usuários. O papel (requirePapel) é a
// segunda trava, independente desta.
const PAPEL_AUTOMACAO = 'automacao'
const PAPEL_AUTOMACAO_FINANCEIRO = 'automacao_financeiro'

// Rotas que uma chave de API alcança. Tudo que não está aqui responde 403 para
// a chave, mesmo que o papel dela permitisse.
//
// A lista existe porque papel sozinho não segura: uma rota nova que use
// `app.authenticate` sem `requirePapel` nasceria aberta para a automação, e
// ninguém ia lembrar de conferir. Aqui o padrão é o contrário — nasce fechada.
//
// Esta é a lista do escopo 'operacional' (papel `automacao`, o bot de lives).
// Não há DELETE nenhum. Financeiro, contratos e configurações (esta última
// guarda as chaves do gateway de pagamento) ficam de fora — o financeiro tem
// chave própria, de outro escopo (ROTAS_API_KEY_FINANCEIRO, abaixo).
// De usuários, a chave só alcança os POST exatos /v1/usuarios e
// /v1/usuarios/convidar, e o POST exato /v1/apresentadoras. As três só criam
// apresentadora. Lista, PATCH, DELETE e reset de senha continuam fechados.
// Regra de casamento (GET incluso — sem prefixo solto):
// - Sem barra final e sem placeholder casa EXATO
// - PATCH com barra final casa só `<prefixo><uuid>` — nunca sub-rota (encerrar,
//   publicar, faixas-comissao, apresentadoras do vínculo)
// - Placeholders tipados ocupam um segmento inteiro e casam só o formato dele;
//   o resto do caminho casa exato (sem sub-rota, sem prefixo solto):
//     :id          uuid
//     :vid         uuid | calc:<uuid>:<AAAA-MM>:(fixo|comissao) | rec:<uuid>:<AAAA-MM>
//     :mes         AAAA-MM, mês 01–12
//     :componente  fixo | variavel
//   Placeholder desconhecido faz a entrada nunca casar (falha fechada).
export const ROTAS_API_KEY = [
  ['POST', '/v1/analytics/imports/preview'],
  ['POST', '/v1/analytics/imports/ingest'],
  ['GET', '/v1/analytics/imports'],
  ['GET', '/v1/analytics/imports/:id'],
  ['GET', '/v1/lives'],
  ['GET', '/v1/lives/:id'],
  ['POST', '/v1/lives'],
  ['POST', '/v1/lives/manual'],
  // Status operacional (em_andamento | encerrada | cancelada) muda neste PATCH,
  // o mesmo campo do gestor. Casa só /v1/lives/<uuid> — encerrar e arquivar
  // não entram. Publicar é a entrada exata abaixo, a mesma ação do gestor.
  ['PATCH', '/v1/lives/'],
  ['PATCH', '/v1/lives/:id/publicar'],
  ['GET', '/v1/marcas'],
  ['GET', '/v1/marcas/:id'],
  ['GET', '/v1/marcas/:id/condicoes'],
  ['POST', '/v1/marcas'],
  ['PATCH', '/v1/marcas/'],
  ['POST', '/v1/marcas/:id/condicoes/preview'],
  ['POST', '/v1/marcas/:id/condicoes'],
  // Cadastro unificado (marca + ficha): só leitura para a chave. A ficha
  // (contato/faturamento) volta nula para a chave — ver services/cadastros.js.
  ['GET', '/v1/cadastros'],
  ['GET', '/v1/cadastros/:id'],
  ['GET', '/v1/apresentadoras'],
  ['PATCH', '/v1/apresentadoras/'],
  // Cadastro da apresentadora. Casa EXATO estes POST. Sem barra final:
  // /usuarios/extra, /apresentadoras/<uuid> e faixas não entram. Lista,
  // PATCH, DELETE e reset de senha ficam de fora.
  ['POST', '/v1/apresentadoras'],
  ['POST', '/v1/usuarios'],
  ['POST', '/v1/usuarios/convidar'],
  ['GET', '/v1/comissoes/resumo'],
  ['GET', '/v1/comissoes/apresentadoras'],
  ['GET', '/v1/comissoes/marcas'],
]

// Escopo 'financeiro' (papel `automacao_financeiro`): ler lançamentos e
// registrar/baixar custos e receitas. Mesmas regras de casamento.
//
// De fora, de propósito:
// - DELETE de qualquer coisa: apagar lançamento some com a trilha do dinheiro.
//   A automação corrige com PATCH ou desfaz a baixa; apagar é de gente.
// - /v1/financeiro/config: saldo de abertura, data de corte e alíquota de
//   imposto mudam o caixa e o DRE de todos os meses de uma vez.
// - /v1/financeiro/apresentadoras-pagamentos/config (vencimento das
//   apresentadoras) e as rotas legadas sem :componente.
// - /v1/asaas/*: gateway de pagamento e conciliação bancária.
// - /v1/financeiro/operacional, /faturamento e a visão franqueadora.
// - /v1/api-keys*, contratos, configurações, usuários, lives, marcas.
export const ROTAS_API_KEY_FINANCEIRO = [
  // Leitura
  ['GET', '/v1/financeiro/lancamentos'],
  ['GET', '/v1/financeiro/caixa'],
  ['GET', '/v1/financeiro/receita'],
  ['GET', '/v1/financeiro/dre/mes'],
  ['GET', '/v1/financeiro/painel'],
  ['GET', '/v1/financeiro/resumo'],
  ['GET', '/v1/financeiro/fluxo-caixa'],
  ['GET', '/v1/financeiro/receitas'],
  ['GET', '/v1/financeiro/receitas-avulsas'],
  ['GET', '/v1/financeiro/custos'],
  ['GET', '/v1/financeiro/custos-recorrentes'],
  ['GET', '/v1/financeiro/apresentadoras-pagamentos'],
  // Criação
  ['POST', '/v1/financeiro/custos'],
  ['POST', '/v1/financeiro/custos/parcelado'],
  ['POST', '/v1/financeiro/custos/gerar'],
  ['POST', '/v1/financeiro/custos/importar'],
  ['POST', '/v1/financeiro/custos-recorrentes'],
  ['POST', '/v1/financeiro/receitas/gerar'],
  ['POST', '/v1/financeiro/receitas-avulsas'],
  // Edição e baixa (pagar/receber/desfazer)
  ['PATCH', '/v1/financeiro/custos/:vid'],
  ['PATCH', '/v1/financeiro/custos/:vid/pagar'],
  ['PATCH', '/v1/financeiro/custos/:vid/desfazer'],
  ['PATCH', '/v1/financeiro/custos-recorrentes/:id'],
  ['PATCH', '/v1/financeiro/receitas/:vid/receber'],
  ['PATCH', '/v1/financeiro/receitas/:vid/desfazer'],
  ['PATCH', '/v1/financeiro/receitas-avulsas/:id'],
  ['PATCH', '/v1/financeiro/receitas-avulsas/:id/receber'],
  ['PATCH', '/v1/financeiro/receitas-avulsas/:id/desfazer'],
  ['PATCH', '/v1/financeiro/apresentadoras-pagamentos/:id/:mes/:componente/pagar'],
  ['PATCH', '/v1/financeiro/apresentadoras-pagamentos/:id/:mes/:componente/desfazer'],
  ['PATCH', '/v1/financeiro/impostos/:mes/pagar'],
  ['PATCH', '/v1/financeiro/impostos/:mes/desfazer'],
]

// Papel da chave → allowlist. Papel fora daqui (linha mexida à mão no banco,
// papel de gente) não alcança rota nenhuma.
export const ROTAS_API_KEY_POR_PAPEL = Object.freeze({
  [PAPEL_AUTOMACAO]: ROTAS_API_KEY,
  [PAPEL_AUTOMACAO_FINANCEIRO]: ROTAS_API_KEY_FINANCEIRO,
})

const PLACEHOLDERS = Object.freeze({
  id: UUID_BODY,
  vid: `(?:${UUID_BODY}|calc:${UUID_BODY}:${MES_BODY}:(?:fixo|comissao)|rec:${UUID_BODY}:${MES_BODY})`,
  mes: MES_BODY,
  componente: '(?:fixo|variavel)',
})

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const rotasCompiladas = new Map()

/** Padrão com placeholders → RegExp ancorada; null se o padrão for inválido. */
function compilarRota(rota) {
  if (rotasCompiladas.has(rota)) return rotasCompiladas.get(rota)
  let fonte = '^'
  let ultimo = 0
  let valido = true
  for (const m of rota.matchAll(/:([A-Za-z_]+)/g)) {
    const tipo = Object.hasOwn(PLACEHOLDERS, m[1]) ? PLACEHOLDERS[m[1]] : null
    const antes = rota[m.index - 1]
    const depois = rota[m.index + m[0].length]
    // O placeholder ocupa o segmento inteiro: `/x/:id/y`, nunca `/x-:id`.
    if (!tipo || antes !== '/' || (depois !== undefined && depois !== '/')) { valido = false; break }
    fonte += escapeRegex(rota.slice(ultimo, m.index)) + tipo
    ultimo = m.index + m[0].length
  }
  const re = valido ? new RegExp(`${fonte}${escapeRegex(rota.slice(ultimo))}$`) : null
  rotasCompiladas.set(rota, re)
  return re
}

/**
 * A chave de papel `papel` alcança `metodo caminho`? Sem papel, vale a lista do
 * escopo operacional (o comportamento de antes da chave financeira).
 */
export function chaveAlcancaRota(metodo, caminho, papel = PAPEL_AUTOMACAO) {
  const rotas = Object.hasOwn(ROTAS_API_KEY_POR_PAPEL, papel) ? ROTAS_API_KEY_POR_PAPEL[papel] : []
  // `:` codificado (`calc%3A...`) chega decodificado ao handler; aqui também,
  // senão o id virtual levaria 403. Só o `:` — nenhum outro escape é desfeito,
  // então `%2F` e afins continuam não casando com nada.
  const limpo = String(caminho ?? '').split('?')[0].replace(/%3a/gi, ':')
  return rotas.some(([m, rota]) => {
    if (m !== metodo) return false
    if (rota.includes(':')) {
      const re = compilarRota(rota)
      return re ? re.test(limpo) : false
    }
    if (!rota.endsWith('/')) return limpo === rota
    return limpo.startsWith(rota) && UUID_RE.test(limpo.slice(rota.length))
  })
}

export const hashDaChave = (chave) => createHash('sha256').update(chave, 'utf8').digest('hex')

// Origem do registro que a rota vai gravar. Quem chama decide, não o body:
// veio por chave de API, é 'bot' — mesmo que o payload diga 'manual'. Sem
// chave, vale o que a rota já fazia (o valor do body ou 'manual').
export function origemDados(request, doBody = 'manual') {
  return request?.viaApiKey ? 'bot' : (doBody ?? 'manual')
}

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
  // Falha fechada: usuário ausente/inativo não autentica; indisponibilidade
  // da verificação devolve 503 sem executar a operação. Se token_version não estiver
  // no payload (JWT antigo emitido antes do deploy), trata como version 1
  // (compatibilidade durante rollout — JWTs anteriores expiram em 15min).
  // Cache curto do token_version por usuário.
  //
  // Este SELECT roda em TODA request autenticada. Com a API longe do banco
  // (Railway us-west ↔ Supabase sa-east ≈ 180ms de RTT), ele sozinho somava
  // ~180ms a cada chamada de página. O TTL curto mantém a invalidação de sessão
  // (redefinir senha / force-logout) efetiva em poucos segundos.
  const TOKEN_VERSION_TTL_MS = Number(process.env.TOKEN_VERSION_CACHE_TTL_MS ?? 10_000)
  const tokenVersionCache = new Map() // userId -> { state, expiresAt }

  async function _getTokenVersion(userId) {
    const hit = tokenVersionCache.get(userId)
    if (hit && hit.expiresAt > Date.now()) return hit.state
    const { rows } = await app.db.query(
      `SELECT token_version, ativo, papel, tenant_id FROM users WHERE id = $1`,
      [userId]
    )
    const state = rows[0] ?? null
    tokenVersionCache.set(userId, { state, expiresAt: Date.now() + TOKEN_VERSION_TTL_MS })
    // Poda preguiçosa: evita crescer sem limite em tenants com muitos usuários.
    if (tokenVersionCache.size > 5000) {
      const now = Date.now()
      for (const [key, value] of tokenVersionCache) {
        if (value.expiresAt <= now) tokenVersionCache.delete(key)
      }
    }
    return state
  }

  // Invalida o cache na hora quando a sessão é derrubada de propósito.
  app.decorate('invalidateTokenVersionCache', (userId) => tokenVersionCache.delete(userId))

  async function _verifyTokenVersion(request, reply) {
  // Chave de API não tem sessão para expirar: quem a derruba é a revogação na
  // própria tabela, conferida a cada request. `sub` pode ser o criador da chave
  // (ou null); token_version desse usuário não invalida a chave.
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
      const state = await _getTokenVersion(userId)
      if (!state || state.ativo !== true || state.papel !== request.user.papel || state.tenant_id !== request.user.tenant_id || Number(state.token_version ?? 1) > jwtVersion) {
        return reply.code(401).send({ error: 'Sessão expirada' })
      }
    } catch (err) {
      app.log.warn({ code: err?.code }, 'Verificação de sessão indisponível')
      return reply.code(503).send({ error: 'Não foi possível validar sua sessão. Tente novamente.' })
    }
    // Sucesso: marca para que o 2º middleware da mesma request
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
      `SELECT id, tenant_id, papel, nome, criado_por, revogada_em, expira_em
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
    // `?? null`: papel ausente não pode cair no default do escopo operacional.
    if (!chaveAlcancaRota(request.method, request.url, chave.papel ?? null)) {
      app.log.warn(
        { api_key_id: chave.id, papel: chave.papel, metodo: request.method, rota: request.url },
        'chave de API tentou rota fora da allowlist',
      )
      return reply.code(403).send({ error: 'Esta chave não tem acesso a esta rota' })
    }

    // `sub` entra em colunas UUID com FK para users (alterado_por, criado_por): tem
    // de ser um usuário real ou NULL. A chave em si fica em viaApiKey para auditoria.
    request.user = { sub: chave.criado_por ?? null, tenant_id: chave.tenant_id, papel: chave.papel }
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
