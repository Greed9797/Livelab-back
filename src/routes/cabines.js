import crypto from 'node:crypto'
import { z } from 'zod'
import { READ_CABINES, WRITE_CABINES, READ_LIVES, WRITE_LIVES } from '../config/role_groups.js'
import { getRequestIp, logCabineEvent } from '../lib/cabine-events.js'
import { tiktokUsernameSql } from '../lib/tiktok-username.js'

const cabineRoleAccess = (app) => [
  app.authenticate,
  app.requirePapel(READ_CABINES),
]

const cabineWriteAccess = (app) => [
  app.authenticate,
  app.requirePapel(WRITE_CABINES),
]

const reservarCabineSchema = z.object({
  contrato_id: z.string().uuid().optional().nullable(),
  cliente_id: z.string().uuid().optional().nullable(),
  observacao: z.string().max(500).optional(),
})

const atualizarStatusSchema = z.object({
  status: z.enum(['disponivel', 'manutencao']),
})

const atualizarCabineSchema = z.object({
  nome:      z.string().min(1).optional(),
  tamanho:   z.string().optional().nullable(),
  descricao: z.string().optional(),
  ativo:     z.boolean().optional(),
})

const criarCabineSchema = z.object({
  nome:      z.string().min(1, 'Nome é obrigatório'),
  tamanho:   z.enum(['P', 'M', 'G', 'GG']).optional().nullable(),
  descricao: z.string().optional(),
})

