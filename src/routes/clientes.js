import { z } from 'zod'
import bcrypt from 'bcrypt'
import crypto from 'node:crypto'
import { resolveCepToGeo } from './cep.js'
import { READ_CLIENTES, WRITE_CLIENTES } from '../config/role_groups.js'
import { getClienteOperacional, resolveMonthRange } from '../lib/operacional.js'
import { tiktokUsernameField } from '../lib/tiktok-username.js'
import { SECURITY } from '../config/security.js'
const imageUrlField = z.string().max(500000).nullable().optional()

const createSchema = z.object({
  nome:            z.string().min(1),
  celular:         z.string().min(1),
  cpf:             z.string().optional(),
  cnpj:            z.string().optional(),
  razao_social:    z.string().optional(),
  email:           z.string().optional(),
  fat_anual:       z.number().default(0),
  nicho:           z.string().optional(),
  site:            z.string().optional(),
  vende_tiktok:    z.boolean().default(false),
  lat:             z.number().optional(),
  lng:             z.number().optional(),
  cep:             z.string().optional(),
  cidade:          z.string().optional(),
  estado:          z.string().optional(),
  siga:            z.string().optional(),
  tiktok_username: tiktokUsernameField,
  logo_url:        imageUrlField,
  criar_acesso:    z.boolean().default(false),
  acesso_nome:     z.string().optional(),
  acesso_email:    z.string().email().optional(),
  senha_temporaria: z.string().min(6, 'Senha temporária deve ter no mínimo 6 caracteres').optional(),
}).refine(d => !d.criar_acesso || Boolean(d.acesso_email || d.email), {
  message: 'E-mail é obrigatório para criar acesso do cliente',
})

const patchSchema = z.object({
  nome:             z.string().optional(),
  celular:          z.string().optional(),
  email:            z.string().optional(),
  fat_anual:        z.number().optional(),
  nicho:            z.string().optional(),
  site:             z.string().optional(),
  vende_tiktok:     z.boolean().optional(),
  lat:              z.number().optional(),
  lng:              z.number().optional(),
  status:           z.string().optional(),
  meta_diaria_gmv:  z.number().optional(),
  onboarding_step:  z.number().int().optional(),
  tiktok_username:  tiktokUsernameField,
  logo_url:         imageUrlField,
}).passthrough()

const mergeSchema = z.object({
  vencedor_id: z.string().uuid(),
  duplicado_id: z.string().uuid(),
})

const onlyDigits = (value) => String(value ?? '').replace(/\D/g, '')
const normalizedEmail = (value) => String(value ?? '').trim().toLowerCase()

function detectStrongMergeCriterion(a, b) {
  const cnpjA = onlyDigits(a.cnpj)
  const cnpjB = onlyDigits(b.cnpj)
  if (cnpjA && cnpjA === cnpjB) return 'cnpj'

  const emailA = normalizedEmail(a.email)
  const emailB = normalizedEmail(b.email)
  if (emailA && emailA === emailB) return 'email'

  return null
}

