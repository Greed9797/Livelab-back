import crypto from 'node:crypto'
import { z } from 'zod'

const onboardingSchema = z.object({
  company_name:     z.string().min(1),
  responsible_name: z.string().min(1),
  main_products:    z.string().min(1),
  sales_history:    z.string().min(1),
  focus_products:   z.string().min(1),
  current_stock:    z.string().min(1),
  product_margin:   z.string().min(1),
  gmv_expectation:  z.string().min(1),
  traffic_budget:   z.string().min(1),
  website_url:      z.string().optional().nullable(),
  instagram_url:    z.string().optional().nullable(),
  tiktok_url:       z.string().optional().nullable(),
  tiktok_shop_url:  z.string().optional().nullable(),
  available_offers: z.string().optional().nullable(),
  live_experience:  z.enum(['none', 'low', 'moderate', 'advanced']),
})

const WEBHOOK_TIMEOUT_MS = 5000

/**
 * Dispara payload de onboarding pro CRM externo (n8n / webhook custom).
 * Fire-and-forget — caller NÃO aguarda. Erro só vira log warn, nunca propaga.
 */
function fireBioCrmWebhook(app, payload) {
  const url = process.env.BIO_CRM_WEBHOOK_URL
  if (!url) {
    app.log.info('[bio-crm webhook] BIO_CRM_WEBHOOK_URL não configurado — skip')
    return
  }

  const body = JSON.stringify(payload)
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'liveshop-saas/1.0' }

  const secret = process.env.BIO_CRM_WEBHOOK_SECRET
  if (secret) {
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex')
    headers['X-Livelab-Signature'] = `sha256=${sig}`
  }

  // Mascarar URL no log (mantém origem, esconde path/token)
  let maskedUrl = url
  try {
    const u = new URL(url)
    maskedUrl = `${u.protocol}//${u.host}${u.pathname.length > 1 ? '/...' : ''}`
  } catch (_) { /* keep raw */ }

  fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  })
    .then(async (res) => {
      if (res.ok) {
        app.log.info({ status: res.status, url: maskedUrl }, '[bio-crm webhook] sent')
      } else {
        app.log.warn(
          { status: res.status, url: maskedUrl },
          '[bio-crm webhook] destino respondeu com erro — onboarding já gravado, segue normalmente',
        )
      }
    })
    .catch((err) => {
      app.log.warn(
        { err: err.message, url: maskedUrl },
        '[bio-crm webhook] falhou — onboarding já gravado, segue normalmente',
      )
    })
}

export default async function onboardingRoutes(app) {
  // POST /v1/onboarding — salva respostas e marca onboarding_completed = true
  app.post('/v1/onboarding', {
    preHandler: [app.authenticate, app.requirePapel(['cliente_parceiro'])],
  }, async (request, reply) => {
    const parsed = onboardingSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message })
    }

    const userId = request.user.sub
    const tenantId = request.user.tenant_id

    const existing = await app.db.query(
      `SELECT id FROM onboarding_responses WHERE user_id = $1`,
      [userId]
    )
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: 'Onboarding já foi concluído anteriormente.' })
    }

    const d = parsed.data
    await app.db.query(
      `INSERT INTO onboarding_responses
        (user_id, tenant_id, company_name, responsible_name, main_products,
         sales_history, focus_products, current_stock, product_margin,
         gmv_expectation, traffic_budget, website_url, instagram_url,
         tiktok_url, tiktok_shop_url, available_offers, live_experience)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        userId, tenantId,
        d.company_name, d.responsible_name, d.main_products,
        d.sales_history, d.focus_products, d.current_stock, d.product_margin,
        d.gmv_expectation, d.traffic_budget,
        d.website_url ?? null, d.instagram_url ?? null,
        d.tiktok_url ?? null, d.tiktok_shop_url ?? null,
        d.available_offers ?? null, d.live_experience,
      ]
    )

    await app.db.query(
      `UPDATE users SET onboarding_completed = true WHERE id = $1`,
      [userId]
    )

    // Lookup user metadata pra enriquecer payload (best-effort)
    let userMeta = { email: null, nome: null }
    try {
      const u = await app.db.query(
        `SELECT email, nome FROM users WHERE id = $1`,
        [userId]
      )
      if (u.rows.length > 0) userMeta = u.rows[0]
    } catch (_) { /* ignore */ }

    // Fire-and-forget — não bloqueia resposta
    fireBioCrmWebhook(app, {
      event: 'onboarding.completed',
      user_id: userId,
      tenant_id: tenantId,
      user_email: userMeta.email,
      user_nome: userMeta.nome,
      submitted_at: new Date().toISOString(),
      data: d,
    })

    return { ok: true }
  })

  // GET /v1/onboarding — lista respostas (franqueador_master/franqueado: todos do tenant; cliente: próprio)
  app.get('/v1/onboarding', {
    preHandler: [app.authenticate, app.requirePapel(['franqueador_master', 'franqueado', 'cliente_parceiro'])],
  }, async (request) => {
    const { papel, sub: userId, tenant_id: tenantId } = request.user
    const db = await app.dbTenant(tenantId)

    try {
      if (papel === 'cliente_parceiro') {
        const r = await db.query(
          `SELECT * FROM onboarding_responses WHERE user_id = $1`,
          [userId]
        )
        return r.rows[0] ?? null
      }

      const r = await db.query(
        `SELECT o.*, u.nome as user_nome, u.email as user_email
         FROM onboarding_responses o
         JOIN users u ON u.id = o.user_id
         WHERE o.tenant_id = $1
         ORDER BY o.created_at DESC`,
        [tenantId]
      )
      return r.rows
    } finally {
      db.release()
    }
  })
}
