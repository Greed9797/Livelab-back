import { z } from 'zod'
import { performance } from 'node:perf_hooks'
import { READ_MARCAS, WRITE_MARCAS } from '../config/role_groups.js'
import { buildCacheKey, invalidateTenant, setCacheControl, withCache } from '../lib/dashboard-cache.js'
import { getMarcaOperacional, resolveMonthRange } from '../lib/operacional.js'
import { liveGmvSql } from '../lib/metric-sql.js'
import { tiktokUsernameField, tiktokUsernameSql, updateCanonicalTikTokUsername } from '../lib/tiktok-username.js'
import { ensureClienteMarca } from '../services/client-brand.js'

// TTL longo de propósito: a invalidação por evento (writes) é quem mantém a
// listagem fresca. Este TTL é só o limite de quanto um dado poderia ficar velho
// se algum caminho de escrita esquecer de invalidar.
const MARCAS_CACHE_TTL_MS = Number(process.env.MARCAS_CACHE_TTL_MS ?? 300_000)

/** Namespaces de cache afetados por qualquer escrita de marca/cliente. */
export const LISTAGEM_NAMESPACES = ['marcas:list', 'clientes:list']

const marcaCols = `
  m.id, m.tenant_id, m.cliente_id, m.nome, m.tipo, m.status,
  ${tiktokUsernameSql({ marca: 'm', cliente: 'c' })} AS tiktok_username, m.site, m.marketplace_url, m.logo_url, m.cor,
  m.comissao_franquia_pct, m.comissao_franqueadora_pct, m.valor_fixo_minimo, m.tipo_cobranca,
  m.observacoes, m.criado_em, m.atualizado_em,
  c.nome AS cliente_nome,
  COALESCE(am_agg.apresentadoras, '[]'::json) AS apresentadoras
`

const marcaBaseSchema = z.object({
  cliente_id: z.string().uuid().nullable().optional(),
  nome: z.string().min(1),
  tipo: z.enum(['cliente', 'afiliada', 'propria', 'parceira']).default('cliente'),
  status: z.enum(['ativa', 'inativa', 'pausada', 'arquivada']).default('ativa'),
  tiktok_username: tiktokUsernameField,
  site: z.string().nullable().optional(),
  marketplace_url: z.string().nullable().optional(),
  logo_url: z.string().url().nullable().optional(),
  // Cor manual da marca (hex #rrggbb). null explícito LIMPA a cor (volta à automática).
  cor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'cor deve ser hex #rrggbb').nullable().optional(),
  // SEM default(0): payload sem o campo = "não mexer". O default 0 fazia o upsert
  // do POST re-zerar percentuais já configurados da marca (bug Posthaus).
  comissao_franquia_pct: z.number().min(0).max(100).optional(),
  comissao_franqueadora_pct: z.number().min(0).max(100).optional(),
  // Fixo mensal (R$) da marca tipo=cliente — SOMA ao comissionamento gerado uma vez
  // por mês com atividade, em franquia e franqueadora (ver performance-rollups.js e
  // financeiro.js). Não é mais piso por live. Afiliadas ignoram este campo.
  valor_fixo_minimo: z.number().min(0).optional(),
  // Regra de composição da ENTRADAS da marca (migration 132). Optional: payload sem o campo
  // = "não mexer" (mesma razão dos percentuais). Default do banco = 'fixo_mais_comissao'.
  tipo_cobranca: z.enum(['fixo_mais_comissao', 'fixo_ou_comissao']).optional(),
  observacoes: z.string().nullable().optional(),
})

const marcaSchema = marcaBaseSchema.refine((data) => data.tipo !== 'cliente' || Boolean(data.cliente_id), {
  message: 'cliente_id é obrigatório para marca de cliente',
})

