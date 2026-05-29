import { z } from 'zod'
import { READ_SOLICITACOES, WRITE_SOLICITACOES } from '../config/role_groups.js'

const agendamentoSchema = z.object({
  cabine_id:        z.string().uuid(),
  cliente_id:       z.string().uuid(),
  marca_id:         z.string().uuid().optional().nullable(),
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
    preHandler: app.requirePapel(READ_SOLICITACOES),
  }, async (request) => {
    const { tenant_id } = request.user
    const statusFilter = request.query.status ?? 'pendente'
    return app.withTenant(tenant_id, async (db) => {
      const params = [tenant_id]
      let whereStatus = ''

      // Mapeamento de status legado → agenda_eventos
      // pendente → planejado, aprovada → confirmado, recusada → cancelado
      const statusMap = { pendente: 'planejado', aprovada: 'confirmado', recusada: 'cancelado' }
      const statusInverseMap = { planejado: 'pendente', confirmado: 'aprovada', cancelado: 'recusada' }

      if (statusFilter !== 'all') {
        const mappedStatus = statusMap[statusFilter] ?? statusFilter
        params.push(mappedStatus)
        whereStatus = `AND ae.status = $${params.length}`
      }

      const q = await db.query(`
        SELECT
          ae.id,
          (ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::date        AS data_solicitada,
          (ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::time::text  AS hora_inicio,
          (ae.data_fim    AT TIME ZONE 'America/Sao_Paulo')::time::text  AS hora_fim,
          ae.observacoes  AS observacao,
          ae.status,
          ae.motivo_cancelamento AS motivo_recusa,
          ae.criado_em,
          ae.atualizado_em,
          cab.numero AS cabine_numero,
          cli.nome   AS cliente_nome,
          u.nome     AS solicitante_nome
        FROM agenda_eventos ae
        JOIN cabines  cab ON cab.id = ae.cabine_id AND cab.tenant_id = ae.tenant_id
        JOIN marcas   mar ON mar.id = ae.marca_id  AND mar.tenant_id = ae.tenant_id
        JOIN clientes cli ON cli.id = mar.cliente_id AND cli.tenant_id = ae.tenant_id
        LEFT JOIN users u ON u.id = ae.criado_por
        WHERE ae.tenant_id = $1
          AND ae.tipo = 'live'
          ${whereStatus}
        ORDER BY ae.data_inicio ASC, ae.criado_em DESC
        LIMIT 200
      `, params)

      return q.rows.map(r => ({
        id:               r.id,
        data_solicitada:  r.data_solicitada instanceof Date
          ? r.data_solicitada.toISOString().slice(0, 10)
          : String(r.data_solicitada).slice(0, 10),
        hora_inicio:      String(r.hora_inicio).slice(0, 8),
        hora_fim:         String(r.hora_fim).slice(0, 8),
        observacao:       r.observacao,
        // Retorna status no formato legado para compatibilidade com o frontend
        status:           statusInverseMap[r.status] ?? r.status,
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
    preHandler: app.requirePapel(WRITE_SOLICITACOES),
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
        SELECT ae.id, ae.cabine_id, ae.data_inicio, ae.data_fim, ae.status,
               mar.cliente_id
        FROM agenda_eventos ae
        JOIN marcas mar ON mar.id = ae.marca_id AND mar.tenant_id = ae.tenant_id
        WHERE ae.id = $1 AND ae.tenant_id = $2 AND ae.tipo = 'live'
        FOR UPDATE OF ae
      `, [id, tenant_id])

      const row = lockQ.rows[0]
      if (!row) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ error: 'Solicitação não encontrada' })
      }
      if (row.status !== 'planejado') {
        const statusLegado = { confirmado: 'aprovada', cancelado: 'recusada', ao_vivo: 'ao_vivo' }[row.status] ?? row.status
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: `Solicitação já está ${statusLegado}` })
      }

      // Verificação de overlap: há alguma solicitação confirmada na mesma cabine que se sobrepõe?
      const overlapQ = await client.query(`
        SELECT id FROM agenda_eventos
        WHERE tenant_id = $1
          AND cabine_id = $2
          AND tipo = 'live'
          AND status = 'confirmado'
          AND data_inicio < $4
          AND data_fim    > $3
          AND id != $5
      `, [tenant_id, row.cabine_id, row.data_inicio, row.data_fim, id])

      if (overlapQ.rows.length > 0) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'Conflito de horário: já existe uma live aprovada neste período para esta cabine' })
      }

      // Validar contrato ativo do cliente antes de aprovar
      const ctQ = await client.query(
        `SELECT id FROM contratos
         WHERE cliente_id = $1 AND tenant_id = $2 AND status = 'ativo'
         ORDER BY ativado_em DESC NULLS LAST, criado_em DESC
         LIMIT 1`,
        [row.cliente_id, tenant_id]
      )
      if (!ctQ.rows[0]) {
        await client.query('ROLLBACK')
        return reply.code(422).send({
          error: 'Cliente sem contrato ativo. Crie ou ative um contrato antes de aprovar a solicitação.',
          code: 'NO_ACTIVE_CONTRACT',
          cliente_id: row.cliente_id,
        })
      }
      const contratoId = ctQ.rows[0].id

      // Aprova
      const updated = await client.query(`
        UPDATE agenda_eventos
        SET status = 'confirmado', atualizado_em = NOW()
        WHERE id = $1 AND tenant_id = $2 AND tipo = 'live'
        RETURNING id, status, atualizado_em
      `, [id, tenant_id])

      // Reservar cabine SE ainda disponível (idempotente)
      await client.query(
        `UPDATE cabines
         SET status = 'reservada', contrato_id = $1
         WHERE id = $2 AND tenant_id = $3 AND status = 'disponivel'`,
        [contratoId, row.cabine_id, tenant_id]
      )

      await client.query('COMMIT')

      app.audit?.log?.(request, {
        action: 'aprovar_solicitacao',
        entity_type: 'agenda_eventos',
        entity_id: id,
      }).catch(() => {})

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
    preHandler: app.requirePapel(WRITE_SOLICITACOES),
  }, async (request, reply) => {
    const { tenant_id, sub: user_id } = request.user
    const { id } = request.params
    const { motivo_recusa } = request.body ?? {}

    if (!motivo_recusa || !motivo_recusa.trim()) {
      return reply.code(400).send({ error: 'motivo_recusa é obrigatório para recusar uma solicitação' })
    }

    return app.withTenant(tenant_id, async (db) => {
      const checkQ = await db.query(
        `SELECT status FROM agenda_eventos WHERE id = $1 AND tenant_id = $2 AND tipo = 'live'`,
        [id, tenant_id]
      )
      if (!checkQ.rows[0]) {
        return reply.code(404).send({ error: 'Solicitação não encontrada' })
      }
      if (checkQ.rows[0].status !== 'planejado') {
        const statusLegado = { confirmado: 'aprovada', cancelado: 'recusada', ao_vivo: 'ao_vivo' }[checkQ.rows[0].status] ?? checkQ.rows[0].status
        return reply.code(409).send({ error: `Solicitação já está ${statusLegado}` })
      }

      const updated = await db.query(`
        UPDATE agenda_eventos
        SET status = 'cancelado', motivo_cancelamento = $1, atualizado_em = NOW()
        WHERE id = $2 AND tenant_id = $3 AND tipo = 'live'
        RETURNING id, status, motivo_cancelamento AS motivo_recusa, atualizado_em
      `, [motivo_recusa ?? null, id, tenant_id])

      app.audit?.log?.(request, {
        action: 'recusar_solicitacao',
        entity_type: 'agenda_eventos',
        entity_id: id,
        metadata: { motivo: motivo_recusa },
      }).catch(() => {})

      return updated.rows[0]
    })
  })

  // POST /v1/solicitacoes — franqueado cria agendamento diretamente (já aprovado)
  app.post('/v1/solicitacoes', {
    preHandler: [app.authenticate, app.requirePapel(WRITE_SOLICITACOES)],
  }, async (request, reply) => {
    const parsed = agendamentoSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id, sub: user_id } = request.user
    const d = parsed.data

    const client = await app.db.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant_id])

      // Resolve marca_id: usa marca_id explícita ou busca marca ativa do cliente
      let marcaId = d.marca_id ?? null
      if (!marcaId) {
        const marcaQ = await client.query(
          `SELECT id FROM marcas WHERE cliente_id = $1 AND tenant_id = $2 AND status = 'ativa' ORDER BY criado_em ASC LIMIT 1`,
          [d.cliente_id, tenant_id]
        )
        marcaId = marcaQ.rows[0]?.id ?? null
      }
      if (!marcaId) {
        await client.query('ROLLBACK')
        return reply.code(422).send({ error: 'Cliente não possui marca ativa. Crie uma marca antes de agendar.' })
      }

      // Monta timestamps com data + hora (tratados como America/Sao_Paulo)
      const dataInicio = `${d.data_solicitada}T${d.hora_inicio}:00`
      const dataFim    = `${d.data_solicitada}T${d.hora_fim}:00`

      // Verifica overlap contra agenda_eventos confirmados
      const overlapQ = await client.query(`
        SELECT id FROM agenda_eventos
        WHERE tenant_id = $1
          AND cabine_id = $2
          AND tipo = 'live'
          AND status = 'confirmado'
          AND data_inicio < $4::timestamptz
          AND data_fim    > $3::timestamptz
      `, [tenant_id, d.cabine_id,
          `${d.data_solicitada}T${d.hora_inicio}:00-03:00`,
          `${d.data_solicitada}T${d.hora_fim}:00-03:00`])

      if (overlapQ.rows.length > 0) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'Conflito de horário: já existe um agendamento aprovado neste período para esta cabine' })
      }

      const result = await client.query(`
        INSERT INTO agenda_eventos
          (tenant_id, cabine_id, marca_id, criado_por,
           data_inicio, data_fim, tipo, status, observacoes)
        VALUES ($1, $2, $3, $4,
                ($5::date + $6::time) AT TIME ZONE 'America/Sao_Paulo',
                ($5::date + $7::time) AT TIME ZONE 'America/Sao_Paulo',
                'live', 'confirmado', $8)
        RETURNING id, status,
                  (data_inicio AT TIME ZONE 'America/Sao_Paulo')::date AS data_solicitada,
                  (data_inicio AT TIME ZONE 'America/Sao_Paulo')::time AS hora_inicio,
                  (data_fim    AT TIME ZONE 'America/Sao_Paulo')::time AS hora_fim,
                  criado_em
      `, [tenant_id, d.cabine_id, marcaId, user_id,
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
