import { z } from 'zod'
import { READ_LEADS, WRITE_LEADS } from '../config/role_groups.js'

const CRM_ETAPAS = ['lead_novo','contato_iniciado','reuniao_agendada','proposta_enviada','em_negociacao','aguardando_assinatura','ganho','perdido']

const crmUpdateSchema = z.object({
  nome:                 z.string().min(1).optional(),
  nicho:                z.string().nullable().optional(),
  cidade:               z.string().nullable().optional(),
  estado:               z.string().nullable().optional(),
  crm_etapa:            z.enum(CRM_ETAPAS).optional(),
  valor_oportunidade:   z.number().min(0).optional(),
  responsavel_nome:     z.string().nullable().optional(),
  origem:               z.string().nullable().optional(),
  observacoes_internas: z.string().nullable().optional(),
  motivo_perda:         z.string().nullable().optional(),
  contato_email:        z.string().nullable().optional(),
  contato_whatsapp:     z.string().nullable().optional(),
  dados_extras:         z.record(z.any()).optional(),
})

const contatoSchema = z.object({
  tipo:   z.string().min(1),
  resumo: z.string().min(1),
})

const tarefaSchema = z.object({
  titulo:    z.string().min(1),
  concluida: z.boolean().default(false),
})

const createLeadSchema = z.object({
  nome:               z.string().min(1, 'Nome é obrigatório'),
  nicho:              z.string().optional(),
  cidade:             z.string().optional(),
  estado:             z.string().optional(),
  fat_estimado:       z.number().min(0).optional(),
  valor_oportunidade: z.number().min(0).optional(),
  responsavel_nome:   z.string().optional(),
  origem:             z.string().optional(),
  crm_etapa:          z.enum(CRM_ETAPAS).optional(),
})

const SELECT_CRM = `
  SELECT id, nome, nicho, cidade, estado, lat, lng, fat_estimado,
         status, pego_por, pego_em, expira_em, criado_em, atualizado_em,
         (NOW() - criado_em) < interval '24 hours' AS is_novo,
         crm_etapa, valor_oportunidade, responsavel_nome, origem,
         historico_contatos, observacoes_internas, tarefas,
         motivo_perda, convertido_cliente_id, ganho_em,
         contato_email, contato_whatsapp, payload_externo, dados_extras
  FROM leads`