// PATCH parcial: sobrescreve campos com `.default()` para versões opcionais SEM
// default — senão o default de `tipo` ('cliente') dispara no parse e o refine
// passa a exigir cliente_id em qualquer PATCH (ex: só atualizar comissão → 400).
const marcaPatchSchema = marcaBaseSchema.partial().extend({
  tipo: z.enum(['cliente', 'afiliada', 'propria', 'parceira']).optional(),
  status: z.enum(['ativa', 'inativa', 'pausada', 'arquivada']).optional(),
}).refine((data) => {
  if (data.tipo === 'cliente') return Boolean(data.cliente_id)
  return true
}, { message: 'cliente_id é obrigatório para marca de cliente' })

const vinculoSchema = z.object({
  apresentadora_id: z.string().uuid(),
  papel: z.enum(['principal', 'apoio', 'reserva']).default('principal'),
  comissao_video_pct: z.number().min(0).max(100).default(0),
  ativo: z.boolean().default(true),
  inicio_em: z.string().nullable().optional(),
  fim_em: z.string().nullable().optional(),
})

const vinculoPatchSchema = vinculoSchema.partial().omit({ apresentadora_id: true })

function addFilter(filters, values, sql) {
  filters.push(sql.replace('?', `$${values.length}`))
}

export const MARCA_NOME_DUPLICADA = 'Já existe uma marca com este nome nesta unidade. Escolha outro nome.'

/** Nome do índice único criado pela migration 129. */
const UNIQ_NOME_INDEX = 'uniq_marca_nome_por_tenant'

/**
 * Marca duplicada por nome quebra o matching por nome do analytics-import.
 * Checagem explícita (funciona mesmo se a migration 129 tiver pulado a criação
 * do índice por já haver duplicata em produção) + o índice único como rede de
 * segurança contra corrida entre transações — ver isNomeDuplicadoError.
 */
async function nomeMarcaJaExiste(db, { tenantId, nome, ignoreId = null }) {
  const r = await db.query(
    `SELECT 1 FROM marcas
      WHERE tenant_id = $1::uuid
        AND lower(nome) = lower($2)
        AND ($3::uuid IS NULL OR id <> $3::uuid)
      LIMIT 1`,
    [tenantId, nome, ignoreId],
  )
  return Boolean(r.rows[0])
}

/** 23505 vindo do índice único de nome (e não de outra constraint da tabela). */
function isNomeDuplicadoError(err) {
  return err?.code === '23505' && err?.constraint === UNIQ_NOME_INDEX
}

