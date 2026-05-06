import crypto from 'node:crypto'
import { z } from 'zod'
import { has as managerHas, stopConnector, syncLives } from '../services/tiktok-connector-manager.js'

const cabineRoleAccess = (app) => [
  app.authenticate,
  app.requirePapel(['franqueador_master', 'franqueado', 'gerente', 'apresentador']),
]

const reservarCabineSchema = z.object({
  contrato_id: z.string().uuid(),
})

const iniciarLiveSchema = z.object({
  cabine_id: z.string().uuid(),
})

const encerrarSchema = z.object({
  fat_gerado: z.number().min(0),
})

const liveManualSchema = z.object({
  cabine_id:        z.string().uuid(),
  cliente_id:       z.string().uuid(),
  apresentador_id:  z.string().uuid(),
  apresentador2_id: z.string().uuid().optional(),
  gestor_id:        z.string().uuid(),
  data:             z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hora_inicio:      z.string().regex(/^\d{2}:\d{2}$/),
  hora_fim:         z.string().regex(/^\d{2}:\d{2}$/),
  fat_gerado:       z.number().min(0),
  qtd_pedidos:      z.number().int().min(0),
  resumo:           z.string().max(2000).optional(),
}).refine(d => d.hora_fim > d.hora_inicio, {
  message: 'hora_fim deve ser maior que hora_inicio',
}).refine(d => !d.apresentador2_id || d.apresentador2_id !== d.apresentador_id, {
  message: 'apresentadora 2 deve ser diferente da apresentadora 1',
})

const liveManualEditSchema = z.object({
  cabine_id:        z.string().uuid().optional(),
  cliente_id:       z.string().uuid().optional(),
  apresentador_id:  z.string().uuid().optional(),
  apresentador2_id: z.string().uuid().nullable().optional(),
  gestor_id:        z.string().uuid().optional(),
  data:             z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  hora_inicio:      z.string().regex(/^\d{2}:\d{2}$/).optional(),
  hora_fim:         z.string().regex(/^\d{2}:\d{2}$/).optional(),
  fat_gerado:       z.number().min(0).optional(),
  qtd_pedidos:      z.number().int().min(0).optional(),
  resumo:           z.string().max(2000).optional(),
})

const atualizarStatusSchema = z.object({
  status: z.enum(['disponivel', 'ativa', 'manutencao']),
})

const atualizarCabineSchema = z.object({
  nome:      z.string().min(1).optional(),
  tamanho:   z.string().optional(),
  descricao: z.string().optional(),
})

const criarCabineSchema = z.object({
  nome:      z.string().min(1, 'Nome é obrigatório'),
  tamanho:   z.enum(['P', 'M', 'G', 'GG'], { required_error: 'Tamanho é obrigatório' }),
  descricao: z.string().optional(),
})

function getRequestIp(request) {
  const forwardedFor = request.headers['x-forwarded-for']
  if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
    return forwardedFor.split(',')[0].trim()
  }

  return request.socket?.remoteAddress ?? null
}