export async function leadsRoutes(app) {
  const readAccess = [app.authenticate, app.requirePapel(READ_LEADS)]
  const writeAccess = [app.authenticate, app.requirePapel(WRITE_LEADS)]

  // GET /v1/leads — lista leads do tenant com campos CRM
  app.get('/v1/leads', { preHandler: readAccess }, async (request) => {
    const { tenant_id } = request.user
    const { etapa } = request.query

    let where = `WHERE franqueadora_id = $1 AND status != 'expirado'`
    const params = [tenant_id]

    if (etapa) {
      params.push(etapa)
      where += ` AND crm_etapa = $${params.length}`
    }

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `${SELECT_CRM} ${where} ORDER BY criado_em DESC`,
        params
      )
      return result.rows
    })
  })

  // GET /v1/leads/meus — leads próprios não encerrados
  app.get('/v1/leads/meus', { preHandler: readAccess }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `${SELECT_CRM}
         WHERE pego_por = $1 AND crm_etapa NOT IN ('ganho','perdido')
         ORDER BY atualizado_em DESC NULLS LAST, pego_em DESC`,
        [tenant_id]
      )
      return result.rows
    })
  })

  // GET /v1/leads/:id — detalhe do lead
  app.get('/v1/leads/:id', { preHandler: readAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `${SELECT_CRM} WHERE id = $1 AND franqueadora_id = $2`,
        [request.params.id, tenant_id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Lead não encontrado' })
      return result.rows[0]
    })
  })

  // PATCH /v1/leads/:id — atualiza campos CRM
  app.patch('/v1/leads/:id', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = crmUpdateSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const updates = parsed.data
    const fields = Object.keys(updates)
    if (fields.length === 0) return reply.code(400).send({ error: 'Nenhum campo para atualizar' })

    const setClauses = fields
      .map((f, i) => f === 'dados_extras' ? `${f} = $${i + 3}::jsonb` : `${f} = $${i + 3}`)
      .join(', ')
    const values = [
      request.params.id,
      tenant_id,
      ...fields.map((f) => f === 'dados_extras' ? JSON.stringify(updates[f]) : updates[f]),
    ]

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE leads SET ${setClauses}, atualizado_em = NOW()
         WHERE id = $1 AND franqueadora_id = $2
         RETURNING id, nome, nicho, cidade, estado, crm_etapa, valor_oportunidade,
                   responsavel_nome, origem, motivo_perda,
                   contato_email, contato_whatsapp, dados_extras`,
        values
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Lead não encontrado' })
      return result.rows[0]
    })
  })

  // DELETE /v1/leads/:id — remove lead (CRM)
  app.delete('/v1/leads/:id', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `DELETE FROM leads WHERE id = $1 AND franqueadora_id = $2 RETURNING id`,
        [request.params.id, tenant_id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Lead não encontrado' })
      return reply.code(204).send()
    })
  })

  // POST /v1/leads/:id/contato — adiciona entrada no histórico de contatos
  app.post('/v1/leads/:id/contato', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = contatoSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const entrada = { ...parsed.data, data: new Date().toISOString() }

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE leads
         SET historico_contatos = historico_contatos || $3::jsonb,
             atualizado_em = NOW()
         WHERE id = $1 AND franqueadora_id = $2
         RETURNING id, historico_contatos`,
        [request.params.id, tenant_id, JSON.stringify(entrada)]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Lead não encontrado' })
      return result.rows[0]
    })
  })

  // POST /v1/leads/:id/tarefa — adiciona tarefa ao lead
  app.post('/v1/leads/:id/tarefa', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = tarefaSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const tarefa = { ...parsed.data, id: crypto.randomUUID(), criado_em: new Date().toISOString() }

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE leads
         SET tarefas = tarefas || $3::jsonb,
             atualizado_em = NOW()
         WHERE id = $1 AND franqueadora_id = $2
         RETURNING id, tarefas`,
        [request.params.id, tenant_id, JSON.stringify(tarefa)]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Lead não encontrado' })
      return result.rows[0]
    })
  })

  // POST /v1/leads/:id/ganhar — converte lead em cliente + contrato ativo
  app.post('/v1/leads/:id/ganhar', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id, sub: userId } = request.user
    const { pacote_id } = request.body ?? {}

    const client = await app.db.pool.connect()
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant_id])
      await client.query('BEGIN')

      const leadQ = await client.query(
        `SELECT * FROM leads WHERE id = $1 AND franqueadora_id = $2 FOR UPDATE`,
        [request.params.id, tenant_id]
      )
      const lead = leadQ.rows[0]
      if (!lead) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'Lead não encontrado' }) }
      if (lead.crm_etapa === 'ganho') { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'Lead já convertido' }) }

      // Cria cliente
      const clienteQ = await client.query(
        `INSERT INTO clientes (tenant_id, nome, nicho, cidade, estado, lat, lng, fat_anual, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ativo')
         RETURNING id`,
        [tenant_id, lead.nome, lead.nicho, lead.cidade, lead.estado, lead.lat, lead.lng, Number(lead.fat_estimado) * 12]
      )
      const clienteId = clienteQ.rows[0].id

      // Obtém dados do pacote para copiar no contrato
      let valorFixo = 0, comissaoPct = 0, horasIncluidas = 0
      if (pacote_id) {
        const pacoteQ = await client.query(
          `SELECT valor_fixo, comissao_pct, horas_incluidas FROM pacotes WHERE id = $1 AND tenant_id = $2`,
          [pacote_id, tenant_id]
        )
        if (pacoteQ.rows[0]) {
          valorFixo = Number(pacoteQ.rows[0].valor_fixo)
          comissaoPct = Number(pacoteQ.rows[0].comissao_pct)
          horasIncluidas = Number(pacoteQ.rows[0].horas_incluidas)
        }
      }

      // Cria contrato ativo
      await client.query(
        `INSERT INTO contratos (tenant_id, cliente_id, user_id, pacote_id, valor_fixo, comissao_pct, horas_contratadas, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ativo')`,
        [tenant_id, clienteId, userId, pacote_id ?? null, valorFixo, comissaoPct, horasIncluidas]
      )

      // Marca lead como ganho
      await client.query(
        `UPDATE leads
         SET crm_etapa = 'ganho', status = 'pego', convertido_cliente_id = $3,
             ganho_em = NOW(), atualizado_em = NOW()
         WHERE id = $1 AND franqueadora_id = $2`,
        [request.params.id, tenant_id, clienteId]
      )

      await client.query('COMMIT')
      return { ok: true, cliente_id: clienteId }
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  })

  // POST /v1/leads — cria lead manualmente (CRM)
  app.post('/v1/leads', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = createLeadSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const data = parsed.data
    const fields = ['franqueadora_id', 'nome', 'status', 'pego_por', 'pego_em', 'crm_etapa']
    const values = [tenant_id, data.nome, 'pego', tenant_id, new Date(), data.crm_etapa ?? 'lead_novo']
    const optional = ['nicho', 'cidade', 'estado', 'fat_estimado', 'valor_oportunidade', 'responsavel_nome', 'origem']
    for (const f of optional) {
      if (data[f] !== undefined) {
        fields.push(f)
        values.push(data[f])
      }
    }
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ')
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `INSERT INTO leads (${fields.join(', ')}, criado_em, atualizado_em)
         VALUES (${placeholders}, NOW(), NOW())
         RETURNING id, nome, nicho, cidade, estado, fat_estimado, status, pego_por, pego_em,
                   crm_etapa, valor_oportunidade, responsavel_nome, origem,
                   historico_contatos, observacoes_internas, tarefas, motivo_perda,
                   convertido_cliente_id, ganho_em, criado_em, atualizado_em,
                   (NOW() - criado_em) < interval '24 hours' AS is_novo`,
        values
      )
      return reply.code(201).send(result.rows[0])
    })
  })

  // POST /v1/leads/:id/pegar — pega lead disponível (fluxo legado)
  app.post('/v1/leads/:id/pegar', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    const client = await app.db.pool.connect()
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant_id])
      await client.query('BEGIN')
      const q = await client.query(
        `SELECT id, status FROM leads WHERE id = $1 AND franqueadora_id = $2 FOR UPDATE`,
        [request.params.id, tenant_id]
      )
      const lead = q.rows[0]
      if (!lead) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'Lead não encontrado' }) }
      if (lead.status !== 'disponivel') { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'Lead já foi pego' }) }

      await client.query(
        `UPDATE leads SET status = 'pego', pego_por = $1,
          pego_em = NOW(), expira_em = NOW() + interval '24 hours', atualizado_em = NOW()
         WHERE id = $2 AND franqueadora_id = $3`,
        [tenant_id, request.params.id, tenant_id]
      )
      await client.query('COMMIT')
      return { ok: true }
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  })
}