export async function clientesRoutes(app) {
  // POST /v1/clientes
  app.post('/v1/clientes', { preHandler: app.requirePapel(WRITE_CLIENTES) }, async (request, reply) => {
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
      try {
        const geo = await resolveCepToGeo(d.cep)
        lat = lat ?? geo.lat ?? null
        lng = lng ?? geo.lng ?? null
        cidade = cidade ?? geo.cidade ?? null
        estado = estado ?? geo.estado ?? null
      } catch (_geoErr) {
        // geocoding failure is non-critical — continue without coordinates
      }
    }

    return app.withTenant(tenant_id, async (db) => {
      await db.query('BEGIN')
      try {
        const result = await db.query(
          `INSERT INTO clientes (tenant_id, nome, celular, cpf, cnpj, razao_social, email,
            fat_anual, nicho, site, vende_tiktok, lat, lng, cep, cidade, estado, siga, tiktok_username, logo_url, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'ativo')
           RETURNING *`,
          [tenant_id, d.nome, d.celular, d.cpf ?? null, d.cnpj ?? null,
           d.razao_social ?? null, d.email ?? null, d.fat_anual,
           d.nicho ?? null, d.site ?? null, d.vende_tiktok,
           lat, lng,
           d.cep ?? null, cidade, estado, d.siga ?? null,
           d.tiktok_username ?? null, d.logo_url ?? null]
        )
        const cliente = result.rows[0]

        let acesso = null
        if (d.criar_acesso) {
          const acessoEmail = normalizedEmail(d.acesso_email ?? d.email)
          const emailCheck = z.string().email().safeParse(acessoEmail)
          if (!emailCheck.success) {
            await db.query('ROLLBACK')
            return reply.code(400).send({ error: 'E-mail inválido para criar acesso do cliente' })
          }

          const existing = await db.query(
            `SELECT id FROM users
             WHERE LOWER(email) = LOWER($1)
               AND tenant_id = $2::uuid
               AND ativo IS NOT FALSE`,
            [acessoEmail, tenant_id],
          )
          if (existing.rows.length > 0) {
            await db.query('ROLLBACK')
            return reply.code(409).send({
              error: 'E-mail já cadastrado e ativo neste tenant.',
              code: 'EMAIL_ALREADY_ACTIVE',
            })
          }

          const senhaInicial = d.senha_temporaria ?? crypto.randomBytes(8).toString('hex')
          const senhaHash = await bcrypt.hash(senhaInicial, SECURITY.BCRYPT_ROUNDS)
          const userResult = await db.query(
            `INSERT INTO users (tenant_id, nome, email, senha_hash, papel, ativo, criado_por, primeiro_acesso)
             VALUES ($1, $2, $3, $4, 'cliente_parceiro', true, $5, false)
             RETURNING id, nome, email, papel, ativo, criado_em`,
            [
              tenant_id,
              d.acesso_nome || d.razao_social || d.nome,
              acessoEmail,
              senhaHash,
              request.user.sub,
            ],
          )
          const user = userResult.rows[0]

          await db.query(
            `UPDATE clientes
             SET user_id = $1
             WHERE id = $2
               AND tenant_id = $3::uuid
               AND user_id IS NULL`,
            [user.id, cliente.id, tenant_id],
          )

          acesso = {
            user_id: user.id,
            email: user.email,
            ativo: user.ativo,
            senha_temporaria: senhaInicial,
          }
          cliente.user_id = user.id
          cliente.acesso_email = user.email
          cliente.acesso_ativo = user.ativo
        }

        await db.query('COMMIT')
        app.audit?.log?.(request, { action: 'cliente.create', entity_type: 'cliente', entity_id: cliente.id, metadata: { nome: d.nome, nicho: d.nicho ?? null, fat_anual: d.fat_anual, vende_tiktok: d.vende_tiktok, acesso_criado: Boolean(acesso) } })?.catch(err => app.log.error({ err }, 'audit log failed'))

        if (acesso) {
          reply.header('Cache-Control', 'no-store')
          reply.header('Pragma', 'no-cache')
        }
        return reply.code(201).send(acesso ? { ...cliente, acesso } : cliente)
      } catch (err) {
        await db.query('ROLLBACK').catch(() => {})
        throw err
      }
    })
  })

  // POST /v1/clientes/geocode-pending — preenche lat/lng de clientes existentes
  // (utilizado uma vez para popular clientes cadastrados antes do auto-geocoding)
  app.post('/v1/clientes/geocode-pending', {
    preHandler: app.requirePapel(WRITE_CLIENTES),
  }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const { rows } = await db.query(
        `SELECT id, cep, cidade, estado
         FROM clientes
         WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
           AND (lat IS NULL OR lng IS NULL)
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
            `UPDATE clientes SET lat = $1, lng = $2
             WHERE id = $3 AND tenant_id = current_setting('app.tenant_id', true)::uuid`,
            [geo.lat, geo.lng, cli.id]
          )
          results.updated++
        } else {
          results.skipped++
        }
      }
      return reply.send(results)
    })
  })

  // GET /v1/clientes/metricas — métricas agregadas: LTV, faturamento, lives, comissão
  app.get('/v1/clientes/metricas', { preHandler: app.requirePapel(READ_CLIENTES) }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT
           COALESCE(SUM(l.fat_gerado), 0)           AS ltv_total,
           COALESCE(SUM(l.fat_gerado), 0)           AS faturamento_acumulado,
           COUNT(l.id)::int                          AS total_lives,
           COALESCE(SUM(l.comissao_calculada), 0)   AS comissao_paga
         FROM lives l
         WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
           AND l.status = 'encerrada'`
      )
      return result.rows[0]
    })
  })

  // GET /v1/clientes
  app.get('/v1/clientes', { preHandler: app.requirePapel(READ_CLIENTES) }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      // Defesa em profundidade: WHERE cl.tenant_id explícito porque role
      // postgres do Supabase tem rolbypassrls=true (ADR 0003).
      const mesInicio = (() => {
        const n = new Date()
        return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-01`
      })()
      const result = await db.query(
        `SELECT cl.id, cl.nome, cl.celular, cl.email, cl.status, cl.lat, cl.lng,
                cl.fat_anual, cl.nicho, cl.score, cl.cep, cl.cidade, cl.estado,
                cl.siga, cl.criado_em, cl.meta_diaria_gmv, cl.logo_url, cl.tiktok_username,
                cl.user_id, u.email AS acesso_email, u.ativo AS acesso_ativo,
                c.horas_contratadas, c.horas_consumidas,
                (c.horas_contratadas - c.horas_consumidas) AS horas_restantes,
                COALESCE(lm.gmv_mes, 0)::float AS gmv_mes,
                COALESCE(lm.total_lives_mes, 0)::int AS total_lives_mes,
                COALESCE(ap.apresentadoras_nomes, '[]'::json) AS apresentadoras_nomes
         FROM clientes cl
         LEFT JOIN users u ON u.id = cl.user_id AND u.tenant_id = cl.tenant_id AND u.papel = 'cliente_parceiro'
         LEFT JOIN LATERAL (
           SELECT horas_contratadas, horas_consumidas
           FROM contratos
           WHERE cliente_id = cl.id AND tenant_id = $1::uuid AND status = 'ativo'
           ORDER BY ativado_em DESC NULLS LAST
           LIMIT 1
         ) c ON true
         LEFT JOIN LATERAL (
           SELECT
             COALESCE(SUM(l.fat_gerado), 0) AS gmv_mes,
             COUNT(l.id)::int AS total_lives_mes
           FROM lives l
           WHERE l.cliente_id = cl.id
             AND l.tenant_id = $1::uuid
             AND l.status = 'encerrada'
             AND l.iniciado_em >= $2::date
         ) lm ON true
         LEFT JOIN LATERAL (
           SELECT json_agg(DISTINCT u.nome ORDER BY u.nome) AS apresentadoras_nomes
           FROM lives l
           JOIN users u ON u.id = l.apresentador_id
           WHERE l.cliente_id = cl.id
             AND l.tenant_id = $1::uuid
             AND l.status = 'encerrada'
             AND u.nome IS NOT NULL
         ) ap ON true
         WHERE cl.tenant_id = $1::uuid
           AND cl.status IN ('ativo', 'inadimplente', 'cancelado')
           AND cl.deleted_at IS NULL
         ORDER BY cl.criado_em DESC`,
        [tenant_id, mesInicio]
      )
      return result.rows
    })
  })

  // POST /v1/clientes/merge-restrito
  // Mescla somente duplicatas com match forte dentro do mesmo tenant.
  app.post('/v1/clientes/merge-restrito', {
    preHandler: app.requirePapel(['franqueador_master', 'franqueado', 'gerente']),
  }, async (request, reply) => {
    const parsed = mergeSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { vencedor_id, duplicado_id } = parsed.data
    if (vencedor_id === duplicado_id) {
      return reply.code(400).send({ error: 'Clientes devem ser diferentes.' })
    }

    const { tenant_id, sub: userId } = request.user
    return app.withTenant(tenant_id, async (db) => {
      await db.query('BEGIN')
      try {
        const { rows } = await db.query(
          `SELECT id, nome, email, cnpj
           FROM clientes
           WHERE tenant_id = $1::uuid
             AND id = ANY($2::uuid[])
             AND deleted_at IS NULL
           FOR UPDATE`,
          [tenant_id, [vencedor_id, duplicado_id]],
        )
        const vencedor = rows.find((row) => row.id === vencedor_id)
        const duplicado = rows.find((row) => row.id === duplicado_id)
        if (!vencedor || !duplicado) {
          await db.query('ROLLBACK')
          return reply.code(404).send({ error: 'Cliente vencedor ou duplicado não encontrado.' })
        }

        const criterio = detectStrongMergeCriterion(vencedor, duplicado)
        if (!criterio) {
          await db.query('ROLLBACK')
          return reply.code(409).send({
            error: 'Merge bloqueado: não há match forte por CNPJ ou e-mail no mesmo tenant.',
            code: 'MERGE_STRONG_MATCH_REQUIRED',
          })
        }

        const migrations = {}
        for (const [table, column] of [
          ['lives', 'cliente_id'],
          ['marcas', 'cliente_id'],
          ['contratos', 'cliente_id'],
          ['boletos', 'cliente_id'],
        ]) {
          const result = await db.query(
            `UPDATE ${table}
             SET ${column} = $1
             WHERE tenant_id = $2::uuid AND ${column} = $3
             RETURNING id`,
            [vencedor_id, tenant_id, duplicado_id],
          )
          migrations[table] = result.rowCount
        }

        const softDelete = await db.query(
          `UPDATE clientes
           SET deleted_at = NOW(),
               mesclado_para_id = $1,
               mesclado_em = NOW(),
               mesclado_por = $4
           WHERE id = $2 AND tenant_id = $3::uuid
           RETURNING id`,
          [vencedor_id, duplicado_id, tenant_id, userId ?? null],
        )
        if (!softDelete.rows[0]) {
          await db.query('ROLLBACK')
          return reply.code(404).send({ error: 'Cliente duplicado não encontrado para mesclar.' })
        }

        await db.query(
          `INSERT INTO cliente_merge_auditoria (
             tenant_id, cliente_vencedor_id, cliente_mesclado_id,
             criterio, migracoes, executado_por
           )
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [tenant_id, vencedor_id, duplicado_id, criterio, JSON.stringify(migrations), userId ?? null],
        )
        await db.query('COMMIT')
        app.audit?.log?.(request, {
          action: 'cliente.merge_restrito',
          entity_type: 'cliente',
          entity_id: vencedor_id,
          metadata: { duplicado_id, criterio, migrations },
        })?.catch(err => app.log.error({ err }, 'audit log failed'))
        return { success: true, criterio, migracoes: migrations }
      } catch (error) {
        await db.query('ROLLBACK').catch(() => {})
        throw error
      }
    })
  })

  // GET /v1/clientes/:id/operacional
  app.get('/v1/clientes/:id/operacional', { preHandler: app.requirePapel(READ_CLIENTES) }, async (request, reply) => {
    const { tenant_id } = request.user
    const { startDate, endDate } = resolveMonthRange(request.query)
    return app.withTenant(tenant_id, async (db) => {
      const detail = await getClienteOperacional(db, {
        tenantId: tenant_id,
        clienteId: request.params.id,
        startDate,
        endDate,
      })
      if (!detail) return reply.code(404).send({ error: 'Cliente não encontrado' })
      return { ...detail, periodo: { inicio: startDate, fim: endDate } }
    })
  })

  // GET /v1/clientes/:id
  app.get('/v1/clientes/:id', { preHandler: app.requirePapel(READ_CLIENTES) }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      // Defesa em profundidade: além do RLS via dbTenant, filtra explícito
      // por tenant_id pra evitar leak se RLS for desabilitado por engano.
      const result = await db.query(
        `SELECT * FROM clientes WHERE id = $1 AND tenant_id = $2`,
        [request.params.id, tenant_id],
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Cliente não encontrado' })
      return result.rows[0]
    })
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
    return app.withTenant(tenant_id, async (db) => {
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
    })
  })

  // PATCH /v1/clientes/:id
  app.patch('/v1/clientes/:id', { preHandler: app.requirePapel(WRITE_CLIENTES) }, async (request, reply) => {
    const { tenant_id } = request.user
    const allowed = ['nome','celular','email','fat_anual','nicho','site','vende_tiktok','lat','lng','status','meta_diaria_gmv','onboarding_step','tiktok_username','logo_url']

    // Valida via Zod (especialmente o regex de tiktok_username); demais campos
    // continuam permissivos via passthrough pra preservar compat.
    const parsed = patchSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message })
    }
    const body = { ...parsed.data }

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

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE clientes SET ${set}, atualizado_em = NOW()
         WHERE id = $${keys.length + 1} AND tenant_id = $${keys.length + 2} RETURNING id, nome, status, onboarding_step, tiktok_username, logo_url`,
        [...vals, request.params.id, tenant_id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Cliente não encontrado' })
      if (Object.prototype.hasOwnProperty.call(updates, 'logo_url')) {
        await db.query(
          `UPDATE marcas
           SET logo_url = $1, atualizado_em = NOW()
           WHERE cliente_id = $2
             AND tenant_id = $3::uuid
             AND tipo = 'cliente'`,
          [updates.logo_url ?? null, request.params.id, tenant_id],
        )
      }
      // Log status change separately if applicable
      if (updates.status !== undefined) {
        app.audit?.log?.(request, { action: 'clientes.status_alterado', entity_type: 'cliente', entity_id: request.params.id, metadata: { new_status: updates.status } })?.catch(err => app.log.error({ err }, 'audit log failed'))
      } else {
        app.audit?.log?.(request, { action: 'clientes.update', entity_type: 'cliente', entity_id: request.params.id, metadata: { changed_fields: keys } })?.catch(err => app.log.error({ err }, 'audit log failed'))
      }
      return result.rows[0]
    })
  })

  // GET /v1/clientes/:id/exportar-dados — LGPD: exporta dados pessoais do cliente
  // Apenas franqueado/master do próprio tenant (tenant_id isolado via withTenant).
  // Retorna JSON com header Content-Disposition para download.
  app.get('/v1/clientes/:id/exportar-dados', {
    preHandler: app.requirePapel(['franqueador_master', 'franqueado']),
  }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT
          c.nome, c.email, c.telefone, c.celular, c.cnpj, c.cpf, c.razao_social,
          c.nicho, c.cidade, c.estado, c.criado_em,
          COUNT(l.id)::int           AS total_lives,
          MAX(l.iniciado_em)         AS ultima_live,
          COALESCE(SUM(l.fat_gerado), 0)::float AS gmv_acumulado
         FROM clientes c
         LEFT JOIN lives l ON l.cliente_id = c.id AND l.tenant_id = c.tenant_id AND l.status = 'encerrada'
         WHERE c.id = $1 AND c.tenant_id = $2::uuid AND c.deleted_at IS NULL
         GROUP BY c.id, c.nome, c.email, c.telefone, c.celular, c.cnpj, c.cpf,
                  c.razao_social, c.nicho, c.cidade, c.estado, c.criado_em`,
        [request.params.id, tenant_id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Cliente não encontrado' })
      reply.header('Content-Disposition', `attachment; filename="dados-cliente-${request.params.id}.json"`)
      return result.rows[0]
    })
  })

  // DELETE /v1/clientes/:id — soft-delete
  app.delete('/v1/clientes/:id', {
    preHandler: app.requirePapel(['franqueado', 'gerente', 'franqueador_master']),
  }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE clientes SET deleted_at = NOW()
         WHERE id = $1 AND tenant_id = $2::uuid AND deleted_at IS NULL
         RETURNING id`,
        [request.params.id, tenant_id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Cliente não encontrado' })
      app.audit?.log?.(request, { action: 'cliente.delete', entity_type: 'cliente', entity_id: request.params.id })?.catch(err => app.log.error({ err }, 'audit log failed'))
      return { success: true }
    })
  })
}
