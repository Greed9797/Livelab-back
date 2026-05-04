import { z } from 'zod'
import { resolveCepToGeo } from './cep.js'

const createSchema = z.object({
  nome:         z.string().min(1),
  celular:      z.string().min(1),
  cpf:          z.string().optional(),
  cnpj:         z.string().optional(),
  razao_social: z.string().optional(),
  email:        z.string().optional(),
  fat_anual:    z.number().default(0),
  nicho:        z.string().optional(),
  site:         z.string().optional(),
  vende_tiktok: z.boolean().default(false),
  lat:          z.number().optional(),
  lng:          z.number().optional(),
  cep:          z.string().optional(),
  cidade:       z.string().optional(),
  estado:       z.string().optional(),
  siga:         z.string().optional(),
})

export async function clientesRoutes(app) {
  // POST /v1/clientes
  app.post('/v1/clientes', { preHandler: app.requirePapel(['franqueado', 'gerente']) }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const d = parsed.data

    // Auto-geocoding: se veio CEP mas sem lat/lng, resolvemos via ViaCEP+Nominatim
    let lat = d.lat ?? null
    let lng = d.lng ?? null
    let cidade = d.cidade ?? null
    let estado = d.estado ?? null
    if (d.cep && (lat == null || lng == null)) {
      const geo = await resolveCepToGeo(d.cep)
      lat = lat ?? geo.lat ?? null
      lng = lng ?? geo.lng ?? null
      cidade = cidade ?? geo.cidade ?? null
      estado = estado ?? geo.estado ?? null
    }

    const db = await app.dbTenant(tenant_id)
    try {
      const result = await db.query(
        `INSERT INTO clientes (tenant_id, nome, celular, cpf, cnpj, razao_social, email,
          fat_anual, nicho, site, vende_tiktok, lat, lng, cep, cidade, estado, siga)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING *`,
        [tenant_id, d.nome, d.celular, d.cpf ?? null, d.cnpj ?? null,
         d.razao_social ?? null, d.email ?? null, d.fat_anual,
         d.nicho ?? null, d.site ?? null, d.vende_tiktok,
         lat, lng,
         d.cep ?? null, cidade, estado, d.siga ?? null]
      )
      return reply.code(201).send(result.rows[0])
    } finally { db.release() }
  })

  // POST /v1/clientes/geocode-pending — preenche lat/lng de clientes existentes
  // (utilizado uma vez para popular clientes cadastrados antes do auto-geocoding)
  app.post('/v1/clientes/geocode-pending', {
    preHandler: app.requirePapel(['franqueado', 'gerente']),
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const db = await app.dbTenant(tenant_id)
    try {
      const { rows } = await db.query(
        `SELECT id, cep, cidade, estado
         FROM clientes
         WHERE (lat IS NULL OR lng IS NULL)
           AND (cep IS NOT NULL OR (cidade IS NOT NULL AND estado IS NOT NULL))
         LIMIT 50`
      )

      const results = { updated: 0, skipped: 0, total: rows.length }
      for (const cli of rows) {
        let geo = {}
        if (cli.cep) {
          geo = await resolveCepToGeo(cli.cep)
        }
        // Fallback: já temos cidade/estado no banco → geocodifica direto
        if ((geo.lat == null || geo.lng == null) && cli.cidade && cli.estado) {
          const { _geocode } = await import('./cep.js')
          const g = await _geocode({ cidade: cli.cidade, estado: cli.estado })
          geo = { ...geo, lat: g.lat, lng: g.lng }
        }
        if (geo.lat != null && geo.lng != null) {
          await db.query(
            `UPDATE clientes SET lat = $1, lng = $2 WHERE id = $3`,
            [geo.lat, geo.lng, cli.id]
          )
          results.updated++
        } else {
          results.skipped++
        }
      }
      return reply.send(results)
    } finally {
      db.release()
    }
  })

  // GET /v1/clientes/metricas — métricas agregadas: LTV, faturamento, lives, comissão
  app.get('/v1/clientes/metricas', { preHandler: app.requirePapel(['franqueado', 'gerente']) }, async (request) => {
    const { tenant_id } = request.user
    const db = await app.dbTenant(tenant_id)
    try {
      const result = await db.query(
        `SELECT
           COALESCE(SUM(l.fat_gerado), 0)           AS ltv_total,
           COALESCE(SUM(l.fat_gerado), 0)           AS faturamento_acumulado,
           COUNT(l.id)::int                          AS total_lives,
           COALESCE(SUM(l.comissao_calculada), 0)   AS comissao_paga
         FROM lives l
         WHERE l.status = 'encerrada'`
      )
      return result.rows[0]
    } finally {
      db.release()
    }
  })

  // GET /v1/clientes
  app.get('/v1/clientes', { preHandler: app.requirePapel(['franqueado', 'gerente']) }, async (request) => {
    const { tenant_id } = request.user
    const db = await app.dbTenant(tenant_id)
    try {
      const result = await db.query(
        `SELECT cl.id, cl.nome, cl.celular, cl.email, cl.status, cl.lat, cl.lng,
                cl.fat_anual, cl.nicho, cl.score, cl.cep, cl.cidade, cl.estado,
                cl.siga, cl.criado_em, cl.meta_diaria_gmv, cl.logo_url,
                c.horas_contratadas, c.horas_consumidas,
                (c.horas_contratadas - c.horas_consumidas) AS horas_restantes
         FROM clientes cl
         LEFT JOIN LATERAL (
           SELECT horas_contratadas, horas_consumidas
           FROM contratos
           WHERE cliente_id = cl.id AND status = 'ativo'
           ORDER BY ativado_em DESC NULLS LAST
           LIMIT 1
         ) c ON true
         WHERE cl.status IN ('ativo', 'inadimplente', 'cancelado')
         ORDER BY cl.criado_em DESC`
      )
      return result.rows
    } finally {
      db.release()
    }
  })

  // GET /v1/clientes/:id
  app.get('/v1/clientes/:id', { preHandler: app.requirePapel(['franqueado', 'gerente']) }, async (request, reply) => {
    const { tenant_id } = request.user
    const db = await app.dbTenant(tenant_id)
    try {
      const result = await db.query(
        `SELECT * FROM clientes WHERE id = $1`, [request.params.id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Cliente não encontrado' })
      return result.rows[0]
    } finally {
      db.release()
    }
  })

  // POST /v1/clientes/logo/favicon — cliente_parceiro busca logo via Google Favicons
  // Backend faz proxy + converte pra data URL base64 (evita CORS no frontend).
  app.post('/v1/clientes/logo/favicon', {
    preHandler: [app.authenticate, app.requirePapel(['cliente_parceiro'])],
  }, async (request, reply) => {
    const { website_url } = request.body ?? {}
    if (!website_url) return reply.code(400).send({ error: 'website_url obrigatório' })

    let domain = website_url.trim()
    if (domain.includes('://')) {
      domain = new URL(domain).hostname
    } else {
      domain = domain.split('/')[0]
    }

    const sourceUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`

    let dataUrl
    try {
      const r = await fetch(sourceUrl, { signal: AbortSignal.timeout(8000) })
      if (!r.ok) {
        return reply.code(502).send({ error: 'Não foi possível obter o favicon do site.' })
      }
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.length < 100) {
        return reply.code(404).send({ error: 'Logo não encontrado para este site.' })
      }
      const ct = r.headers.get('content-type') || 'image/png'
      dataUrl = `data:${ct};base64,${buf.toString('base64')}`
    } catch (err) {
      app.log.warn({ err: err.message, sourceUrl }, '[logo favicon] fetch failed')
      return reply.code(502).send({ error: 'Falha ao buscar favicon.' })
    }

    const { tenant_id, sub: userId } = request.user
    const db = await app.dbTenant(tenant_id)
    try {
      const upd = await db.query(
        `UPDATE clientes SET logo_url = $1, site = $3, atualizado_em = NOW()
         WHERE user_id = $2 RETURNING id`,
        [dataUrl, userId, website_url.trim()]
      )
      if (upd.rowCount === 0) {
        app.log.warn({ userId }, '[logo favicon] cliente não vinculado ao user_id')
        return reply.code(404).send({
          error: 'Conta de cliente não vinculada — peça pro admin associar seu usuário a um cliente.',
        })
      }
      return { logo_url: dataUrl }
    } finally {
      db.release()
    }
  })

  // PATCH /v1/clientes/:id
  app.patch('/v1/clientes/:id', { preHandler: app.requirePapel(['franqueado', 'gerente']) }, async (request, reply) => {
    const { tenant_id } = request.user
    const allowed = ['nome','celular','email','fat_anual','nicho','site','vende_tiktok','lat','lng','status','meta_diaria_gmv','onboarding_step']
    const body = { ...request.body }

    // Onboarding automático: se status === 'ganho', promove para onboarding + step 1
    if (body.status === 'ganho') {
      body.status = 'onboarding'
      body.onboarding_step = 1
    }

    const updates = Object.fromEntries(
      Object.entries(body).filter(([k]) => allowed.includes(k))
    )
    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({ error: 'Nenhum campo válido para atualizar' })
    }

    const keys = Object.keys(updates)
    const vals = Object.values(updates)
    const set  = keys.map((k, i) => `${k} = $${i + 1}`).join(', ')

    const db = await app.dbTenant(tenant_id)
    try {
      const result = await db.query(
        `UPDATE clientes SET ${set}, atualizado_em = NOW()
         WHERE id = $${keys.length + 1} RETURNING id, nome, status, onboarding_step`,
        [...vals, request.params.id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Cliente não encontrado' })
      return result.rows[0]
    } finally {
      db.release()
    }
  })
}
