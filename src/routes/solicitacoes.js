import { z } from 'zod'

const agendamentoSchema = z.object({
  cabine_id:        z.string().uuid(),
  cliente_id:       z.string().uuid(),
  apresentadora_id: z.string().uuid().optional().nullable(),
  data_solicitada:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hora_inicio:      z.string().regex(/^\d{2}:\d{2}$/),
  hora_fim:         z.string().regex(/^\d{2}:\d{2}$/),
  observacao:       z.string().optional(),
})

export async function solicitacoesRoutes(app) {
  // GET /v1/solicitacoes — lista solicitações (franqueador/franqueador_master)
  // Query param: ?status=pendente (default) | aprovada | recusada | all
  app.get('/v1/solicitacoes', {
    preHandler: app.requirePapel(['franqueado', 'franqueador_master', 'gerente']),
  }, async (request) => {
    const { tenant_id } = request.user
    const statusFilter = request.query.status ?? 'pendente'
    return app.withTenant(tenant_id, async (db) => {
      const params = [tenant_id]
      let whereStatus = ''

      if (statusFilter !== 'all') {
        params.push(statusFilter)
        whereStatus = `AND lr.status = $${params.length}`
      }

      const q = await db.query(`
        SELECT
          lr.id,
          lr.data_solicitada,
          lr.hora_inicio,
          lr.hora_fim,
          lr.observacao,
          lr.status,
          lr.motivo_recusa,
          lr.criado_em,
          lr.atualizado_em,
          cab.numero AS cabine_numero,
          cli.nome   AS cliente_nome,
          u.nome     AS solicitante_nome
        FROM live_requests lr
        JOIN cabines  cab ON cab.id = lr.cabine_id
        JOIN clientes cli ON cli.id = lr.cliente_id
        JOIN users    u   ON u.id   = lr.solicitante_id
        WHERE lr.tenant_id = $1
          ${whereStatus}
        ORDER BY lr.data_solicitada ASC, lr.hora_inicio ASC, lr.criado_em DESC
        LIMIT 200
      `, params)

      return q.rows.map(r => ({
        id:               r.id,
        data_solicitada:  r.data_solicitada, // DATE → "YYYY-MM-DD"
        hora_inicio:      r.hora_inicio,     // TIME → "HH:MM:SS" (sem fuso)
        hora_fim:         r.hora_fim,
        observacao:       r.observacao,
        status:           r.status,
        motivo_recusa:    r.motivo_recusa,
        criado_em:        r.criado_em,
        atualizado_em:    r.atualizado_em,
        cabine_numero:    Number(r.cabine_numero),
        cliente_nome:     r.cliente_nome,
        solicitante_nome: r.solicitante_nome,
      }))
    })
  })

  // PATCH /v1/solicitacoes/:id/aprovar — aprovar solicitação com check de overlap
  app.patch('/v1/solicitacoes/:id/aprovar', {
    preHandler: app.requirePapel(['franqueado', 'franqueador_master', 'gerente']),
  }, async (request, reply) => {
    const { tenant_id, sub: user_id } = request.user
    const { id } = request.params
    request.log.info(
      {
        id,
        tenant_id,
        body: request.body,
        content_type: request.headers['content-type'],
      },
      'aprovar solicitacao'
    )

    // Usar pool direto para transação com FOR UPDATE
    const client = await app.db.pool.connect()
    try {
      await client.query('BEGIN')
      // Configura RLS para a transação (parameterizado para evitar SQL injection)
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant_id])

      // Lock pessimista para evitar double-approve simultâneo
      const lockQ = await client.query(`
        SELECT id, cabine_id, data_solicitada, hora_inicio, hora_fim, status
        FROM live_requests
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE
      `, [id, tenant_id])

      const row = lockQ.rows[0]
      if (!row) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'Solicitação não encontrada' })
      }
      if (row.status !== 'pendente') {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: `Solicitação já está ${row.status}` })
      }

      // Verificação de overlap: há alguma solicitação aprovada na mesma cabine/dia que se sobrepõe?
      const overlapQ = await client.query(`
        SELECT id FROM live_requests
        WHERE tenant_id = $1
          AND cabine_id = $2
          AND data_solicitada = $3
          AND status = 'aprovada'
          AND hora_inicio < $5
          AND hora_fim   > $4
          AND id != $6
      `, [tenant_id, row.cabine_id, row.data_solicitada, row.hora_inicio, row.hora_fim, id])

      if (overlapQ.rows.length > 0) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'Conflito de horário: já existe uma live aprovada neste período para esta cabine' })
      }

      // Aprova
      const updated = await client.query(`
        UPDATE live_requests
        SET status = 'aprovada', aprovado_por = $1, atualizado_em = NOW()
        WHERE id = $2 AND tenant_id = $3
        RETURNING id, status, atualizado_em
      `, [user_id, id, tenant_id])

      await client.query('COMMIT')
      return updated.rows[0]
    } catch (e) {
      await client.query('ROLLBACK')
      app.log.error({ err: e }, 'unhandled error')
      throw e
    } finally {
      client.release()
    }
  })

  // PATCH /v1/solicitacoes/:id/recusar — recusar solicitação
  app.patch('/v1/solicitacoes/:id/recusar', {
    preHandler: app.requirePapel(['franqueado', 'franqueador_master', 'gerente']),
  }, async (request, reply) => {
    const { tenant_id, sub: user_id } = request.user
    const { id } = request.params
    const { motivo_recusa } = request.body ?? {}

    if (!motivo_recusa || !motivo_recusa.trim()) {
      return reply.code(400).send({ error: 'motivo_recusa é obrigatório para recusar uma solicitação' })
    }

    return app.withTenant(tenant_id, async (db) => {
      const checkQ = await db.query(
        `SELECT status FROM live_requests WHERE id = $1 AND tenant_id = $2`,
        [id, tenant_id]
      )
      if (!checkQ.rows[0]) {
        return reply.code(404).send({ error: 'Solicitação não encontrada' })
      }
      if (checkQ.rows[0].status !== 'pendente') {
        return reply.code(409).send({ error: `Solicitação já está ${checkQ.rows[0].status}` })
      }

      const updated = await db.query(`
        UPDATE live_requests
        SET status = 'recusada', motivo_recusa = $1, aprovado_por = $2, atualizado_em = NOW()
        WHERE id = $3 AND tenant_id = $4
        RETURNING id, status, motivo_recusa, atualizado_em
      `, [motivo_recusa ?? null, user_id, id, tenant_id])

      return updated.rows[0]
    })
  })

  // POST /v1/solicitacoes — franqueado cria agendamento diretamente (já aprovado)
  app.post('/v1/solicitacoes', {
    preHandler: [app.authenticate, app.requirePapel(['franqueado', 'franqueador_master', 'gerente'])],
  }, async (request, reply) => {
    const parsed = agendamentoSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id, sub: user_id } = request.user
    const d = parsed.data

    const client = await app.db.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant_id])

      // Verifica overlap
      const overlapQ = await client.query(`
        SELECT id FROM live_requests
        WHERE tenant_id = $1
          AND cabine_id = $2
          AND data_solicitada = $3
          AND status = 'aprovada'
          AND hora_inicio < $5
          AND hora_fim > $4
      `, [tenant_id, d.cabine_id, d.data_solicitada, d.hora_inicio, d.hora_fim])

      if (overlapQ.rows.length > 0) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'Conflito de horário: já existe um agendamento aprovado neste período para esta cabine' })
      }

      const result = await client.query(`
        INSERT INTO live_requests
          (tenant_id, cabine_id, cliente_id, solicitante_id, apresentadora_id,
           data_solicitada, hora_inicio, hora_fim, observacao, status, aprovado_por)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'aprovada', $4)
        RETURNING id, status, data_solicitada, hora_inicio, hora_fim, criado_em
      `, [tenant_id, d.cabine_id, d.cliente_id, user_id, d.apresentadora_id ?? null,
          d.data_solicitada, d.hora_inicio, d.hora_fim, d.observacao ?? null])

      await client.query('COMMIT')
      return reply.code(201).send(result.rows[0])
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  })
}
