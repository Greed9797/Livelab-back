import { z } from 'zod'
import { READ_CONFIGURACOES, WRITE_CONFIGURACOES } from '../config/role_groups.js'

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

const configSchema = z.object({
  logo_url:            z.string().url().or(z.literal('')).optional().nullable(),
  nome:                z.string().min(1).optional(),
  telefone_contato:    z.string().optional().nullable(),
  email_contato:       z.string().email().optional().nullable(),
  gateway_api_key:     z.string().optional().nullable(),
  gateway_wallet_id:   z.string().optional().nullable(),
  // Aliases legados pra compat (campos antigos do Asaas mapeiam pro novo)
  asaas_api_key:       z.string().optional().nullable(),
  asaas_wallet_id:     z.string().optional().nullable(),
  tiktok_access_token: z.string().optional().nullable(),
  tiktok_shop_id:      z.string().optional().nullable(),
  nova_senha:          z.string().min(6).optional().nullable(),
  meta_diaria_gmv:     z.number().positive().optional().nullable(),
  // F1: flags de notificação por e-mail (Resend)
  notif_email_ativo:    z.boolean().optional(),
  notif_live_meta:      z.boolean().optional(),
  notif_boleto_vencido: z.boolean().optional(),
  notif_lead_novo:      z.boolean().optional(),
  notif_contrato:       z.boolean().optional(),
})

