// Service Appmax — gateway de pagamento (substituiu Asaas 100%).
// Doc: https://appmax.readme.io/reference/conceitos-de-negocio
//
// Env vars necessárias:
//   APPMAX_APP_ID         — UUID do aplicativo (ex: 270e7c2d-...)
//   APPMAX_API_KEY        — chave secreta gerada no painel Appmax
//   APPMAX_WEBHOOK_SECRET — opcional, valida assinatura de eventos
//   APPMAX_BASE_URL       — default https://admin.appmax.com.br/api/v3
//
// Compat: exporta `buscarOuCriarCustomer`, `gerarIdempotencyKey`, `criarCobranca`,
// `validarWebhookToken` com signatures equivalentes ao antigo asaas.js — billing
// engine e webhook handler usam essas exports sem mudança de chamada.

import crypto from 'node:crypto'

const APPMAX_BASE = process.env.APPMAX_BASE_URL ?? 'https://admin.appmax.com.br/api/v3'

function _appId() {
  const id = process.env.APPMAX_APP_ID
  if (!id) throw new Error('APPMAX_APP_ID não configurado')
  return id
}

function _apiKey() {
  const k = process.env.APPMAX_API_KEY
  if (!k) throw new Error('APPMAX_API_KEY não configurada')
  return k
}

