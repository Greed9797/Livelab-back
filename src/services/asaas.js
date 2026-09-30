// Cliente HTTP Asaas — SOMENTE LEITURA (saldo, extrato, cobranças recebidas).
// Nunca cria/edita cobranças: só métodos GET são expostos.
//
// Suposições sobre a API pública do Asaas v3 (feitas de memória — VALIDAR com a chave real):
//   - Base URL produção: https://api.asaas.com/v3 ; sandbox: https://api-sandbox.asaas.com/v3
//     (chaves de sandbox começam com `$aact_hmlg_`; produção com `$aact_prod_` ou `$aact_` legado).
//     Pode ser forçada por env ASAAS_BASE_URL.
//   - Autenticação: header `access_token: <chave>`. Contas novas exigem header `User-Agent`.
//   - Listas paginadas por `offset` + `limit` (limit máx. 100) e resposta
//       { object: 'list', hasMore: bool, totalCount: n, limit, offset, data: [...] }
//   - Erros: HTTP 4xx com corpo { errors: [{ code, description }] }; 401 = chave inválida;
//     429 = rate limit.
//   - GET /finance/balance → { balance: number }
//   - GET /financialTransactions?startDate=YYYY-MM-DD&finishDate=YYYY-MM-DD&order=asc
//       itens: { object:'financialTransaction', id:'ft_…', value (com sinal), balance,
//                type:'PAYMENT_RECEIVED'|'PAYMENT_FEE'|'TRANSFER'|…, date:'YYYY-MM-DD',
//                description, paymentId?, transferId? }
//   - GET /payments?status=RECEIVED&paymentDate[ge]=…&paymentDate[le]=…
//       itens: { id:'pay_…', customer:'cus_…', value, netValue, status, billingType,
//                dueDate, paymentDate, clientPaymentDate, creditDate, description, externalReference }
//   - GET /payments/:id → um payment (mesmo formato acima)

import { decryptToken } from './token-crypto.js'

export const ASAAS_BASE_URL_PROD = 'https://api.asaas.com/v3'
export const ASAAS_BASE_URL_SANDBOX = 'https://api-sandbox.asaas.com/v3'
const LIMIT_MAX = 100
const USER_AGENT = 'LiveLab-Backend/1.0'

export class AsaasError extends Error {
  // codigo: SEM_CHAVE | CHAVE_INVALIDA | TIMEOUT | REDE | HTTP | RATE_LIMIT | RESPOSTA_INVALIDA | PAGINACAO_EXCEDIDA
  constructor(message, { codigo = 'HTTP', status = null, erros = null, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'AsaasError'
    this.codigo = codigo
    this.status = status
    this.erros = erros
  }
}

// A chave vem de tenants.gateway_api_key. Hoje /v1/configuracoes grava em texto
// claro; se no futuro passar a usar token-crypto (AES-GCM), decryptToken abre.
// Chaves Asaas começam com `$aact_` — nesse caso nem tentamos decriptar (evita
// exigir TOKEN_ENCRYPTION_KEY para chave legada em texto claro).
export function resolverChaveAsaas(armazenada) {
  if (armazenada == null) return null
  const s = String(armazenada).trim()
  if (!s) return null
  if (s.startsWith('$aact_')) return s
  try {
    return decryptToken(s)
  } catch {
    // TOKEN_ENCRYPTION_KEY ausente → trata como texto claro
    return s
  }
}

export function baseUrlParaChave(chave) {
  if (process.env.ASAAS_BASE_URL) return process.env.ASAAS_BASE_URL.replace(/\/+$/, '')
  return typeof chave === 'string' && chave.startsWith('$aact_hmlg_') ? ASAAS_BASE_URL_SANDBOX : ASAAS_BASE_URL_PROD
}

function montarQuery(query) {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue
    qs.append(k, String(v))
  }
  const s = qs.toString()
  return s ? `?${s}` : ''
}

