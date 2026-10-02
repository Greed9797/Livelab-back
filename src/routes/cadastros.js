// Cadastro unificado — /v1/cadastros. A marca é a entidade (id = marca_id); a ficha
// em `clientes` é o complemento comercial da marca tipo='cliente'. As rotas antigas
// /v1/clientes e /v1/marcas continuam respondendo o mesmo formato.
// Contrato: docs/api-automacao.md ("Cadastros") e src/lib/cadastro-sql.js.
import { performance } from 'node:perf_hooks'
import { READ_MARCAS, WRITE_CLIENTES } from '../config/role_groups.js'
import { origemDados } from '../plugins/auth.js'
import { buildCacheKey, invalidateTenant, setCacheControl, withCache } from '../lib/dashboard-cache.js'
import { LISTAGEM_NAMESPACES } from './marcas.js'
import {
  CadastroError,
  atualizarCadastro,
  criarCadastro,
  listarCadastros,
  obterCadastro,
  promoverACliente,
} from '../services/cadastros.js'

const CADASTROS_CACHE_TTL_MS = Number(process.env.CADASTROS_CACHE_TTL_MS ?? 300_000)

function parseBool(value) {
  if (value === undefined || value === null || value === '') return null
  const v = String(value).toLowerCase()
  if (v === 'true' || v === '1') return true
  if (v === 'false' || v === '0') return false
  return null
}

function responderErro(reply, error) {
  if (error instanceof CadastroError) {
    const { statusCode, code, message, ...extra } = error
    const body = { code, error: message }
    for (const [k, v] of Object.entries(extra)) {
      if (k !== 'stack' && v !== undefined) body[k] = v
    }
    return reply.code(statusCode).send(body)
  }
  throw error
}

export async function cadastrosRoutes(app) {
  // Leitura: quem lê marcas (inclui a chave de API do bot, que só alcança os GET —
  // ver ROTAS_API_KEY em src/plugins/auth.js). Escrita: quem escreve clientes.
  const readAccess = [app.authenticate, app.requirePapel(READ_MARCAS)]
  const writeAccess = [app.authenticate, app.requirePapel(WRITE_CLIENTES)]

  app.get('/v1/cadastros', { preHandler: readAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    const { tipo, status, q } = request.query ?? {}
    const geraReceita = parseBool(request.query?.gera_receita)
    const incluirSistema = parseBool(request.query?.sistema) !== false
    const ocultarFicha = Boolean(request.viaApiKey)
    const startedAt = performance.now()
    const { value, state } = await withCache({
      namespace: 'cadastros:list',
      key: buildCacheKey(tenant_id, { tipo, status, q, geraReceita, incluirSistema, ocultarFicha }),
      ttlMs: CADASTROS_CACHE_TTL_MS,
      computeFn: () => app.withTenant(tenant_id, (db) => listarCadastros(db, {
        tenantId: tenant_id, tipo, status, q, geraReceita, incluirSistema, ocultarFicha,
      })),
    })
    setCacheControl(reply, state, startedAt)
    return value
  })

  app.get('/v1/cadastros/:id', { preHandler: readAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const cadastro = await obterCadastro(db, {
        tenantId: tenant_id, id: request.params.id, ocultarFicha: Boolean(request.viaApiKey),
      })
      if (!cadastro) return reply.code(404).send({ code: 'CADASTRO_NAO_ENCONTRADO', error: 'Cadastro não encontrado' })
      return cadastro
    })
  })

  app.post('/v1/cadastros', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      try {
        const cadastro = await criarCadastro(db, { tenantId: tenant_id, dados: request.body, origem: origemDados(request) })
        invalidateTenant(tenant_id, LISTAGEM_NAMESPACES)
        app.audit?.log?.(request, {
          action: 'cadastro.create', entity_type: 'marca', entity_id: cadastro?.marca_id,
          metadata: { tipo: cadastro?.tipo, cliente_id: cadastro?.cliente_id ?? null },
        })?.catch?.((err) => app.log.error({ err }, 'audit log failed'))
        return reply.code(201).send(cadastro)
      } catch (error) {
        return responderErro(reply, error)
      }
    })
  })

  app.patch('/v1/cadastros/:id', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      try {
        const cadastro = await atualizarCadastro(db, { tenantId: tenant_id, id: request.params.id, dados: request.body })
        invalidateTenant(tenant_id, LISTAGEM_NAMESPACES)
        app.audit?.log?.(request, {
          action: 'cadastro.update', entity_type: 'marca', entity_id: cadastro?.marca_id,
          metadata: { changed_fields: Object.keys(request.body ?? {}) },
        })?.catch?.((err) => app.log.error({ err }, 'audit log failed'))
        return cadastro
      } catch (error) {
        return responderErro(reply, error)
      }
    })
  })

  app.post('/v1/cadastros/:id/promover-cliente', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      try {
        const r = await promoverACliente(db, { tenantId: tenant_id, id: request.params.id, dados: request.body })
        invalidateTenant(tenant_id, LISTAGEM_NAMESPACES)
        app.audit?.log?.(request, {
          action: 'cadastro.promover_cliente', entity_type: 'marca', entity_id: r.cadastro?.marca_id,
          metadata: {
            cliente_id: r.clienteId, tipo_anterior: r.tipoAnterior,
            data_inicio: r.dataInicio, retroativo_confirmado: r.retroativo,
          },
        })?.catch?.((err) => app.log.error({ err }, 'audit log failed'))
        return reply.code(200).send(r.cadastro)
      } catch (error) {
        return responderErro(reply, error)
      }
    })
  })
}