export async function configuracoesRoutes(app) {
  // POST /v1/configuracoes/logo — upload de imagem para Supabase Storage
  app.post('/v1/configuracoes/logo', {
    preHandler: [app.authenticate, app.requirePapel(WRITE_CONFIGURACOES)],
  }, async (request, reply) => {
    const supabaseUrl = process.env.SUPABASE_URL
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY
    if (!supabaseUrl || !supabaseKey) {
      return reply.code(503).send({ error: 'Armazenamento de imagens não configurado no servidor.' })
    }

    const data = await request.file()
    if (!data) return reply.code(400).send({ error: 'Nenhum arquivo enviado.' })
    if (!ALLOWED_MIME.includes(data.mimetype)) {
      return reply.code(400).send({ error: 'Formato não suportado. Use JPEG, PNG ou WebP.' })
    }

    const chunks = []
    for await (const chunk of data.file) chunks.push(chunk)
    const buffer = Buffer.concat(chunks)
    if (buffer.length > 5 * 1024 * 1024) {
      return reply.code(400).send({ error: 'Imagem muito grande. Máximo 5 MB.' })
    }

    const { tenant_id } = request.user
    const ext = data.mimetype.split('/')[1].replace('jpeg', 'jpg')
    const filename = `logos/${tenant_id}-${Date.now()}.${ext}`
    const bucket = 'tenant-assets'

    const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${filename}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': data.mimetype,
        'x-upsert': 'true',
      },
      body: buffer,
    })

    if (!uploadRes.ok) {
      const err = await uploadRes.text().catch(() => '')
      request.log.error({ err }, 'Supabase Storage upload failed')
      return reply.code(500).send({ error: 'Falha ao salvar imagem. Tente novamente.' })
    }

    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${filename}`
    return { url: publicUrl }
  })

  // GET /v1/configuracoes
  app.get('/v1/configuracoes', {
    preHandler: app.requirePapel(READ_CONFIGURACOES),
  }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const { rows } = await db.query(`
        SELECT id, nome, logo_url,
               telefone_contato, email_contato,
               gateway_api_key, gateway_wallet_id,
               tiktok_access_token, tiktok_shop_id,
               meta_diaria_gmv,
               notif_email_ativo, notif_live_meta, notif_boleto_vencido,
               notif_lead_novo, notif_contrato
        FROM tenants WHERE id = $1
      `, [tenant_id])

      const conf = rows[0]
      const hideKey = (key) => key && key.length > 8
        ? key.substring(0, 4) + '...' + key.substring(key.length - 4)
        : key

      // Histórico de alterações de telefone/email
      const histRows = await db.query(`
        SELECT campo, valor_anterior, valor_novo, alterado_em
        FROM tenant_contact_history
        WHERE tenant_id = $1
        ORDER BY alterado_em DESC
        LIMIT 20
      `, [tenant_id])

      return {
        id:                     conf.id,
        nome:                   conf.nome,
        logo_url:               conf.logo_url,
        telefone_contato:       conf.telefone_contato,
        email_contato:          conf.email_contato,
        gateway_api_key_hidden: hideKey(conf.gateway_api_key),
        has_gateway:            !!conf.gateway_api_key,
        gateway_wallet_id:      conf.gateway_wallet_id,
        gateway_provider:       'appmax',
        // Aliases legados (frontend antigo ainda referencia)
        asaas_api_key_hidden:   hideKey(conf.gateway_api_key),
        has_asaas:              !!conf.gateway_api_key,
        asaas_wallet_id:        conf.gateway_wallet_id,
        has_tiktok:             !!conf.tiktok_access_token,
        tiktok_shop_id:         conf.tiktok_shop_id,
        meta_diaria_gmv:        conf.meta_diaria_gmv ? Number(conf.meta_diaria_gmv) : 10000,
        notif_email_ativo:      conf.notif_email_ativo ?? true,
        notif_live_meta:        conf.notif_live_meta ?? true,
        notif_boleto_vencido:   conf.notif_boleto_vencido ?? true,
        notif_lead_novo:        conf.notif_lead_novo ?? true,
        notif_contrato:         conf.notif_contrato ?? true,
        contact_history:        histRows.rows,
      }
    })
  })

  // PATCH /v1/configuracoes
  app.patch('/v1/configuracoes', {
    preHandler: [app.authenticate, app.requirePapel(WRITE_CONFIGURACOES)],
  }, async (request, reply) => {
    const parsed = configSchema.safeParse(request.body)

    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id, sub: user_id } = request.user
    const data = parsed.data

    return app.withTenant(tenant_id, async (db) => {
      try {
        await db.query('BEGIN')

        const updates = []
        const values = [tenant_id]
        let paramIdx = 2

        if (data.nome !== undefined)            { updates.push(`nome = $${paramIdx++}`);            values.push(data.nome) }
        if (data.logo_url !== undefined)        { updates.push(`logo_url = $${paramIdx++}`);        values.push(data.logo_url) }
        // Aceita tanto campo novo (gateway_*) quanto legado (asaas_*) — alias semântico.
        const apiKey = data.gateway_api_key ?? data.asaas_api_key
        const walletId = data.gateway_wallet_id ?? data.asaas_wallet_id
        if (apiKey !== undefined)   { updates.push(`gateway_api_key = $${paramIdx++}`);   values.push(apiKey) }
        if (walletId !== undefined) { updates.push(`gateway_wallet_id = $${paramIdx++}`); values.push(walletId) }
        if (data.tiktok_access_token !== undefined) { updates.push(`tiktok_access_token = $${paramIdx++}`); values.push(data.tiktok_access_token) }
        if (data.tiktok_shop_id !== undefined)  { updates.push(`tiktok_shop_id = $${paramIdx++}`);  values.push(data.tiktok_shop_id) }
        if (data.meta_diaria_gmv !== undefined) { updates.push(`meta_diaria_gmv = $${paramIdx++}`); values.push(data.meta_diaria_gmv) }
        // F1: flags de notificação
        if (data.notif_email_ativo !== undefined)    { updates.push(`notif_email_ativo = $${paramIdx++}`);    values.push(data.notif_email_ativo) }
        if (data.notif_live_meta !== undefined)      { updates.push(`notif_live_meta = $${paramIdx++}`);      values.push(data.notif_live_meta) }
        if (data.notif_boleto_vencido !== undefined) { updates.push(`notif_boleto_vencido = $${paramIdx++}`); values.push(data.notif_boleto_vencido) }
        if (data.notif_lead_novo !== undefined)      { updates.push(`notif_lead_novo = $${paramIdx++}`);      values.push(data.notif_lead_novo) }
        if (data.notif_contrato !== undefined)       { updates.push(`notif_contrato = $${paramIdx++}`);       values.push(data.notif_contrato) }

        // Campos de contato com histórico
        if (data.telefone_contato !== undefined || data.email_contato !== undefined) {
          const currentQ = await db.query(
            `SELECT telefone_contato, email_contato FROM tenants WHERE id = $1`, [tenant_id]
          )
          const current = currentQ.rows[0]

          if (data.telefone_contato !== undefined && data.telefone_contato !== current.telefone_contato) {
            updates.push(`telefone_contato = $${paramIdx++}`)
            values.push(data.telefone_contato)
            await db.query(
              `INSERT INTO tenant_contact_history (tenant_id, alterado_por, campo, valor_anterior, valor_novo)
               VALUES ($1, $2, 'telefone', $3, $4)`,
              [tenant_id, user_id, current.telefone_contato, data.telefone_contato]
            )
          }
          if (data.email_contato !== undefined && data.email_contato !== current.email_contato) {
            updates.push(`email_contato = $${paramIdx++}`)
            values.push(data.email_contato)
            await db.query(
              `INSERT INTO tenant_contact_history (tenant_id, alterado_por, campo, valor_anterior, valor_novo)
               VALUES ($1, $2, 'email', $3, $4)`,
              [tenant_id, user_id, current.email_contato, data.email_contato]
            )
          }
        }

        if (updates.length > 0) {
          await db.query(`UPDATE tenants SET ${updates.join(', ')} WHERE id = $1`, values)
        }

        if (data.nova_senha) {
          const bcrypt = await import('bcrypt')
          const hash = await bcrypt.default.hash(data.nova_senha, 12)
          await db.query(
            `UPDATE users SET senha_hash = $1 WHERE id = $2 AND tenant_id = $3`,
            [hash, user_id, tenant_id]
          )
        }

        await db.query('COMMIT')
        return { ok: true, message: 'Configurações atualizadas com sucesso' }
      } catch (e) {
        await db.query('ROLLBACK')
        throw e
      }
    })
  })

  // GET /v1/configuracoes/contact-history
  app.get('/v1/configuracoes/contact-history', {
    preHandler: [app.authenticate, app.requirePapel(READ_CONFIGURACOES)],
  }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const rows = await db.query(`
        SELECT h.campo, h.valor_anterior, h.valor_novo, h.alterado_em, u.nome AS alterado_por_nome
        FROM tenant_contact_history h
        LEFT JOIN users u ON u.id = h.alterado_por
        WHERE h.tenant_id = $1
        ORDER BY h.alterado_em DESC
        LIMIT 50
      `, [tenant_id])
      return rows.rows
    })
  })
}