function descreverErros(corpo) {
  const erros = Array.isArray(corpo?.errors) ? corpo.errors : null
  const desc = erros?.map((e) => e?.description || e?.code).filter(Boolean).join('; ')
  return { erros, desc: desc || null }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

export function criarClienteAsaas({
  apiKey,
  baseUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  tentativas = 2,          // 1 retry em 429/5xx/timeout (GET é idempotente)
  backoffMs = 500,
  maxPaginas = 50,         // 50 × 100 = 5.000 itens por listagem
} = {}) {
  if (!apiKey) throw new AsaasError('Chave Asaas não configurada para esta unidade', { codigo: 'SEM_CHAVE' })
  if (typeof fetchImpl !== 'function') throw new Error('fetch indisponível (Node >= 18 requerido)')
  const base = (baseUrl ?? baseUrlParaChave(apiKey)).replace(/\/+$/, '')

  async function umaRequisicao(url) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          access_token: apiKey,
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        signal: controller.signal,
      })
    } catch (err) {
      if (controller.signal.aborted || err?.name === 'AbortError') {
        throw new AsaasError(`Timeout de ${timeoutMs}ms ao consultar o Asaas`, { codigo: 'TIMEOUT', cause: err })
      }
      throw new AsaasError('Falha de rede ao consultar o Asaas', { codigo: 'REDE', cause: err })
    } finally {
      clearTimeout(timer)
    }

    let corpo = null
    const texto = await res.text().catch(() => '')
    if (texto) {
      try { corpo = JSON.parse(texto) } catch { corpo = null }
    }

    if (!res.ok) {
      const { erros, desc } = descreverErros(corpo)
      if (res.status === 401) {
        throw new AsaasError('Chave Asaas inválida ou sem permissão', { codigo: 'CHAVE_INVALIDA', status: 401, erros })
      }
      if (res.status === 429) {
        throw new AsaasError('Limite de requisições do Asaas atingido', { codigo: 'RATE_LIMIT', status: 429, erros })
      }
      throw new AsaasError(desc ? `Asaas: ${desc}` : `Asaas respondeu HTTP ${res.status}`, {
        codigo: 'HTTP', status: res.status, erros,
      })
    }
    if (corpo == null || typeof corpo !== 'object') {
      throw new AsaasError('Resposta inválida do Asaas (JSON esperado)', { codigo: 'RESPOSTA_INVALIDA', status: res.status })
    }
    return corpo
  }

  async function get(path, query) {
    const url = `${base}${path}${montarQuery(query)}`
    let ultimoErro
    for (let i = 0; i < Math.max(1, tentativas); i++) {
      try {
        return await umaRequisicao(url)
      } catch (err) {
        ultimoErro = err
        const retentavel = err instanceof AsaasError &&
          (err.codigo === 'TIMEOUT' || err.codigo === 'RATE_LIMIT' || err.codigo === 'REDE' ||
           (err.codigo === 'HTTP' && err.status >= 500))
        if (!retentavel || i === tentativas - 1) throw err
        await esperar(backoffMs * (i + 1))
      }
    }
    throw ultimoErro
  }

  // Percorre todas as páginas (offset/limit) até hasMore=false.
  async function listarTodos(path, query = {}) {
    const itens = []
    let offset = 0
    for (let pagina = 0; pagina < maxPaginas; pagina++) {
      const corpo = await get(path, { ...query, offset, limit: LIMIT_MAX })
      if (!Array.isArray(corpo.data)) {
        throw new AsaasError('Resposta de listagem do Asaas sem `data`', { codigo: 'RESPOSTA_INVALIDA' })
      }
      itens.push(...corpo.data)
      if (!corpo.hasMore || corpo.data.length === 0) return itens
      offset += corpo.data.length
    }
    throw new AsaasError(`Listagem ${path} excedeu ${maxPaginas} páginas — reduza o período`, {
      codigo: 'PAGINACAO_EXCEDIDA',
    })
  }

  return {
    baseUrl: base,
    get,
    listarTodos,

    async saldo() {
      const corpo = await get('/finance/balance')
      const saldo = Number(corpo.balance)
      if (!Number.isFinite(saldo)) {
        throw new AsaasError('Resposta de saldo sem `balance`', { codigo: 'RESPOSTA_INVALIDA' })
      }
      return { saldo }
    },

    extrato({ inicio, fim }) {
      return listarTodos('/financialTransactions', { startDate: inicio, finishDate: fim, order: 'asc' })
    },

    pagamentosRecebidos({ inicio, fim }) {
      return listarTodos('/payments', {
        status: 'RECEIVED',
        'paymentDate[ge]': inicio,
        'paymentDate[le]': fim,
      })
    },

    pagamento(id) {
      return get(`/payments/${encodeURIComponent(id)}`)
    },
  }
}

// Lê a chave do tenant e devolve o cliente. `db` já deve estar em withTenant.
export async function clienteAsaasDoTenant(db, tenantId, opts = {}) {
  const r = await db.query('SELECT gateway_api_key FROM tenants WHERE id = $1::uuid', [tenantId])
  const chave = resolverChaveAsaas(r.rows[0]?.gateway_api_key)
  if (!chave) throw new AsaasError('Chave Asaas não configurada para esta unidade', { codigo: 'SEM_CHAVE' })
  return criarClienteAsaas({ apiKey: chave, ...opts })
}

// Mapeia AsaasError → resposta HTTP da nossa API (mensagens pt-BR, sem vazar a chave).
export function statusHttpParaErroAsaas(err) {
  switch (err?.codigo) {
    case 'SEM_CHAVE': return 409
    case 'TIMEOUT': return 504
    case 'PAGINACAO_EXCEDIDA': return 422
    case 'RATE_LIMIT': return 503
    default: return 502 // CHAVE_INVALIDA, HTTP, REDE, RESPOSTA_INVALIDA
  }
}