async function logCabineEvent(db, {
  tenantId,
  cabineId,
  contratoId = null,
  tipoEvento,
  actorUserId = null,
  actorPapel = null,
  ip = null,
  payload = {},
}) {
  await db.query(
    `INSERT INTO cabine_eventos (
      tenant_id,
      cabine_id,
      contrato_id,
      tipo_evento,
      actor_user_id,
      actor_papel,
      ip,
      payload_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      tenantId,
      cabineId,
      contratoId,
      tipoEvento,
      actorUserId,
      actorPapel,
      ip,
      JSON.stringify(payload),
    ]
  )
}

export async function cabinesRoutes(app) {

  // GET /v1/cabines
  app.get('/v1/cabines', { preHandler: cabineRoleAccess(app) }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT c.id, c.numero, c.status, c.live_atual_id, c.contrato_id,
                ct.tiktok_username,
                COALESCE(l.cliente_id, ct.cliente_id) AS cliente_id,
                u.nome AS apresentador_nome,
                cl.nome AS cliente_nome,
                l.iniciado_em,
                COALESCE(ls.viewer_count, 0) AS viewer_count,
                COALESCE(ls.gmv, 0) AS gmv_atual,
                COALESCE(ls.likes_count, 0) AS likes_count,
                COALESCE(ls.comments_count, 0) AS comments_count,
                COALESCE(ls.shares_count, 0) AS shares_count,
                COALESCE(ls.gifts_diamonds, 0) AS gifts_diamonds,
                COALESCE(ls.total_orders, 0) AS total_orders
         FROM cabines c
         LEFT JOIN contratos ct ON ct.id = c.contrato_id
         LEFT JOIN lives l ON l.id = c.live_atual_id
         LEFT JOIN users u ON u.id = l.apresentador_id
         LEFT JOIN clientes cl ON cl.id = COALESCE(l.cliente_id, ct.cliente_id)
         LEFT JOIN LATERAL (
           SELECT viewer_count, gmv, likes_count, comments_count,
                  shares_count, gifts_diamonds, total_orders
           FROM live_snapshots
           WHERE live_id = c.live_atual_id
           ORDER BY captured_at DESC
           LIMIT 1
         ) ls ON true
         ORDER BY c.numero`
      )

      return result.rows.map(c => ({
        ...c,
        viewer_count: Number(c.viewer_count ?? 0),
        gmv_atual: Number(c.gmv_atual ?? 0),
        likes_count: Number(c.likes_count ?? 0),
        comments_count: Number(c.comments_count ?? 0),
        shares_count: Number(c.shares_count ?? 0),
        gifts_diamonds: Number(c.gifts_diamonds ?? 0),
        total_orders: Number(c.total_orders ?? 0),
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
         JOIN clientes cl ON cl.id = ct.cliente_id
         WHERE ct.status = 'ativo'
           AND NOT EXISTS (
             SELECT 1
             FROM cabines cb
             WHERE cb.contrato_id = ct.id
           )
         ORDER BY ct.ativado_em DESC NULLS LAST, ct.criado_em DESC`
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
    preHandler: [app.authenticate, app.requirePapel(['franqueado', 'franqueador_master'])],
  }, async (request, reply) => {
    const parsed = criarCabineSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const { nome, tamanho, descricao } = parsed.data

    return app.withTenant(tenant_id, async (db) => {
      // Atomic: compute next numero and insert in a single statement to avoid race conditions
      const result = await db.query(
        `INSERT INTO cabines (tenant_id, numero, nome, tamanho, descricao, status)
         SELECT $1, COALESCE(MAX(numero), 0) + 1, $2, $3, $4, 'disponivel'
         FROM cabines
         WHERE tenant_id = $1
         RETURNING id, numero, nome, tamanho, descricao, status, criado_em`,
        [tenant_id, nome, tamanho ?? null, descricao ?? null]
      )
      return reply.code(201).send(result.rows[0])
    })
  })

  // DELETE /v1/cabines/:id — delete a cabine (only if not in use)
  app.delete('/v1/cabines/:id', {
    preHandler: [app.authenticate, app.requirePapel(['franqueado', 'franqueador_master'])],
  }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const cabineResult = await db.query(
        `SELECT id, status, live_atual_id, contrato_id FROM cabines WHERE id = $1`,
        [request.params.id]
      )
      const cabine = cabineResult.rows[0]

      if (!cabine) return reply.code(404).send({ error: 'Cabine não encontrada' })

      if (cabine.status === 'ao_vivo' || cabine.live_atual_id) {
        return reply.code(409).send({ error: 'Cabine ao vivo não pode ser deletada' })
      }

      if (cabine.contrato_id) {
        return reply.code(409).send({ error: 'Libere a cabine antes de deletá-la' })
      }

      // Check FK refs: lives and solicitacoes
      const [livesRef, solRef] = await Promise.all([
        db.query(`SELECT id FROM lives WHERE cabine_id = $1 LIMIT 1`, [request.params.id]),
        db.query(`SELECT id FROM solicitacoes WHERE cabine_id = $1 LIMIT 1`, [request.params.id]),
      ])
      if (livesRef.rowCount > 0) {
        return reply.code(409).send({ error: 'Cabine possui histórico de lives. Não pode ser deletada.' })
      }
      if (solRef.rowCount > 0) {
        return reply.code(409).send({ error: 'Cabine possui solicitações vinculadas. Remova-as primeiro.' })
      }

      await db.query(`DELETE FROM cabines WHERE id = $1`, [request.params.id])
      return { ok: true }
    })
  })


  // PATCH /v1/cabines/:id — update name, size, description
  app.patch('/v1/cabines/:id', { preHandler: cabineRoleAccess(app) }, async (request, reply) => {
    const parsed = atualizarCabineSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const updates = parsed.data
    const fields = Object.keys(updates)
    if (fields.length === 0) return reply.code(400).send({ error: 'Nenhum campo para atualizar' })

    const setClauses = fields.map((f, i) => `${f} = $${i + 2}`).join(', ')
    const values = [request.params.id, ...fields.map((f) => updates[f])]

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE cabines SET ${setClauses} WHERE id = $1 RETURNING id, nome, tamanho, descricao, numero`,
        values
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Cabine não encontrada' })
      return result.rows[0]
    })
  })

  // PATCH /v1/cabines/:id/reservar
  app.patch('/v1/cabines/:id/reservar', { preHandler: cabineRoleAccess(app) }, async (request, reply) => {
    const parsed = reservarCabineSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id, sub, papel } = request.user
    const { contrato_id } = parsed.data
    const ip = getRequestIp(request)
    return app.withTenant(tenant_id, async (db) => {
      await db.query('BEGIN')

      try {
        const cabineQ = await db.query(
          `SELECT id, numero, status, contrato_id, live_atual_id
           FROM cabines
           WHERE id = $1
           FOR UPDATE`,
          [request.params.id]
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

        if (cabine.status !== 'disponivel' || cabine.contrato_id || cabine.live_atual_id) {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'Cabine não está disponível para reserva' })
        }

        const contratoQ = await db.query(
          `SELECT id, cliente_id, status
           FROM contratos
           WHERE id = $1
           FOR UPDATE`,
          [contrato_id]
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
           WHERE contrato_id = $1
           LIMIT 1`,
          [contrato_id]
        )

        if (vinculoExistenteQ.rows[0]) {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'Contrato já está vinculado a outra cabine' })
        }

        const result = await db.query(
          `UPDATE cabines
           SET status = 'reservada', contrato_id = $1, live_atual_id = NULL
           WHERE id = $2
           RETURNING id, numero, status, contrato_id`,
          [contrato_id, request.params.id]
        )

        await logCabineEvent(db, {
          tenantId: tenant_id,
          cabineId: request.params.id,
          contratoId: contrato_id,
          tipoEvento: 'cabine_reservada',
          actorUserId: sub,
          actorPapel: papel,
          ip,
          payload: { cliente_id: contrato.cliente_id },
        })

        await db.query('COMMIT')
        return result.rows[0]
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
           WHERE id = $1
           FOR UPDATE`,
          [request.params.id]
        )
        const cabine = cabineQ.rows[0]

        if (!cabine) {
          await db.query('ROLLBACK')
          return reply.code(404).send({ error: 'Cabine não encontrada' })
        }

        if (cabine.status === 'ao_vivo' || cabine.live_atual_id) {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'Encerre a live antes de liberar a cabine' })
        }

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
            payload: { previous_status: cabine.status },
          })
        }

        await db.query('COMMIT')
        return result.rows[0]
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
      const cabineResult = await db.query(`SELECT id FROM cabines WHERE id = $1`, [cabineId])
      if (cabineResult.rowCount === 0) {
        return reply.code(404).send({ error: 'Cabine não encontrada' })
      }

      const topClientesQ = await db.query(`
        SELECT cl.nome, SUM(l.fat_gerado) as fat_total, COUNT(l.id) as total_lives
        FROM lives l
        JOIN clientes cl ON cl.id = l.cliente_id
        WHERE l.cabine_id = $1
          AND l.status = 'encerrada'
          AND l.iniciado_em > NOW() - ($2 * interval '1 day')
        GROUP BY cl.id, cl.nome
        ORDER BY fat_total DESC
        LIMIT 5
      `, [cabineId, dias])

      const melhoresHorariosQ = await db.query(`
        SELECT
          EXTRACT(HOUR FROM iniciado_em) AS hora,
          COUNT(*) AS total_lives,
          AVG(fat_gerado) AS gmv_medio,
          SUM(fat_gerado) AS gmv_total
        FROM lives
        WHERE cabine_id = $1
          AND status = 'encerrada'
          AND iniciado_em > NOW() - ($2 * interval '1 day')
        GROUP BY hora
        ORDER BY gmv_medio DESC
      `, [cabineId, dias])

      const desempenhoMensalQ = await db.query(`
        SELECT
          EXTRACT(MONTH FROM iniciado_em) as mes,
          EXTRACT(YEAR FROM iniciado_em) as ano,
          SUM(fat_gerado) as fat_total,
          COUNT(id) as total_lives
        FROM lives
        WHERE cabine_id = $1 AND status = 'encerrada'
        GROUP BY ano, mes
        ORDER BY ano DESC, mes DESC
        LIMIT 6
      `, [cabineId])

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
        FROM lives WHERE cabine_id = $1 AND status = 'encerrada'
      `, [cabineId])

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
      }
    })
  })

  // GET /v1/cabines/:id/live-atual
  app.get('/v1/cabines/:id/live-atual', { preHandler: cabineRoleAccess(app) }, async (request, reply) => {
    const { tenant_id } = request.user
    const cabineId = request.params.id

    return app.withTenant(tenant_id, async (db) => {
      const cabineQ = await db.query(`SELECT live_atual_id, status FROM cabines WHERE id = $1`, [cabineId])
      const cabine = cabineQ.rows[0]

      if (!cabine) return reply.code(404).send({ error: 'Cabine não encontrada' })

      // Busca live em andamento vinculada a essa cabine — fonte única da verdade
      // (não depende de cabine.status nem de cabine.live_atual_id estar setado)
      const liveQSearch = await db.query(`
        SELECT id FROM lives
        WHERE cabine_id = $1 AND status = 'em_andamento'
        ORDER BY iniciado_em DESC LIMIT 1
      `, [cabineId])

      let liveId = liveQSearch.rows[0]?.id
      request.log?.info(
        { cabineId, cabineStatus: cabine.status, cabineLiveAtualId: cabine.live_atual_id, liveEncontrada: liveId },
        'live-atual: lookup'
      )

      if (!liveId) {
        // Nenhuma live em_andamento para essa cabine — auto-corrige status se estava ao_vivo sem live
        if (cabine.status === 'ao_vivo' || cabine.live_atual_id) {
          await db.query(
            `UPDATE cabines SET status = 'disponivel', live_atual_id = NULL WHERE id = $1`,
            [cabineId]
          )
          request.log?.warn({ cabineId }, 'live-atual: cabine estava ao_vivo sem live em_andamento → normalizada para disponivel')
        }
        return reply.code(200).send({ live_ativa: false, message: 'Nenhuma live ativa nesta cabine' })
      }

      // Se achou live mas cabine não estava linkada, sincroniza
      if (cabine.live_atual_id !== liveId || cabine.status !== 'ao_vivo') {
        await db.query(
          `UPDATE cabines SET live_atual_id = $1, status = 'ao_vivo' WHERE id = $2`,
          [liveId, cabineId]
        )
        request.log?.info({ cabineId, liveId }, 'live-atual: cabine sincronizada com live em andamento')
      }

      const liveQ = await db.query(`
        SELECT l.iniciado_em, l.fat_gerado,
               c.contrato_id,
               u.nome AS apresentador_nome,
               cl.nome AS cliente_nome,
               ct.tiktok_username
        FROM lives l
        LEFT JOIN cabines c ON c.id = l.cabine_id
        LEFT JOIN users u ON u.id = l.apresentador_id
        LEFT JOIN clientes cl ON cl.id = l.cliente_id
        LEFT JOIN contratos ct ON ct.id = c.contrato_id
        WHERE l.id = $1
      `, [liveId])
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
        WHERE live_id = $1
        ORDER BY captured_at DESC LIMIT 1
      `, [liveId])
      const snapshot = snapshotQ.rows[0] || {
        viewer_count: 0, total_viewers: 0, total_orders: 0, gmv: 0,
        likes_count: 0, comments_count: 0, gifts_diamonds: 0, shares_count: 0,
      }

      const topProdutoQ = await db.query(`
        SELECT produto_nome, quantidade, valor_total
        FROM live_products
        WHERE live_id = $1
        ORDER BY quantidade DESC LIMIT 1
      `, [liveId])
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
    preHandler: [app.authenticate, app.requirePapel(['franqueado', 'franqueador_master', 'gerente'])],
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
         LEFT JOIN lives l ON l.id = c.live_atual_id
         WHERE c.id = $1`,
        [cabineId]
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
    preHandler: [app.authenticate, app.requirePapel(['apresentador', 'franqueado', 'franqueador_master', 'gerente'])],
  }, async (request, reply) => {
    const cabineId = request.params.id

    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
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
  app.patch('/v1/cabines/:id/status', { preHandler: cabineRoleAccess(app) }, async (request, reply) => {
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
           WHERE id = $1
           FOR UPDATE`,
          [request.params.id]
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

        if (status === 'disponivel' && cabine.contrato_id) {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'Use liberar para remover o vínculo contratual da cabine' })
        }

        if (status === 'manutencao' && cabine.contrato_id) {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'Libere a cabine antes de colocá-la em manutenção' })
        }

        if (status === 'ativa' && !cabine.contrato_id) {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'Cabine sem contrato não pode ser marcada como ativa' })
        }

        const result = await db.query(
          `UPDATE cabines SET status = $1 WHERE id = $2 RETURNING id, numero, status, contrato_id`,
          [status, request.params.id]
        )

        if (status !== cabine.status) {
          await logCabineEvent(db, {
            tenantId: tenant_id,
            cabineId: request.params.id,
            contratoId: cabine.contrato_id,
            tipoEvento: status === 'manutencao'
              ? 'cabine_manutencao'
              : status === 'ativa'
                ? 'cabine_ativada'
                : 'cabine_liberada',
            actorUserId: sub,
            actorPapel: papel,
            ip,
            payload: { previous_status: cabine.status, next_status: status },
          })
        }

        await db.query('COMMIT')
        return result.rows[0]
      } catch (error) {
        await db.query('ROLLBACK')
        throw error
      }
    })
  })

  // POST /v1/lives — inicia live a partir da cabine reservada/ativa
  app.post('/v1/lives', { preHandler: cabineRoleAccess(app) }, async (request, reply) => {
    const parsed = iniciarLiveSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id, sub, papel } = request.user
    const { cabine_id } = parsed.data
    const ip = getRequestIp(request)
    return app.withTenant(tenant_id, async (db) => {
      await db.query('BEGIN')

      try {
        const cabineQ = await db.query(
          `SELECT id, numero, status, contrato_id, live_atual_id
           FROM cabines
           WHERE id = $1
           FOR UPDATE`,
          [cabine_id]
        )
        const cabine = cabineQ.rows[0]

        if (!cabine) {
          await db.query('ROLLBACK')
          return reply.code(404).send({ error: 'Cabine não encontrada' })
        }

        if (!['reservada', 'ativa'].includes(cabine.status) || !cabine.contrato_id) {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'Cabine precisa estar reservada ou ativa para iniciar a live' })
        }

        if (cabine.live_atual_id) {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'Cabine já possui uma live em andamento' })
        }

        const contratoQ = await db.query(
          `SELECT id, cliente_id, status
           FROM contratos
           WHERE id = $1
           FOR UPDATE`,
          [cabine.contrato_id]
        )
        const contrato = contratoQ.rows[0]

        if (!contrato || contrato.status !== 'ativo') {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'Contrato vinculado não está apto para iniciar live' })
        }

        const liveQ = await db.query(
          `INSERT INTO lives (tenant_id, cabine_id, cliente_id, apresentador_id)
           VALUES ($1, $2, $3, $4)
           RETURNING id, iniciado_em, cliente_id, apresentador_id`,
          [tenant_id, cabine_id, contrato.cliente_id, sub]
        )
        const live = liveQ.rows[0]

        await db.query(
          `UPDATE cabines
           SET status = 'ao_vivo', live_atual_id = $1
           WHERE id = $2`,
          [live.id, cabine_id]
        )

        await logCabineEvent(db, {
          tenantId: tenant_id,
          cabineId: cabine_id,
          contratoId: cabine.contrato_id,
          tipoEvento: 'cabine_live_iniciada',
          actorUserId: sub,
          actorPapel: papel,
          ip,
          payload: {
            live_id: live.id,
            cliente_id: contrato.cliente_id,
            previous_status: cabine.status,
          },
        })

        await db.query('COMMIT')

        // Não espera 60s do cron — sincroniza connector imediatamente
        syncLives().catch(err =>
          app.log.warn({ err, liveId: live.id }, 'syncLives pós-iniciar-live falhou')
        )

        return reply.code(201).send(live)
      } catch (error) {
        await db.query('ROLLBACK')
        throw error
      }
    })
  })

  // POST /v1/lives/manual — cria live já encerrada (entrada manual pelo gestor)
  const gestorRoleAccess = [
    app.authenticate,
    app.requirePapel(['franqueador_master', 'franqueado', 'gerente']),
  ]
  app.post('/v1/lives/manual', { preHandler: gestorRoleAccess }, async (request, reply) => {
    const parsed = liveManualSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const d = parsed.data
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      try {
        await db.query('BEGIN')

        const cab = await db.query(
          `SELECT c.contrato_id, ct.comissao_pct
             FROM cabines c
             LEFT JOIN contratos ct ON ct.id = c.contrato_id AND ct.status = 'ativo'
            WHERE c.id = $1`,
          [d.cabine_id]
        )
        const comissaoPct = Number(cab.rows[0]?.comissao_pct ?? 0)
        const comissao = d.fat_gerado * (comissaoPct / 100)

        const iniciado = `${d.data} ${d.hora_inicio}:00`
        const encerrado = `${d.data} ${d.hora_fim}:00`

        const ins = await db.query(
          `INSERT INTO lives
             (tenant_id, cabine_id, cliente_id, apresentador_id, gestor_id,
              status, iniciado_em, encerrado_em, fat_gerado, comissao_calculada,
              final_orders_count, resumo)
           VALUES ($1,$2,$3,$4,$5,'encerrada',$6,$7,$8,$9,$10,$11)
           RETURNING id`,
          [
            tenant_id, d.cabine_id, d.cliente_id, d.apresentador_id, d.gestor_id,
            iniciado, encerrado, d.fat_gerado, comissao, d.qtd_pedidos, d.resumo ?? null,
          ]
        )
        const liveId = ins.rows[0].id

        if (d.apresentador2_id) {
          await db.query(
            `INSERT INTO live_apresentadores (tenant_id, live_id, apresentador_id)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [tenant_id, liveId, d.apresentador2_id]
          )
        }

        await db.query('COMMIT')
        return reply.code(201).send({ id: liveId })
      } catch (e) {
        await db.query('ROLLBACK')
        throw e
      }
    })
  })

  // PATCH /v1/lives/:id — edita dados de live encerrada (correção manual)
  app.patch('/v1/lives/:id', { preHandler: gestorRoleAccess }, async (request, reply) => {
    const parsed = liveManualEditSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const d = parsed.data
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      try {
        await db.query('BEGIN')

        const liveQ = await db.query(
          `SELECT id, cabine_id, fat_gerado, iniciado_em, encerrado_em
             FROM lives WHERE id = $1 AND status = 'encerrada' FOR UPDATE`,
          [request.params.id]
        )
        const live = liveQ.rows[0]
        if (!live) {
          await db.query('ROLLBACK')
          return reply.code(404).send({ error: 'Live não encontrada ou não está encerrada' })
        }

        const cabineId = d.cabine_id ?? live.cabine_id
        let comissao = undefined
        if (d.fat_gerado !== undefined) {
          const cab = await db.query(
            `SELECT ct.comissao_pct FROM cabines c
               LEFT JOIN contratos ct ON ct.id = c.contrato_id AND ct.status = 'ativo'
              WHERE c.id = $1`,
            [cabineId]
          )
          const pct = Number(cab.rows[0]?.comissao_pct ?? 0)
          comissao = d.fat_gerado * (pct / 100)
        }

        const updates = []
        const values = []
        let idx = 1

        const addField = (col, val) => { updates.push(`${col} = $${idx++}`); values.push(val) }

        if (d.cabine_id    !== undefined) addField('cabine_id',          d.cabine_id)
        if (d.cliente_id   !== undefined) addField('cliente_id',         d.cliente_id)
        if (d.apresentador_id !== undefined) addField('apresentador_id', d.apresentador_id)
        if (d.gestor_id    !== undefined) addField('gestor_id',          d.gestor_id)
        if (d.fat_gerado   !== undefined) { addField('fat_gerado', d.fat_gerado); addField('comissao_calculada', comissao) }
        if (d.qtd_pedidos  !== undefined) addField('final_orders_count', d.qtd_pedidos)
        if (d.resumo       !== undefined) addField('resumo',             d.resumo)

        if (d.data !== undefined || d.hora_inicio !== undefined || d.hora_fim !== undefined) {
          const currentInicio = new Date(live.iniciado_em)
          const currentFim    = new Date(live.encerrado_em)
          const data    = d.data        ?? currentInicio.toISOString().slice(0, 10)
          const hInicio = d.hora_inicio ?? `${String(currentInicio.getUTCHours()).padStart(2,'0')}:${String(currentInicio.getUTCMinutes()).padStart(2,'0')}`
          const hFim    = d.hora_fim    ?? `${String(currentFim.getUTCHours()).padStart(2,'0')}:${String(currentFim.getUTCMinutes()).padStart(2,'0')}`
          if (hFim <= hInicio) {
            await db.query('ROLLBACK')
            return reply.code(400).send({ error: 'hora_fim deve ser maior que hora_inicio' })
          }
          addField('iniciado_em',  `${data} ${hInicio}:00`)
          addField('encerrado_em', `${data} ${hFim}:00`)
        }

        if (updates.length > 0) {
          values.push(request.params.id)
          await db.query(`UPDATE lives SET ${updates.join(', ')} WHERE id = $${idx}`, values)
        }

        if ('apresentador2_id' in d) {
          await db.query(`DELETE FROM live_apresentadores WHERE live_id = $1`, [request.params.id])
          if (d.apresentador2_id) {
            await db.query(
              `INSERT INTO live_apresentadores (tenant_id, live_id, apresentador_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
              [tenant_id, request.params.id, d.apresentador2_id]
            )
          }
        }

        await db.query('COMMIT')
        return reply.send({ ok: true })
      } catch (e) {
        await db.query('ROLLBACK')
        throw e
      }
    })
  })

  // GET /v1/lives
  app.get('/v1/lives', { preHandler: cabineRoleAccess(app) }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT l.*, c.numero AS cabine_numero, c.contrato_id, cl.nome AS cliente_nome,
                u.nome AS apresentador_nome
         FROM lives l
         JOIN cabines c ON c.id = l.cabine_id
         JOIN clientes cl ON cl.id = l.cliente_id
         JOIN users u ON u.id = l.apresentador_id
         ORDER BY l.iniciado_em DESC LIMIT 100`
      )
      return result.rows
    })
  })

  // PATCH /v1/lives/:id/encerrar
  app.patch('/v1/lives/:id/encerrar', { preHandler: cabineRoleAccess(app) }, async (request, reply) => {
    const parsed = encerrarSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id, sub, papel } = request.user
    const ip = getRequestIp(request)
    return app.withTenant(tenant_id, async (db) => {
      await db.query('BEGIN')

      try {
        const liveQ = await db.query(
          `SELECT id, cabine_id, cliente_id, status, iniciado_em
           FROM lives
           WHERE id = $1 AND status = 'em_andamento'
           FOR UPDATE`,
          [request.params.id]
        )
        const live = liveQ.rows[0]

        if (!live) {
          await db.query('ROLLBACK')
          return reply.code(400).send({ error: 'Live não encontrada ou já encerrada' })
        }

        const cabineQ = await db.query(
          `SELECT id, contrato_id, status
           FROM cabines
           WHERE id = $1
           FOR UPDATE`,
          [live.cabine_id]
        )
        const cabine = cabineQ.rows[0]

        const contratoQ = cabine?.contrato_id
          ? await db.query(
              `SELECT id, status, comissao_pct, horas_contratadas, horas_consumidas
               FROM contratos
               WHERE id = $1
               FOR UPDATE`,
              [cabine.contrato_id]
            )
          : { rows: [] }
        const contrato = contratoQ.rows[0]

        const comissaoPct = Number(contrato?.comissao_pct ?? 0)
        const comissao = parsed.data.fat_gerado * (comissaoPct / 100)

        await db.query(
          `UPDATE lives
           SET status = 'encerrada', encerrado_em = NOW(),
               fat_gerado = $1, comissao_calculada = $2
           WHERE id = $3`,
          [parsed.data.fat_gerado, comissao, request.params.id]
        )

        // Deduct live duration from contrato's horas_consumidas
        if (contrato && live.iniciado_em) {
          const duracaoHoras = (Date.now() - new Date(live.iniciado_em).getTime()) / 3_600_000
          await db.query(
            `UPDATE contratos
             SET horas_consumidas = horas_consumidas + $1
             WHERE id = $2`,
            [duracaoHoras, contrato.id]
          )
        }

        const proximoStatus = contrato?.status === 'ativo' ? 'ativa' : 'disponivel'
        const proximoContratoId = contrato?.status === 'ativo' ? contrato.id : null

        await db.query(
          `UPDATE cabines
           SET status = $1,
               live_atual_id = NULL,
               contrato_id = $2
           WHERE id = $3`,
          [proximoStatus, proximoContratoId, live.cabine_id]
        )

        await logCabineEvent(db, {
          tenantId: tenant_id,
          cabineId: live.cabine_id,
          contratoId: cabine?.contrato_id ?? null,
          tipoEvento: 'cabine_live_encerrada',
          actorUserId: sub,
          actorPapel: papel,
          ip,
          payload: {
            live_id: live.id,
            fat_gerado: parsed.data.fat_gerado,
            comissao_calculada: comissao,
            next_status: proximoStatus,
          },
        })

        await db.query('COMMIT')

        // Gerar cobrança automática de royalties (fire-and-forget)
        if (comissao > 0) {
        }

        // Parar connector TikTok e fazer flush final do snapshot (fire-and-forget)
        if (managerHas(live.id)) {
          stopConnector(live.id).catch(err =>
            app.log.error({ err, liveId: live.id }, 'tiktokManager: falha ao parar connector no encerramento')
          )
        }

        return { ok: true, fat_gerado: parsed.data.fat_gerado, comissao_calculada: comissao }
      } catch (error) {
        await db.query('ROLLBACK')
        throw error
      }
    })
  })
}