export async function cabinesRoutes(app) {
  async function countCabineDependency(db, table, cabineId, tenantId) {
    try {
      const result = await db.query(
        `SELECT COUNT(*)::int AS total
         FROM ${table}
         WHERE cabine_id = $1 AND tenant_id = $2::uuid`,
        [cabineId, tenantId],
      )
      return Number(result.rows[0]?.total ?? result.rowCount ?? 0)
    } catch (error) {
      if (error.code === '42P01') return 0
      throw error
    }
  }

  // GET /v1/cabines
  app.get('/v1/cabines', { preHandler: cabineRoleAccess(app) }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      // Defesa em profundidade: tenant_id explícito além de RLS — role
      // postgres do Supabase tem BYPASSRLS, queries sem WHERE tenant_id
      // retornariam dados de todos os tenants.
      const result = await db.query(
        `SELECT c.id, c.numero, c.nome,
                CASE WHEN l.id IS NOT NULL THEN 'ao_vivo'
                     WHEN c.status = 'ao_vivo' THEN 'disponivel'
                     ELSE c.status
                END AS status,
                c.status AS status_fisico,
                c.ativo, c.descricao, l.id AS live_real_id, c.live_atual_id AS live_atual_id_legado, c.contrato_id,
                ct.status AS contrato_status,
                COALESCE(${tiktokUsernameSql({ marca: 'm_live', cliente: 'cl_tiktok_live', contrato: 'ct' })}, agenda_next.tiktok_username) AS tiktok_username,
                l.cliente_id AS cliente_id,
                l.cliente_id AS cliente_em_live_id,
                cl_live.nome AS cliente_em_live,
                ct.cliente_id AS cliente_reservado_id,
                cl_reserva.nome AS cliente_reservado,
                agenda_next.cliente_id AS proxima_cliente_id,
                agenda_next.cliente_nome AS proxima_cliente_nome,
                agenda_next.id AS proxima_agenda_id,
                agenda_next.data_inicio AS proxima_agenda_inicio,
                agenda_next.data_fim AS proxima_agenda_fim,
                m_live.id AS marca_id,
                m_live.nome AS marca_nome,
                COALESCE(m_live.logo_url, agenda_next.marca_logo_url) AS marca_logo_url,
                COALESCE(m_live.site, agenda_next.marca_site) AS marca_site,
                agenda_next.marca_id AS proxima_marca_id,
                agenda_next.marca_nome AS proxima_marca_nome,
                u.nome AS apresentador_nome,
                cl_live.nome AS cliente_nome,
                l.iniciado_em,
                COALESCE(ls.viewer_count, 0) AS viewer_count,
                COALESCE(ls.gmv, 0) AS gmv_atual,
                COALESCE(ls.likes_count, 0) AS likes_count,
                COALESCE(ls.comments_count, 0) AS comments_count,
                COALESCE(ls.shares_count, 0) AS shares_count,
                COALESCE(ls.gifts_diamonds, 0) AS gifts_diamonds,
                COALESCE(ls.total_orders, 0) AS total_orders,
                COALESCE(lr_agg.agenda, '[]'::json) AS agenda
         FROM cabines c
         LEFT JOIN contratos ct ON ct.id = c.contrato_id AND ct.tenant_id = c.tenant_id
         LEFT JOIN clientes cl_reserva ON cl_reserva.id = ct.cliente_id AND cl_reserva.tenant_id = c.tenant_id
         LEFT JOIN LATERAL (
           SELECT l2.*
           FROM lives l2
           WHERE l2.cabine_id = c.id
             AND l2.tenant_id = c.tenant_id
             AND l2.status = 'em_andamento'
           ORDER BY (l2.id = c.live_atual_id) DESC, l2.iniciado_em DESC
           LIMIT 1
         ) l ON true
         LEFT JOIN users u ON u.id = l.apresentador_id AND u.tenant_id = c.tenant_id
         LEFT JOIN clientes cl_live ON cl_live.id = l.cliente_id AND cl_live.tenant_id = c.tenant_id
         LEFT JOIN marcas m_live ON m_live.id = l.marca_id AND m_live.tenant_id = c.tenant_id
         LEFT JOIN clientes cl_tiktok_live ON cl_tiktok_live.id = COALESCE(m_live.cliente_id, l.cliente_id, ct.cliente_id) AND cl_tiktok_live.tenant_id = c.tenant_id
         LEFT JOIN LATERAL (
           SELECT viewer_count, gmv, likes_count, comments_count,
                  shares_count, gifts_diamonds, total_orders
           FROM live_snapshots
           WHERE live_id = l.id
             AND tenant_id = c.tenant_id
           ORDER BY captured_at DESC
           LIMIT 1
         ) ls ON true
         LEFT JOIN LATERAL (
           SELECT ae.id,
                  ae.data_inicio,
                  ae.data_fim,
                  ae.marca_id,
                  m.nome AS marca_nome,
                  m.logo_url AS marca_logo_url,
                  m.site AS marca_site,
                  ${tiktokUsernameSql({ marca: 'm', cliente: 'cl2' })} AS tiktok_username,
                  m.cliente_id,
                  cl2.nome AS cliente_nome
           FROM agenda_eventos ae
           JOIN marcas m ON m.id = ae.marca_id AND m.tenant_id = ae.tenant_id
           LEFT JOIN clientes cl2 ON cl2.id = m.cliente_id AND cl2.tenant_id = ae.tenant_id
           WHERE ae.cabine_id = c.id
             AND ae.tenant_id = c.tenant_id
             AND ae.tipo = 'live'
             AND ae.status IN ('planejado', 'confirmado', 'ao_vivo')
             AND ae.data_fim >= NOW()
           ORDER BY ae.data_inicio
           LIMIT 1
         ) agenda_next ON true
         LEFT JOIN LATERAL (
           SELECT COALESCE(json_agg(json_build_object(
             'id', ae.id,
             'data', (ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::date,
             'hora_inicio', (ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::time::text,
             'hora_fim', (ae.data_fim AT TIME ZONE 'America/Sao_Paulo')::time::text,
             'data_inicio', ae.data_inicio,
             'data_fim', ae.data_fim,
             'cliente_nome', cl2.nome,
             'cliente_id', m.cliente_id,
             'marca_id', ae.marca_id,
             'marca_nome', m.nome,
             'marca_logo_url', m.logo_url,
             'tiktok_username', ${tiktokUsernameSql({ marca: 'm', cliente: 'cl2' })},
             'status', ae.status
           ) ORDER BY ae.data_inicio), '[]'::json) AS agenda
           FROM agenda_eventos ae
           JOIN marcas m ON m.id = ae.marca_id AND m.tenant_id = ae.tenant_id
           LEFT JOIN clientes cl2 ON cl2.id = m.cliente_id AND cl2.tenant_id = ae.tenant_id
           WHERE ae.cabine_id = c.id
             AND ae.tenant_id = c.tenant_id
             AND ae.tipo = 'live'
             AND ae.status IN ('planejado', 'confirmado', 'ao_vivo')
             AND ae.data_fim >= NOW()
         ) lr_agg ON true
         WHERE c.tenant_id = $1::uuid
           AND c.ativo IS NOT FALSE
           AND c.deleted_at IS NULL
         ORDER BY c.numero`,
        [tenant_id]
      )

      return result.rows.map(c => ({
        ...c,
        live_atual_id: c.live_real_id ?? null,
        cliente_em_live: c.cliente_em_live
          ? { id: c.cliente_em_live_id, nome: c.cliente_em_live }
          : null,
        cliente_reservado: c.cliente_reservado
          ? { id: c.cliente_reservado_id, nome: c.cliente_reservado }
          : null,
        proxima_agenda: c.proxima_agenda_id
          ? {
              id: c.proxima_agenda_id,
              data_inicio: c.proxima_agenda_inicio,
              data_fim: c.proxima_agenda_fim,
              cliente_id: c.proxima_cliente_id,
              cliente_nome: c.proxima_cliente_nome,
              marca_id: c.proxima_marca_id,
              marca_nome: c.proxima_marca_nome,
              marca_logo_url: c.marca_logo_url,
              tiktok_username: c.tiktok_username,
            }
          : null,
        viewer_count: Number(c.viewer_count ?? 0),
        gmv_atual: Number(c.gmv_atual ?? 0),
        likes_count: Number(c.likes_count ?? 0),
        comments_count: Number(c.comments_count ?? 0),
        shares_count: Number(c.shares_count ?? 0),
        gifts_diamonds: Number(c.gifts_diamonds ?? 0),
        total_orders: Number(c.total_orders ?? 0),
        agenda: c.agenda ?? [],
      }))
    })
  })

  // GET /v1/cabines/fila-ativacao
  app.get('/v1/cabines/fila-ativacao', { preHandler: cabineRoleAccess(app) }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT ct.id,
                ct.cliente_id,
                cl.nome AS cliente_nome,
                cl.cidade,
                cl.estado,
                ct.valor_fixo,
                ct.comissao_pct,
                ct.ativado_em,
                ct.criado_em
         FROM contratos ct
         JOIN clientes cl ON cl.id = ct.cliente_id AND cl.tenant_id = ct.tenant_id
         WHERE ct.tenant_id = $1::uuid
           AND ct.status = 'ativo'
           AND NOT EXISTS (
             SELECT 1
             FROM cabines cb
             WHERE cb.contrato_id = ct.id
           )
         ORDER BY ct.ativado_em DESC NULLS LAST, ct.criado_em DESC`,
        [tenant_id]
      )

      return result.rows.map(r => ({
        ...r,
        valor_fixo: Number(r.valor_fixo ?? 0),
        comissao_pct: Number(r.comissao_pct ?? 0),
      }))
    })
  })

  // POST /v1/cabines — create a new cabine for the authenticated tenant
  app.post('/v1/cabines', {
    preHandler: [app.authenticate, app.requirePapel(WRITE_CABINES)],
  }, async (request, reply) => {
    const parsed = criarCabineSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const { nome, descricao } = parsed.data

    return app.withTenant(tenant_id, async (db) => {
      // Atomic: compute next numero and insert in a single statement to avoid race conditions
      const result = await db.query(
        `INSERT INTO cabines (tenant_id, numero, nome, tamanho, descricao, status)
         SELECT $1, COALESCE(MAX(numero), 0) + 1, $2, $3, $4, 'disponivel'
         FROM cabines
         WHERE tenant_id = $1
         RETURNING id, numero, nome, tamanho, descricao, status, ativo`,
        [tenant_id, nome, null, descricao ?? null]
      )
      app.audit?.log?.(request, { action: 'cabines.create', entity_type: 'cabine', entity_id: result.rows[0].id, metadata: { nome, tamanho: null } })?.catch(err => app.log.error({ err }, 'audit log failed'))
      return reply.code(201).send(result.rows[0])
    })
  })

  // DELETE /v1/cabines/:id — delete a cabine (only if not in use)
  app.delete('/v1/cabines/:id', {
    preHandler: [app.authenticate, app.requirePapel(WRITE_CABINES)],
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const confirmacao = request.query?.confirmacao
    if (confirmacao !== 'CABINE') {
      return reply.code(400).send({
        error: 'Confirmação obrigatória para excluir cabine.',
        code: 'CABINE_CONFIRMATION_REQUIRED',
      })
    }

    return app.withTenant(tenant_id, async (db) => {
      const cabineResult = await db.query(
        `SELECT id, numero, status, live_atual_id, contrato_id
         FROM cabines
         WHERE id = $1 AND tenant_id = $2::uuid
         FOR UPDATE`,
        [request.params.id, tenant_id]
      )
      const cabine = cabineResult.rows[0]

      if (!cabine) return reply.code(404).send({ error: 'Cabine não encontrada' })

      if (cabine.status === 'ao_vivo' || cabine.live_atual_id) {
        return reply.code(409).send({
          error: 'Cabine ao vivo não pode ser excluída.',
          code: 'CABINE_LIVE_ACTIVE',
        })
      }

      if (cabine.contrato_id) {
        return reply.code(409).send({
          error: 'Libere a cabine antes de excluir.',
          code: 'CABINE_HAS_CONTRACT',
        })
      }

      const dependencies = {
        lives: await countCabineDependency(db, 'lives', request.params.id, tenant_id),
        // live_requests migrado para agenda_eventos (migration 106)
        agenda_eventos: await countCabineDependency(db, 'agenda_eventos', request.params.id, tenant_id),
        cabine_eventos: await countCabineDependency(db, 'cabine_eventos', request.params.id, tenant_id),
      }
      const hasHistory = Object.values(dependencies).some((total) => total > 0)
      if (hasHistory) {
        const archived = await db.query(
          `UPDATE cabines
           SET ativo = false,
               status = 'disponivel',
               live_atual_id = NULL,
               contrato_id = NULL,
               deleted_at = NOW(),
               deleted_by = $3
           WHERE id = $1 AND tenant_id = $2::uuid
           RETURNING id, numero, ativo, deleted_at`,
          [request.params.id, tenant_id, request.user.sub ?? null],
        )
        app.audit?.log?.(request, { action: 'cabines.soft_delete', entity_type: 'cabine', entity_id: request.params.id, metadata: { confirmacao } })?.catch(err => app.log.error({ err }, 'audit log failed'))
        return { ok: true, soft_deleted: true, cabine: archived.rows[0], dependencies }
      }

      try {
        await db.query(`DELETE FROM cabines WHERE id = $1 AND tenant_id = $2::uuid RETURNING id`, [request.params.id, tenant_id])
        app.audit?.log?.(request, { action: 'cabines.delete', entity_type: 'cabine', entity_id: request.params.id })?.catch(err => app.log.error({ err }, 'audit log failed'))
        return { ok: true }
      } catch (error) {
        if (error.code === '23503') {
          return reply.code(409).send({
            error: 'Cabine possui vínculos no banco e não pode ser excluída definitivamente.',
            code: 'CABINE_FOREIGN_KEY_DEPENDENCY',
          })
        }
        throw error
      }
    })
  })


  // PATCH /v1/cabines/:id — update name, size, description
  app.patch('/v1/cabines/:id', { preHandler: cabineWriteAccess(app) }, async (request, reply) => {
    const parsed = atualizarCabineSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const updates = parsed.data
    const fields = Object.keys(updates)
    if (fields.length === 0) return reply.code(400).send({ error: 'Nenhum campo para atualizar' })

    const setClauses = fields.map((f, i) => `${f} = $${i + 2}`).join(', ')
    const values = [request.params.id, ...fields.map((f) => f === 'tamanho' ? null : updates[f]), tenant_id]

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE cabines SET ${setClauses} WHERE id = $1 AND tenant_id = $${fields.length + 2} RETURNING id, nome, tamanho, descricao, numero, status, ativo`,
        values
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Cabine não encontrada' })
      app.audit?.log?.(request, { action: 'cabines.update', entity_type: 'cabine', entity_id: request.params.id, metadata: { changed_fields: fields } })?.catch(err => app.log.error({ err }, 'audit log failed'))
      return result.rows[0]
    })
  })

  // PATCH /v1/cabines/:id/reservar
  app.patch('/v1/cabines/:id/reservar', { preHandler: cabineRoleAccess(app) }, async (request, reply) => {
    const parsed = reservarCabineSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id, sub, papel } = request.user
    const { contrato_id, cliente_id, observacao } = parsed.data
    const ip = getRequestIp(request)
    return app.withTenant(tenant_id, async (db) => {
      await db.query('BEGIN')

      try {
        const cabineQ = await db.query(
          `SELECT id, numero, status, contrato_id, live_atual_id
           FROM cabines
           WHERE id = $1 AND tenant_id = $2
           FOR UPDATE`,
          [request.params.id, tenant_id]
        )
        const cabine = cabineQ.rows[0]

        if (!cabine) {
          await db.query('ROLLBACK')
          return reply.code(404).send({ error: 'Cabine não encontrada' })
        }

        if (cabine.status === 'manutencao') {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'Cabine em manutenção não pode ser reservada' })
        }

        if (cabine.status !== 'disponivel') {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'Cabine não está disponível para reserva' })
        }

        if (cabine.live_atual_id) {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'Cabine possui live ativa e não pode ser reservada' })
        }

        // Aviso não-bloqueante: cabine já tem contrato vinculado (dado histórico)
        const avisoContratoExistente = cabine.contrato_id
          ? `Cabine possuía contrato_id ${cabine.contrato_id} que será substituído`
          : null

        // Resolução do contrato a vincular:
        // 1) contrato_id explícito no body → valida e vincula
        // 2) cliente_id no body → busca contrato ativo do cliente
        // 3) nenhum → reserva sem vínculo contratual
        let contratoResolvido = null

        if (contrato_id) {
          const contratoQ = await db.query(
            `SELECT id, cliente_id, status
             FROM contratos
             WHERE id = $1 AND tenant_id = $2
             FOR UPDATE`,
            [contrato_id, tenant_id]
          )
          const contrato = contratoQ.rows[0]

          if (!contrato) {
            await db.query('ROLLBACK')
            return reply.code(404).send({ error: 'Contrato não encontrado para este tenant' })
          }

          if (contrato.status !== 'ativo') {
            await db.query('ROLLBACK')
            return reply.code(409).send({ error: 'Apenas contratos ativos podem reservar cabines' })
          }

          const vinculoExistenteQ = await db.query(
            `SELECT id, numero
             FROM cabines
             WHERE contrato_id = $1 AND id != $2 AND tenant_id = $3
             LIMIT 1`,
            [contrato_id, request.params.id, tenant_id]
          )

          if (vinculoExistenteQ.rows[0]) {
            await db.query('ROLLBACK')
            return reply.code(409).send({ error: 'Contrato já está vinculado a outra cabine' })
          }

          contratoResolvido = contrato
        } else if (cliente_id) {
          const contratoQ = await db.query(
            `SELECT id, cliente_id, status
             FROM contratos
             WHERE cliente_id = $1 AND tenant_id = $2 AND status = 'ativo'
             ORDER BY ativado_em DESC NULLS LAST, criado_em DESC
             LIMIT 1
             FOR UPDATE`,
            [cliente_id, tenant_id]
          )
          const contrato = contratoQ.rows[0]

          if (contrato) {
            const vinculoExistenteQ = await db.query(
              `SELECT id, numero
               FROM cabines
               WHERE contrato_id = $1 AND id != $2 AND tenant_id = $3
               LIMIT 1`,
              [contrato.id, request.params.id, tenant_id]
            )
            // Se o contrato encontrado já está em outra cabine, ignora vínculo mas ainda reserva
            if (!vinculoExistenteQ.rows[0]) {
              contratoResolvido = contrato
            }
          }
          // Se não encontrou contrato ativo para o cliente, segue sem vínculo
        }

        const resolvedContratoId = contratoResolvido?.id ?? null
        const resolvedClienteId = contratoResolvido?.cliente_id ?? cliente_id ?? null

        const result = await db.query(
          `UPDATE cabines
           SET status = 'reservada', contrato_id = $1, live_atual_id = NULL
           WHERE id = $2
           RETURNING id, numero, status, contrato_id`,
          [resolvedContratoId, request.params.id]
        )

        await logCabineEvent(db, {
          tenantId: tenant_id,
          cabineId: request.params.id,
          contratoId: resolvedContratoId,
          tipoEvento: 'cabine_reservada',
          actorUserId: sub,
          actorPapel: papel,
          ip,
          payload: { cliente_id: resolvedClienteId, observacao: observacao ?? null, sem_contrato: !resolvedContratoId },
        })

        await db.query('COMMIT')
        app.audit?.log?.(request, { action: 'cabines.reserve', entity_type: 'cabine', entity_id: request.params.id, metadata: { contrato_id: resolvedContratoId, cliente_id: resolvedClienteId } })?.catch(err => app.log.error({ err }, 'audit log failed'))

        const response = result.rows[0]
        if (avisoContratoExistente) {
          return { ...response, aviso: avisoContratoExistente }
        }
        return response
      } catch (error) {
        await db.query('ROLLBACK')
        throw error
      }
    })
  })

  // PATCH /v1/cabines/:id/liberar
  app.patch('/v1/cabines/:id/liberar', { preHandler: cabineRoleAccess(app) }, async (request, reply) => {
    const { tenant_id, sub, papel } = request.user
    const ip = getRequestIp(request)
    return app.withTenant(tenant_id, async (db) => {
      await db.query('BEGIN')

      try {
        const cabineQ = await db.query(
          `SELECT id, numero, status, contrato_id, live_atual_id
           FROM cabines
           WHERE id = $1 AND tenant_id = $2
           FOR UPDATE`,
          [request.params.id, tenant_id]
        )
        const cabine = cabineQ.rows[0]

        if (!cabine) {
          await db.query('ROLLBACK')
          return reply.code(404).send({ error: 'Cabine não encontrada' })
        }

        // Bloqueia liberação quando há live formalmente em_andamento.
        // Aceita ?force=true (admin/franqueado) pra destravar cabine com estado órfão.
        const forceLiberar = request.query?.force === 'true' || request.query?.force === true
        const podeForcar = ['franqueador_master', 'franqueado', 'gerente'].includes(papel)

        const liveAtivaQ = await db.query(
          `SELECT id FROM lives
           WHERE cabine_id = $1 AND tenant_id = $2::uuid AND status = 'em_andamento'
           LIMIT 1`,
          [request.params.id, tenant_id]
        )
        const liveAtivaId = liveAtivaQ.rows[0]?.id ?? null

        if (liveAtivaId && !(forceLiberar && podeForcar)) {
          await db.query('ROLLBACK')
          return reply.code(409).send({
            error: 'Cabine possui live em andamento — encerre a live antes de liberar',
            code: 'CABINE_LIVE_ATIVA',
            live_id: liveAtivaId,
          })
        }

        // Estado órfão: cabine marcada ao_vivo mas sem live em_andamento real.
        // Permite liberar e registra aviso.
        const avisoLiveAtiva = (cabine.status === 'ao_vivo' || cabine.live_atual_id) && !liveAtivaId
          ? 'Estado órfão detectado: cabine marcada ao vivo sem live em andamento real. Estado normalizado.'
          : (liveAtivaId && forceLiberar)
          ? `Liberação forçada com live ${liveAtivaId} ainda em andamento — verifique encerramento manual.`
          : null

        const result = await db.query(
          `UPDATE cabines
           SET status = 'disponivel', contrato_id = NULL, live_atual_id = NULL
           WHERE id = $1
           RETURNING id, numero, status, contrato_id`,
          [request.params.id]
        )

        if (cabine.contrato_id || cabine.status !== 'disponivel') {
          await logCabineEvent(db, {
            tenantId: tenant_id,
            cabineId: request.params.id,
            contratoId: cabine.contrato_id,
            tipoEvento: 'cabine_liberada',
            actorUserId: sub,
            actorPapel: papel,
            ip,
            payload: { previous_status: cabine.status, tinha_live_ativa: !!avisoLiveAtiva },
          })
        }

        await db.query('COMMIT')

        app.audit?.log?.(request, {
          action: 'liberar_cabine',
          entity_type: 'cabines',
          entity_id: request.params.id,
          metadata: { forcado: forceLiberar },
        }).catch(() => {})

        const response = result.rows[0]
        if (avisoLiveAtiva) {
          return { ...response, aviso: avisoLiveAtiva }
        }
        return response
      } catch (error) {
        await db.query('ROLLBACK')
        throw error
      }
    })
  })

  // GET /v1/cabines/:id/historico?dias=90
  app.get('/v1/cabines/:id/historico', { preHandler: cabineRoleAccess(app) }, async (request, reply) => {
    const { tenant_id } = request.user
    const cabineId = request.params.id
    const raw = parseInt(request.query.dias)
    const dias = isNaN(raw) ? 90 : Math.min(Math.max(raw, 1), 365)

    return app.withTenant(tenant_id, async (db) => {
      const cabineResult = await db.query(`SELECT id FROM cabines WHERE id = $1 AND tenant_id = $2`, [cabineId, tenant_id])
      if (cabineResult.rowCount === 0) {
        return reply.code(404).send({ error: 'Cabine não encontrada' })
      }

      const topClientesQ = await db.query(`
        SELECT cl.nome, SUM(l.fat_gerado) as fat_total, COUNT(l.id) as total_lives
        FROM lives l
        JOIN clientes cl ON cl.id = l.cliente_id AND cl.tenant_id = l.tenant_id
        WHERE l.cabine_id = $1
          AND l.tenant_id = $3::uuid
          AND l.status = 'encerrada'
          AND l.iniciado_em > NOW() - ($2 * interval '1 day')
        GROUP BY cl.id, cl.nome
        ORDER BY fat_total DESC
        LIMIT 5
      `, [cabineId, dias, tenant_id])

      const melhoresHorariosQ = await db.query(`
        SELECT
          EXTRACT(HOUR FROM iniciado_em) AS hora,
          COUNT(*) AS total_lives,
          AVG(fat_gerado) AS gmv_medio,
          SUM(fat_gerado) AS gmv_total
        FROM lives
        WHERE cabine_id = $1
          AND tenant_id = $3::uuid
          AND status = 'encerrada'
          AND iniciado_em > NOW() - ($2 * interval '1 day')
        GROUP BY hora
        ORDER BY gmv_medio DESC
      `, [cabineId, dias, tenant_id])

      const desempenhoMensalQ = await db.query(`
        SELECT
          EXTRACT(MONTH FROM iniciado_em) as mes,
          EXTRACT(YEAR FROM iniciado_em) as ano,
          SUM(fat_gerado) as fat_total,
          COUNT(id) as total_lives
        FROM lives
        WHERE cabine_id = $1 AND tenant_id = $2::uuid AND status = 'encerrada'
        GROUP BY ano, mes
        ORDER BY ano DESC, mes DESC
        LIMIT 6
      `, [cabineId, tenant_id])

      const desempenho = desempenhoMensalQ.rows
      let crescimento_pct = 0

      if (desempenho.length >= 2) {
        const atual = parseFloat(desempenho[0].fat_total)
        const anterior = parseFloat(desempenho[1].fat_total)
        if (anterior > 0) {
          crescimento_pct = ((atual - anterior) / anterior) * 100
        }
      }

      const totaisQ = await db.query(`
        SELECT COUNT(id) as total_lives, SUM(fat_gerado) as gmv_total
        FROM lives WHERE cabine_id = $1 AND tenant_id = $2::uuid AND status = 'encerrada'
      `, [cabineId, tenant_id])

      const livesRecentesQ = await db.query(`
        SELECT
          l.id,
          l.iniciado_em,
          l.encerrado_em,
          l.fat_gerado,
          l.final_total_likes,
          l.final_total_comments,
          l.final_total_shares,
          l.final_peak_viewers,
          l.final_orders_count,
          cl.nome AS cliente_nome,
          EXTRACT(EPOCH FROM (l.encerrado_em - l.iniciado_em)) / 60 AS duracao_minutos
        FROM lives l
        LEFT JOIN clientes cl ON cl.id = l.cliente_id AND cl.tenant_id = l.tenant_id
        WHERE l.cabine_id = $1
          AND l.tenant_id = $3::uuid
          AND l.status = 'encerrada'
          AND l.iniciado_em > NOW() - ($2 * interval '1 day')
        ORDER BY l.iniciado_em DESC
        LIMIT 50
      `, [cabineId, dias, tenant_id])

      return {
        top_clientes: topClientesQ.rows.map((r) => ({
          nome: r.nome,
          fat_total: parseFloat(r.fat_total),
          total_lives: parseInt(r.total_lives),
        })),
        melhores_horarios: melhoresHorariosQ.rows.map((r) => ({
          hora: `${String(r.hora).padStart(2, '0')}h - ${String(parseInt(r.hora) + 2).padStart(2, '0')}h`,
          total_lives: parseInt(r.total_lives),
          gmv_medio: parseFloat(r.gmv_medio),
          gmv_total: parseFloat(r.gmv_total),
        })),
        desempenho_mensal: {
          meses: desempenho.map((r) => ({
            mes: `${r.mes}/${r.ano}`,
            fat_total: parseFloat(r.fat_total),
            total_lives: parseInt(r.total_lives),
          })),
          crescimento_pct: parseFloat(crescimento_pct.toFixed(1)),
        },
        totais: {
          total_lives: parseInt(totaisQ.rows[0].total_lives || 0),
          gmv_total: parseFloat(totaisQ.rows[0].gmv_total || 0),
        },
        lives_recentes: livesRecentesQ.rows.map((r) => ({
          id: r.id,
          iniciado_em: r.iniciado_em,
          encerrado_em: r.encerrado_em,
          fat_gerado: parseFloat(r.fat_gerado || 0),
          final_total_likes: parseInt(r.final_total_likes || 0),
          final_total_comments: parseInt(r.final_total_comments || 0),
          final_total_shares: parseInt(r.final_total_shares || 0),
          final_peak_viewers: parseInt(r.final_peak_viewers || 0),
          final_orders_count: parseInt(r.final_orders_count || 0),
          cliente_nome: r.cliente_nome,
          duracao_minutos: Math.round(parseFloat(r.duracao_minutos || 0)),
        })),
      }
    })
  })

  // GET /v1/cabines/:id/live-atual
  app.get('/v1/cabines/:id/live-atual', { preHandler: cabineRoleAccess(app) }, async (request, reply) => {
    const { tenant_id } = request.user
    const cabineId = request.params.id

    return app.withTenant(tenant_id, async (db) => {
      const cabineQ = await db.query(`SELECT live_atual_id, status FROM cabines WHERE id = $1 AND tenant_id = $2`, [cabineId, tenant_id])
      const cabine = cabineQ.rows[0]

      if (!cabine) return reply.code(404).send({ error: 'Cabine não encontrada' })

      // Busca live em andamento vinculada a essa cabine — fonte única da verdade
      // (não depende de cabine.status nem de cabine.live_atual_id estar setado)
      const liveQSearch = await db.query(`
        SELECT id FROM lives
        WHERE cabine_id = $1 AND tenant_id = $2 AND status = 'em_andamento'
        ORDER BY iniciado_em DESC LIMIT 1
      `, [cabineId, tenant_id])

      let liveId = liveQSearch.rows[0]?.id
      request.log?.info(
        { cabineId, cabineStatus: cabine.status, cabineLiveAtualId: cabine.live_atual_id, liveEncontrada: liveId },
        'live-atual: lookup'
      )

      if (!liveId) {
        // Nenhuma live em_andamento para essa cabine — auto-corrige status se estava ao_vivo sem live
        if (cabine.status === 'ao_vivo' || cabine.live_atual_id) {
          await db.query(
            `UPDATE cabines SET status = 'disponivel', live_atual_id = NULL WHERE id = $1 AND tenant_id = $2`,
            [cabineId, tenant_id]
          )
          request.log?.warn({ cabineId }, 'live-atual: cabine estava ao_vivo sem live em_andamento → normalizada para disponivel')
        }
        return reply.code(200).send({ live_ativa: false, message: 'Nenhuma live ativa nesta cabine' })
      }

      // Se achou live mas cabine não estava linkada, sincroniza
      if (cabine.live_atual_id !== liveId || cabine.status !== 'ao_vivo') {
        await db.query(
          `UPDATE cabines SET live_atual_id = $1, status = 'ao_vivo' WHERE id = $2 AND tenant_id = $3`,
          [liveId, cabineId, tenant_id]
        )
        request.log?.info({ cabineId, liveId }, 'live-atual: cabine sincronizada com live em andamento')
      }

      const liveQ = await db.query(`
        SELECT l.iniciado_em, l.fat_gerado,
               l.marca_id,
               c.contrato_id,
               u.nome AS apresentador_nome,
               cl.nome AS cliente_nome,
               m.nome AS marca_nome,
               m.logo_url AS marca_logo_url,
               ${tiktokUsernameSql({ marca: 'm', cliente: 'cl_tiktok', contrato: 'ct' })} AS tiktok_username
        FROM lives l
        LEFT JOIN cabines c ON c.id = l.cabine_id AND c.tenant_id = l.tenant_id
        LEFT JOIN users u ON u.id = l.apresentador_id AND u.tenant_id = l.tenant_id
        LEFT JOIN clientes cl ON cl.id = l.cliente_id AND cl.tenant_id = l.tenant_id
        LEFT JOIN contratos ct ON ct.id = c.contrato_id AND ct.tenant_id = l.tenant_id
        LEFT JOIN LATERAL (
          SELECT m2.id, m2.nome, m2.tipo, m2.cliente_id, m2.logo_url, m2.tiktok_username
          FROM marcas m2
          WHERE m2.tenant_id = l.tenant_id
            AND (
              m2.id = l.marca_id
              OR (
                l.marca_id IS NULL
                AND m2.cliente_id = l.cliente_id
                AND m2.status = 'ativa'
              )
            )
          ORDER BY CASE WHEN m2.id = l.marca_id THEN 0 ELSE 1 END, m2.criado_em ASC
          LIMIT 1
        ) m ON true
        LEFT JOIN clientes cl_tiktok ON cl_tiktok.id = COALESCE(m.cliente_id, l.cliente_id, ct.cliente_id) AND cl_tiktok.tenant_id = l.tenant_id
        WHERE l.id = $1 AND l.tenant_id = $2
      `, [liveId, tenant_id])
      const liveData = liveQ.rows[0]

      // Defesa: se por algum motivo a live sumiu entre o SELECT anterior e este,
      // tratamos como sem live ativa em vez de retornar 500.
      if (!liveData) {
        request.log?.warn({ liveId, cabineId }, 'live-atual: live desapareceu entre queries')
        return reply.code(200).send({ live_ativa: false, message: 'Live não encontrada' })
      }

      const snapshotQ = await db.query(`
        SELECT viewer_count, total_viewers, total_orders, gmv,
               likes_count, comments_count, gifts_diamonds, shares_count, captured_at
        FROM live_snapshots
        WHERE live_id = $1 AND tenant_id = $2
        ORDER BY captured_at DESC LIMIT 1
      `, [liveId, tenant_id])
      const snapshot = snapshotQ.rows[0] || {
        viewer_count: 0, total_viewers: 0, total_orders: 0, gmv: 0,
        likes_count: 0, comments_count: 0, gifts_diamonds: 0, shares_count: 0,
      }

      const topProdutoQ = await db.query(`
        SELECT produto_nome, quantidade, valor_total
        FROM live_products
        WHERE live_id = $1 AND tenant_id = $2
        ORDER BY quantidade DESC LIMIT 1
      `, [liveId, tenant_id])
      const topProduto = topProdutoQ.rows[0]

      const iniciadoEm = new Date(liveData.iniciado_em)
      const agora = new Date()
      const duracaoMinutos = Math.floor((agora - iniciadoEm) / 1000 / 60)

      return {
        live_ativa: true,
        live_id: liveId,
        contrato_id: liveData.contrato_id ?? null,
        tiktok_username: liveData.tiktok_username ?? null,
        viewer_count: Number(snapshot.viewer_count ?? 0),
        total_viewers: Number(snapshot.total_viewers ?? 0),
        gmv_atual: parseFloat(snapshot.gmv ?? 0),
        total_orders: Number(snapshot.total_orders ?? 0),
        likes_count: Number(snapshot.likes_count ?? 0),
        comments_count: Number(snapshot.comments_count ?? 0),
        gifts_diamonds: Number(snapshot.gifts_diamonds ?? 0),
        shares_count: Number(snapshot.shares_count ?? 0),
        duracao_minutos: duracaoMinutos,
        cliente_nome: liveData.cliente_nome ?? '',
        marca_id: liveData.marca_id ?? null,
        marca_nome: liveData.marca_nome ?? '',
        marca_logo_url: liveData.marca_logo_url ?? null,
        apresentador_nome: liveData.apresentador_nome ?? '',
        iniciado_em: liveData.iniciado_em,
        top_produto: topProduto ? {
          nome: topProduto.produto_nome,
          quantidade: topProduto.quantidade,
          valor_total: parseFloat(topProduto.valor_total),
        } : null,
      }
    })
  })

  // ── POST /v1/cabines/:id/closer-notification ──────────────────────────────
  // Gerente/Franqueado envia uma mensagem/dica para o closer da cabine.
  // A mensagem é emitida via EventEmitter para o canal SSE do apresentador.
  app.post('/v1/cabines/:id/closer-notification', {
    preHandler: [app.authenticate, app.requirePapel(WRITE_LIVES)],
  }, async (request, reply) => {
    const { message, type = 'custom' } = request.body ?? {}
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return reply.code(400).send({ error: 'message é obrigatório' })
    }
    if (message.length > 500) {
      return reply.code(400).send({ error: 'mensagem excede 500 caracteres' })
    }

    const { tenant_id, sub: fromUserId } = request.user
    const cabineId = request.params.id

    return app.withTenant(tenant_id, async (db) => {
      // Valida que cabine existe e está ao vivo
      const { rows } = await db.query(
        `SELECT c.live_atual_id, l.apresentador_id
         FROM cabines c
         LEFT JOIN lives l ON l.id = c.live_atual_id AND l.tenant_id = c.tenant_id
         WHERE c.id = $1 AND c.tenant_id = $2`,
        [cabineId, tenant_id]
      )
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Cabine não encontrada' })
      }
      const live = rows[0]

      const notification = {
        id: crypto.randomUUID(),
        cabine_id: cabineId,
        live_id: live.live_atual_id ?? null,
        apresentador_id: live.apresentador_id ?? null,
        from_user_id: fromUserId,
        type,
        message: message.trim(),
        ts: Date.now(),
      }

      // Emite via EventEmitter — SSE do apresentador escuta `closer:${cabineId}`
      const { getEmitter } = await import('../services/tiktok-connector-manager.js')
      getEmitter().emit(`closer:${cabineId}`, notification)
      if (live.apresentador_id) {
        getEmitter().emit(`closer-user:${live.apresentador_id}`, notification)
      }

      request.log?.info({ cabineId, type, message: notification.message.slice(0, 60) },
        'closer-notification enviada')
      return reply.send({ ok: true, notification })
    })
  })

  // ── GET /v1/cabines/:id/closer-notifications/stream ──────────────────────
  // SSE para o apresentador receber mensagens do gerente em tempo real.
  app.get('/v1/cabines/:id/closer-notifications/stream', {
    preHandler: [app.authenticate, app.requirePapel(READ_LIVES)],
  }, async (request, reply) => {
    const cabineId = request.params.id

    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': request.headers.origin ?? '*',
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin',
    })
    reply.raw.flushHeaders()

    const { getEmitter } = await import('../services/tiktok-connector-manager.js')
    const emitter = getEmitter()
    const eventName = `closer:${cabineId}`
    const handler = (evt) => {
      if (reply.raw.destroyed) return
      try {
        reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`)
      } catch {
        emitter.off(eventName, handler)
      }
    }
    emitter.on(eventName, handler)

    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': keep-alive\n\n')
    }, 15_000)

    await new Promise((resolve) => {
      request.raw.once('close', resolve)
      request.raw.once('error', resolve)
    })

    emitter.off(eventName, handler)
    clearInterval(heartbeat)
    try { reply.raw.end() } catch {}
  })

  // PATCH /v1/cabines/:id/status
  app.patch('/v1/cabines/:id/status', { preHandler: cabineWriteAccess(app) }, async (request, reply) => {
    const parsed = atualizarStatusSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id, sub, papel } = request.user
    const { status } = parsed.data
    const ip = getRequestIp(request)
    return app.withTenant(tenant_id, async (db) => {
      await db.query('BEGIN')

      try {
        const cabineQ = await db.query(
          `SELECT id, numero, status, contrato_id, live_atual_id
           FROM cabines
           WHERE id = $1 AND tenant_id = $2
           FOR UPDATE`,
          [request.params.id, tenant_id]
        )
        const cabine = cabineQ.rows[0]

        if (!cabine) {
          await db.query('ROLLBACK')
          return reply.code(404).send({ error: 'Cabine não encontrada' })
        }

        if (cabine.live_atual_id || cabine.status === 'ao_vivo') {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'Cabine ao vivo não pode ter o status alterado manualmente' })
        }

        const result = await db.query(
          `UPDATE cabines SET status = $1 WHERE id = $2 AND tenant_id = $3::uuid RETURNING id, numero, status, contrato_id, ativo`,
          [status, request.params.id, tenant_id]
        )

        if (status !== cabine.status) {
          await logCabineEvent(db, {
            tenantId: tenant_id,
            cabineId: request.params.id,
            contratoId: cabine.contrato_id,
            tipoEvento: status === 'manutencao'
              ? 'cabine_manutencao'
              : 'cabine_liberada',
            actorUserId: sub,
            actorPapel: papel,
            ip,
            payload: { previous_status: cabine.status, next_status: status },
          })
        }

        await db.query('COMMIT')

        app.audit?.log?.(request, {
          action: 'alterar_status_cabine',
          entity_type: 'cabines',
          entity_id: request.params.id,
          metadata: { status_anterior: cabine.status, status_novo: status },
        }).catch(() => {})

        return result.rows[0]
      } catch (error) {
        await db.query('ROLLBACK')
        throw error
      }
    })
  })

  // GET /v1/cabines/:id/ultimas-metricas
  app.get('/v1/cabines/:id/ultimas-metricas', { preHandler: cabineRoleAccess(app) }, async (request, reply) => {
    const { tenant_id } = request.user
    const { id } = request.params

    return app.withTenant(tenant_id, async (db) => {
      const { rows } = await db.query(`
        SELECT
          ROUND(AVG(fat_gerado)::numeric, 2) AS avg_fat_gerado,
          ROUND(AVG(qtd_pedidos)::numeric, 0)::int AS avg_qtd_pedidos,
          ROUND(AVG(manual_views)::numeric, 0)::int AS avg_views,
          ROUND(AVG(manual_likes)::numeric, 0)::int AS avg_likes,
          ROUND(AVG(manual_comments)::numeric, 0)::int AS avg_comments,
          ROUND(AVG(manual_shares)::numeric, 0)::int AS avg_shares,
          COUNT(*)::int AS amostra
        FROM (
          SELECT fat_gerado, qtd_pedidos, manual_views, manual_likes, manual_comments, manual_shares
          FROM lives
          WHERE tenant_id = $1::uuid
            AND cabine_id = $2::uuid
            AND status = 'encerrada'
            AND fat_gerado IS NOT NULL
          ORDER BY encerrado_em DESC NULLS LAST
          LIMIT 5
        ) ult
      `, [tenant_id, id])

      return rows[0] ?? {}
    })
  })

}