export async function marcasRoutes(app) {
  const readAccess = [app.authenticate, app.requirePapel(READ_MARCAS)]
  const writeAccess = [app.authenticate, app.requirePapel(WRITE_MARCAS)]

  app.get('/v1/marcas', { preHandler: readAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    const { status, tipo, cliente_id, q } = request.query ?? {}

    // Cache orientado a evento: a query agrega o mês inteiro de lives+vídeos a
    // cada request. Quem invalida é o write (criar/editar/arquivar marca, e as
    // vendas que entram por webhook) — o TTL longo é só rede de segurança para
    // um caminho de escrita que porventura não invalide, nunca a fonte da verdade.
    // A chave inclui os filtros: sem isso, uma listagem filtrada serviria outra.
    const startedAt = performance.now()
    const cacheKey = buildCacheKey(tenant_id, { status, tipo, cliente_id, q })
    const { value, state } = await withCache({
      namespace: 'marcas:list',
      key: cacheKey,
      ttlMs: MARCAS_CACHE_TTL_MS,
      computeFn: () => app.withTenant(tenant_id, async (db) => {
      const values = [tenant_id]
      const filters = ['m.tenant_id = $1::uuid']

      // Default: exclui status='inativa' (soft-delete leakage fix).
      // ?status=all → bypass; ?status=<valor> → filtra exato.
      if (status === 'all') {
        // bypass
      } else if (status) {
        values.push(status)
        addFilter(filters, values, 'm.status = ?')
      } else {
        // Arquivadas (e inativas) somem por padrão; ?status=arquivada lista.
        filters.push(`m.status NOT IN ('inativa', 'arquivada')`)
      }
      if (tipo && tipo !== 'all') {
        values.push(tipo)
        addFilter(filters, values, 'm.tipo = ?')
      }
      if (cliente_id) {
        values.push(cliente_id)
        addFilter(filters, values, 'm.cliente_id = ?::uuid')
      }
      if (q) {
        values.push(`%${String(q).trim()}%`)
        addFilter(filters, values, 'm.nome ILIKE ?')
      }

      // GMV/lives/vídeos do mês corrente derivados da fonte da verdade (lives + video_registros).
      const { startDate: mStart, endDate: mEnd } = resolveMonthRange({})
      const startIdx = values.push(mStart)
      const endIdx = values.push(mEnd)

      const result = await db.query(
        `SELECT ${marcaCols},
                COALESCE(mtr.gmv_mes, 0) AS gmv_mes,
                COALESCE(mtr.lives_mes, 0) AS lives_mes,
                COALESCE(mtr.videos_mes, 0) AS videos_mes
         FROM marcas m
         LEFT JOIN clientes c ON c.id = m.cliente_id AND c.tenant_id = m.tenant_id
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object(
             'id', am.apresentadora_id,
             'nome', a.nome,
             'papel', am.papel,
             'comissao_video_pct', am.comissao_video_pct
           ) ORDER BY am.papel, a.nome) AS apresentadoras
           FROM apresentadora_marcas am
           JOIN apresentadoras a ON a.id = am.apresentadora_id AND a.tenant_id = am.tenant_id
           WHERE am.marca_id = m.id
             AND am.tenant_id = m.tenant_id
             AND am.ativo = true
         ) am_agg ON true
         LEFT JOIN (
           SELECT id, COALESCE(SUM(gmv), 0) AS gmv_mes,
                  COALESCE(SUM(is_live), 0)::int AS lives_mes,
                  COALESCE(SUM(is_video), 0)::int AS videos_mes
           FROM (
             SELECT l.marca_id AS id, ${liveGmvSql('l')} AS gmv, 1 AS is_live, 0 AS is_video
             FROM lives l
             WHERE l.tenant_id = $1::uuid AND l.status = 'encerrada' AND l.marca_id IS NOT NULL
               AND l.iniciado_em::date >= $${startIdx}::date AND l.iniciado_em::date <= $${endIdx}::date
             UNION ALL
             SELECT vr.marca_id AS id, vr.gmv_atribuido AS gmv, 0 AS is_live, 1 AS is_video
             FROM video_registros vr
             WHERE vr.tenant_id = $1::uuid
               AND vr.data >= $${startIdx}::date AND vr.data <= $${endIdx}::date
           ) t GROUP BY id
         ) mtr ON mtr.id = m.id
         WHERE ${filters.join(' AND ')}
         ORDER BY m.status = 'ativa' DESC, m.nome ASC`,
        values,
      )
      return result.rows
      }),
    })
    setCacheControl(reply, state, startedAt)
    return value
  })

  app.post('/v1/marcas', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = marcaSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const d = parsed.data
    return app.withTenant(tenant_id, async (db) => {
      if (d.cliente_id) {
        const cliente = await db.query('SELECT id FROM clientes WHERE id = $1 AND tenant_id = $2::uuid', [d.cliente_id, tenant_id])
        if (!cliente.rows[0]) return reply.code(404).send({ error: 'Cliente não encontrado' })
      }

      await db.query('BEGIN')
      try {
        // Invariante cliente->marca: já existe (ou garantimos) UMA marca tipo='cliente'
        // por cliente. Em vez de inserir uma 2ª (que violaria uniq_marca_cliente_por_tenant),
        // reusamos a existente e aplicamos os campos enviados (upsert idempotente).
        let createdMarcaId = null
        if (d.tipo === 'cliente' && d.cliente_id) {
          createdMarcaId = await ensureClienteMarca(db, { tenantId: tenant_id, clienteId: d.cliente_id })
        }

        // A pré-checagem de nome duplicado NÃO vale no caminho tipo='cliente':
        // ali o POST é um upsert idempotente da única marca daquele cliente
        // (invariante acima, garantida por uniq_marca_cliente_por_tenant), então
        // reencontrar o próprio nome é o comportamento esperado, não colisão.
        // Rodar o guard aqui quebraria o upsert do "bug Posthaus" (#13).
        if (!createdMarcaId && await nomeMarcaJaExiste(db, { tenantId: tenant_id, nome: d.nome })) {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: MARCA_NOME_DUPLICADA })
        }

        // Upsert: campo de comissão ausente no payload NÃO sobrescreve o valor já
        // configurado na marca (COALESCE com null quando o campo não veio).
        const result = createdMarcaId
          ? await db.query(
              `UPDATE marcas SET
                 nome = $3, status = $4, site = $5, marketplace_url = $6,
                 comissao_franquia_pct = COALESCE($7, comissao_franquia_pct),
                 comissao_franqueadora_pct = COALESCE($8, comissao_franqueadora_pct),
                 observacoes = $9, logo_url = COALESCE($10, logo_url),
                 valor_fixo_minimo = COALESCE($11, valor_fixo_minimo),
                 cor = COALESCE($12, cor),
                 tipo_cobranca = COALESCE($13, tipo_cobranca),
                 atualizado_em = NOW()
               WHERE id = $1 AND tenant_id = $2::uuid
               RETURNING *`,
              [
                createdMarcaId, tenant_id, d.nome, d.status, d.site ?? null, d.marketplace_url ?? null,
                d.comissao_franquia_pct ?? null, d.comissao_franqueadora_pct ?? null,
                d.observacoes ?? null, d.logo_url ?? null, d.valor_fixo_minimo ?? null,
                d.cor ?? null, d.tipo_cobranca ?? null,
              ],
            )
          : await db.query(
              `INSERT INTO marcas (
                 tenant_id, cliente_id, nome, tipo, status, tiktok_username, site,
                 marketplace_url, comissao_franquia_pct, comissao_franqueadora_pct,
                 observacoes, logo_url, valor_fixo_minimo, cor, tipo_cobranca
               )
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
               RETURNING *`,
              [
                tenant_id, d.cliente_id ?? null, d.nome, d.tipo, d.status,
                d.tipo === 'cliente' ? null : d.tiktok_username ?? null, d.site ?? null, d.marketplace_url ?? null,
                d.comissao_franquia_pct ?? 0, d.comissao_franqueadora_pct ?? 0,
                d.observacoes ?? null, d.logo_url ?? null, d.valor_fixo_minimo ?? 0,
                d.cor ?? null, d.tipo_cobranca ?? 'fixo_mais_comissao',
              ],
            )
        if (d.tiktok_username !== undefined) {
          await updateCanonicalTikTokUsername(db, {
            tenantId: tenant_id,
            marcaId: result.rows[0].id,
            username: d.tiktok_username,
          })
          result.rows[0].tiktok_username = d.tiktok_username ?? null
        }
        await db.query('COMMIT')
        app.audit?.log?.(request, { action: 'marca.create', entity_type: 'marca', entity_id: result.rows[0].id, metadata: { nome: d.nome, tipo: d.tipo } })?.catch(err => app.log.error({ err }, 'audit log failed'))
        return reply.code(201).send(result.rows[0])
      } catch (err) {
        await db.query('ROLLBACK')
        if (isNomeDuplicadoError(err)) return reply.code(409).send({ error: MARCA_NOME_DUPLICADA })
        throw err
      }
    })
  })

  app.get('/v1/marcas/:id/apresentadoras', { preHandler: readAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const marca = await db.query('SELECT id FROM marcas WHERE id = $1 AND tenant_id = $2::uuid', [request.params.id, tenant_id])
      if (!marca.rows[0]) return reply.code(404).send({ error: 'Marca não encontrada' })

      const result = await db.query(
        `SELECT am.*, a.nome AS apresentadora_nome, a.email AS apresentadora_email
         FROM apresentadora_marcas am
         JOIN apresentadoras a ON a.id = am.apresentadora_id AND a.tenant_id = am.tenant_id
         WHERE am.marca_id = $1 AND am.tenant_id = $2::uuid
         ORDER BY am.ativo DESC, am.papel ASC, a.nome ASC`,
        [request.params.id, tenant_id],
      )
      return result.rows
    })
  })

  app.post('/v1/marcas/:id/apresentadoras', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = vinculoSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const d = parsed.data
    return app.withTenant(tenant_id, async (db) => {
      const [marca, apresentadora] = await Promise.all([
        db.query('SELECT id FROM marcas WHERE id = $1 AND tenant_id = $2::uuid', [request.params.id, tenant_id]),
        db.query('SELECT id FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid', [d.apresentadora_id, tenant_id]),
      ])
      if (!marca.rows[0]) return reply.code(404).send({ error: 'Marca não encontrada' })
      if (!apresentadora.rows[0]) return reply.code(404).send({ error: 'Apresentadora não encontrada' })

      const result = await db.query(
        `INSERT INTO apresentadora_marcas (
           tenant_id, marca_id, apresentadora_id, papel,
           comissao_video_pct, ativo, inicio_em, fim_em
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (marca_id, apresentadora_id)
         DO UPDATE SET papel = EXCLUDED.papel,
                       comissao_video_pct = EXCLUDED.comissao_video_pct,
                       ativo = EXCLUDED.ativo,
                       inicio_em = EXCLUDED.inicio_em,
                       fim_em = EXCLUDED.fim_em
         RETURNING *`,
        [
          tenant_id, request.params.id, d.apresentadora_id, d.papel,
          d.comissao_video_pct, d.ativo,
          d.inicio_em ?? null, d.fim_em ?? null,
        ],
      )
      return reply.code(201).send(result.rows[0])
    })
  })

  app.patch('/v1/marcas/:id/apresentadoras/:vinculoId', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = vinculoPatchSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const updates = parsed.data
    const fields = Object.keys(updates)
    if (fields.length === 0) return reply.code(400).send({ error: 'Nenhum campo para atualizar' })

    const values = [request.params.id, request.params.vinculoId, request.user.tenant_id, ...fields.map((field) => updates[field])]
    const set = fields.map((field, index) => `${field} = $${index + 4}`).join(', ')

    return app.withTenant(request.user.tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE apresentadora_marcas
         SET ${set}
         WHERE marca_id = $1 AND id = $2 AND tenant_id = $3::uuid
         RETURNING *`,
        values,
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Vínculo não encontrado' })
      return result.rows[0]
    })
  })

  app.delete('/v1/marcas/:id/apresentadoras/:vinculoId', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `DELETE FROM apresentadora_marcas
         WHERE marca_id = $1 AND id = $2 AND tenant_id = $3::uuid
         RETURNING id`,
        [request.params.id, request.params.vinculoId, tenant_id],
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Vínculo não encontrado' })
      return reply.code(204).send()
    })
  })

  app.get('/v1/marcas/:id/operacional', { preHandler: readAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    const { startDate, endDate } = resolveMonthRange(request.query)
    return app.withTenant(tenant_id, async (db) => {
      const detail = await getMarcaOperacional(db, {
        tenantId: tenant_id,
        marcaId: request.params.id,
        startDate,
        endDate,
      })
      if (!detail) return reply.code(404).send({ error: 'Marca não encontrada' })
      return { ...detail, periodo: { inicio: startDate, fim: endDate } }
    })
  })

  app.get('/v1/marcas/:id', { preHandler: readAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT ${marcaCols}
         FROM marcas m
         LEFT JOIN clientes c ON c.id = m.cliente_id AND c.tenant_id = m.tenant_id
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object(
             'id', am.apresentadora_id,
             'nome', a.nome,
             'papel', am.papel,
             'comissao_video_pct', am.comissao_video_pct
           ) ORDER BY am.papel, a.nome) AS apresentadoras
           FROM apresentadora_marcas am
           JOIN apresentadoras a ON a.id = am.apresentadora_id AND a.tenant_id = am.tenant_id
           WHERE am.marca_id = m.id
             AND am.tenant_id = m.tenant_id
             AND am.ativo = true
         ) am_agg ON true
         WHERE m.id = $1 AND m.tenant_id = $2::uuid`,
        [request.params.id, tenant_id],
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Marca não encontrada' })
      return result.rows[0]
    })
  })

  app.patch('/v1/marcas/:id', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = marcaPatchSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const updates = { ...parsed.data }
    const hasTikTokUpdate = Object.prototype.hasOwnProperty.call(updates, 'tiktok_username')
    const nextTikTokUsername = updates.tiktok_username
    delete updates.tiktok_username
    const fields = Object.keys(updates)
    if (fields.length === 0 && !hasTikTokUpdate) return reply.code(400).send({ error: 'Nenhum campo para atualizar' })

    const values = [request.params.id, request.user.tenant_id, ...fields.map((field) => updates[field])]
    const set = fields.map((field, index) => `${field} = $${index + 3}`).concat('atualizado_em = NOW()').join(', ')

    return app.withTenant(request.user.tenant_id, async (db) => {
      await db.query('BEGIN')
      try {
      if (updates.cliente_id) {
        const cliente = await db.query('SELECT id FROM clientes WHERE id = $1 AND tenant_id = $2::uuid', [updates.cliente_id, request.user.tenant_id])
        if (!cliente.rows[0]) {
          await db.query('ROLLBACK')
          return reply.code(404).send({ error: 'Cliente não encontrado' })
        }
      }

      if (updates.nome !== undefined && await nomeMarcaJaExiste(db, {
        tenantId: request.user.tenant_id,
        nome: updates.nome,
        ignoreId: request.params.id,
      })) {
        await db.query('ROLLBACK')
        return reply.code(409).send({ error: MARCA_NOME_DUPLICADA })
      }

      const result = fields.length > 0
        ? await db.query(
            `UPDATE marcas SET ${set}
             WHERE id = $1 AND tenant_id = $2::uuid
             RETURNING *`,
            values,
          )
        : await db.query(
            `SELECT * FROM marcas WHERE id = $1 AND tenant_id = $2::uuid FOR UPDATE`,
            [request.params.id, request.user.tenant_id],
          )
      if (!result.rows[0]) {
        await db.query('ROLLBACK')
        return reply.code(404).send({ error: 'Marca não encontrada' })
      }
      if (hasTikTokUpdate) {
        const canonical = await updateCanonicalTikTokUsername(db, {
          tenantId: request.user.tenant_id,
          marcaId: request.params.id,
          username: nextTikTokUsername,
        })
        result.rows[0].tiktok_username = canonical?.tiktok_username ?? null
      }
      if (result.rows[0].tipo === 'cliente' && result.rows[0].cliente_id) {
        await db.query(
          `UPDATE marcas SET tiktok_username = NULL, atualizado_em = NOW()
           WHERE id = $1 AND tenant_id = $2::uuid`,
          [request.params.id, request.user.tenant_id],
        )
      }
      await db.query('COMMIT')
      app.audit?.log?.(request, {
        action: 'marca.update',
        entity_type: 'marca',
        entity_id: request.params.id,
        metadata: {
          changed_fields: hasTikTokUpdate ? [...fields, 'tiktok_username'] : fields,
          comissao_franquia_pct: result.rows[0].comissao_franquia_pct,
          comissao_franqueadora_pct: result.rows[0].comissao_franqueadora_pct,
          valor_fixo_minimo: result.rows[0].valor_fixo_minimo,
        },
      })?.catch?.(err => app.log.error({ err }, 'audit log marca.update failed'))
      return result.rows[0]
      } catch (err) {
        await db.query('ROLLBACK')
        if (isNomeDuplicadoError(err)) return reply.code(409).send({ error: MARCA_NOME_DUPLICADA })
        throw err
      }
    })
  })

  app.delete('/v1/marcas/:id', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE marcas SET status = 'inativa', atualizado_em = NOW()
         WHERE id = $1 AND tenant_id = $2::uuid
         RETURNING id`,
        [request.params.id, tenant_id],
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Marca não encontrada' })
      return reply.code(204).send()
    })
  })
}