async function _request(path, { method = 'POST', body } = {}) {
  const res = await fetch(`${APPMAX_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body ? JSON.stringify({ 'access-token': _apiKey(), ...body }) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.success === false) {
    throw new Error(`Appmax ${path} falhou: ${res.status} ${JSON.stringify(data?.text ?? data)}`)
  }
  return data
}

/**
 * Cria/atualiza customer no Appmax.
 * @param {{firstname:string, lastname?:string, email:string, telephone?:string,
 *          ip?:string, postcode?:string, address_street?:string,
 *          address_street_number?:string, address_city?:string, address_state?:string}} c
 */
export async function upsertCustomer(c) {
  const body = {
    'firstname': c.firstname,
    'lastname': c.lastname ?? '',
    'email': c.email,
    'telephone': c.telephone ?? '',
    'ip': c.ip ?? '',
    'postcode': c.postcode ?? '',
    'address_street': c.address_street ?? '',
    'address_street_number': c.address_street_number ?? '',
    'address_city': c.address_city ?? '',
    'address_state': c.address_state ?? '',
  }
  const res = await _request('/customer', { body })
  return res?.data
}

/**
 * Cria pedido (order) no Appmax. Necessário antes de gerar cobrança.
 * @param {{customer_id:number, products:Array, total:number}} order
 */
export async function createOrder(order) {
  const body = {
    'customer_id': order.customer_id,
    'products': order.products,
    'total': order.total,
  }
  const res = await _request('/order', { body })
  return res?.data
}

/**
 * Gera cobrança PIX. Retorna QR code + copia-e-cola.
 */
export async function chargePix({ orderId, customerId, expirationDate }) {
  const body = {
    'cart': { 'order_id': orderId },
    'customer': { 'customer_id': customerId },
    'payment': {
      'pix': {
        'document_number': '',
        'expiration_date': expirationDate, // ISO date
      },
    },
  }
  const res = await _request('/payment/pix', { body })
  return res?.data
}

/**
 * Gera boleto bancário.
 */
export async function chargeBoleto({ orderId, customerId, dueDate }) {
  const body = {
    'cart': { 'order_id': orderId },
    'customer': { 'customer_id': customerId },
    'payment': {
      'boleto': {
        'document_number': '',
        'due_date': dueDate, // YYYY-MM-DD
      },
    },
  }
  const res = await _request('/payment/boleto', { body })
  return res?.data
}

/**
 * Cobrança no cartão de crédito.
 */
export async function chargeCard({ orderId, customerId, card, installments = 1 }) {
  const body = {
    'cart': { 'order_id': orderId },
    'customer': { 'customer_id': customerId },
    'payment': {
      'CreditCard': {
        'number': card.number,
        'cvv': card.cvv,
        'month': card.month,
        'year': card.year,
        'name': card.name,
        'document_number': card.document_number,
        'installments': installments,
        'soft_descriptor': 'LIVELAB',
      },
    },
  }
  const res = await _request('/payment/credit-card', { body })
  return res?.data
}

// ────────────────── Compat layer (signatures asaas.js) ──────────────────

/**
 * Compat: cria/recupera customer e retorna ID.
 * Mesma signature que asaas.buscarOuCriarCustomer.
 */
export async function buscarOuCriarCustomer({ nome, cpfCnpj, email, celular }) {
  const [firstname, ...rest] = (nome ?? '').split(' ')
  const cust = await upsertCustomer({
    firstname: firstname ?? '',
    lastname: rest.join(' '),
    email: email ?? '',
    telephone: celular?.replace(/\D/g, '') ?? '',
  })
  return cust?.id ?? cust?.customer_id
}

/**
 * Compat: chave determinística pra impedir cobrança duplicada.
 */
export function gerarIdempotencyKey(tenantId, liveId, tipo) {
  return crypto
    .createHash('sha256')
    .update(`${tenantId}:${liveId}:${tipo}`)
    .digest('hex')
}

/**
 * Compat: cria cobrança e retorna shape { id, invoiceUrl, pixCopiaECola }
 * idêntico ao retorno antigo do Asaas — billing_engine consome sem mudança.
 *
 * billingType padrão BOLETO (Appmax aceita 'boleto', 'pix', 'credit-card').
 */
export async function criarCobranca({
  asaasCustomerId,        // mantido pelo nome legado, é gateway_customer_id — será renomeado em Appmax v2
  valor,
  vencimento,
  descricao,
  externalReference,
  billingType = 'BOLETO',
}) {
  const gatewayCustomerId = asaasCustomerId  // compatibilidade interna

  // 1. Cria order primeiro (Appmax exige order antes do payment)
  const order = await createOrder({
    customer_id: gatewayCustomerId,
    products: [
      { sku: externalReference, name: descricao, qty: 1, price: valor, digital_product: 1 },
    ],
    total: valor,
  })
  const orderId = order?.id ?? order?.order_id
  if (!orderId) throw new Error(`Appmax createOrder não retornou id (resp: ${JSON.stringify(order)})`)

  // 2. Gera cobrança no método solicitado
  const t = billingType.toUpperCase()
  let payment
  if (t === 'PIX') {
    payment = await chargePix({
      orderId,
      customerId: gatewayCustomerId,
      expirationDate: vencimento,
    })
  } else {
    payment = await chargeBoleto({
      orderId,
      customerId: gatewayCustomerId,
      dueDate: vencimento,
    })
  }

  return {
    id: payment?.id ?? orderId,
    invoiceUrl: payment?.url ?? payment?.boleto_url ?? payment?.payment_url ?? null,
    pixCopiaECola: payment?.pix?.copy_paste ?? payment?.pix_emv ?? null,
  }
}

/**
 * Compat: valida token de webhook (header). Appmax usa app_id no payload, não
 * header — mas mantemos a função pra preservar API. Verifica APPMAX_WEBHOOK_SECRET
 * se configurado; caso contrário aceita.
 */
export function validarWebhookToken(receivedToken) {
  const expected = process.env.APPMAX_WEBHOOK_SECRET ?? ''
  if (!expected) return // sem secret configurado, aceita
  if (!receivedToken || receivedToken.length !== expected.length) {
    throw new Error('Token de webhook Appmax inválido')
  }
  const a = Buffer.from(receivedToken)
  const b = Buffer.from(expected)
  if (!crypto.timingSafeEqual(a, b)) {
    throw new Error('Token de webhook Appmax inválido')
  }
}

/**
 * Valida assinatura/origem do webhook Appmax.
 * Appmax envia o app_id no payload e (opcionalmente) HMAC se configurado.
 */
export function validateWebhook(payload) {
  if (!payload || typeof payload !== 'object') return false
  // Campo "environment" e "app_id" estão presentes em eventos legítimos
  return payload['app_id'] === _appId() ||
         payload['application_id'] === _appId() ||
         (payload['data'] && payload['data']['app_id'] === _appId())
}
