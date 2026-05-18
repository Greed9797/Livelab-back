import { z } from 'zod'
import { READ_AGENDA, WRITE_AGENDA } from '../config/role_groups.js'

const activeAgendaStatuses = ['planejado', 'confirmado', 'ao_vivo']

const recorrenciaSchema = z.object({
  frequencia: z.enum(['diaria', 'semanal', 'quinzenal', 'mensal']),
  dias_semana: z.array(z.number().int().min(0).max(6)).optional(),
  ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  total_ocorrencias: z.number().int().min(1).max(52).optional(),
}).optional()

const agendaBaseSchema = z.object({
  tipo: z.enum(['live', 'gravacao_video', 'bloqueio_manutencao']),
  marca_id: z.string().uuid().nullable().optional(),
  cliente_id: z.string().uuid().nullable().optional(),
  cabine_id: z.string().uuid().nullable().optional(),
  apresentadora_id: z.string().uuid().nullable().optional(),
  data_inicio: z.string().datetime({ offset: true }),
  data_fim: z.string().datetime({ offset: true }),
  status: z.enum(['planejado', 'confirmado', 'ao_vivo', 'concluido', 'cancelado']).default('planejado'),
  recorrencia_rule: z.string().nullable().optional(),
  recorrencia_origem_id: z.string().uuid().nullable().optional(),
  responsavel_marketing: z.string().nullable().optional(),
  observacoes: z.string().nullable().optional(),
  recorrencia: recorrenciaSchema,
})

const agendaSchema = agendaBaseSchema.refine((data) => new Date(data.data_fim) > new Date(data.data_inicio), {
  message: 'data_fim deve ser maior que data_inicio',
}).refine((data) => data.tipo === 'bloqueio_manutencao' || Boolean(data.marca_id || data.cliente_id), {
  message: 'Selecione uma marca ou cliente para live e gravação',
})

const agendaPatchSchema = agendaBaseSchema.partial().extend({
  modo_recorrencia: z.enum(['apenas_este', 'este_e_proximos', 'todos']).optional().default('apenas_este'),
}).refine((data) => {
  if (!data.data_inicio || !data.data_fim) return true
  return new Date(data.data_fim) > new Date(data.data_inicio)
}, { message: 'data_fim deve ser maior que data_inicio' })

const agendaDeleteQuerySchema = z.object({
  modo_recorrencia: z.enum(['apenas_este', 'este_e_proximos', 'todos']).optional().default('apenas_este'),
})

async function ensureAgendaRefs(db, reply, { tenantId, marcaId, clienteId, cabineId, apresentadoraId }) {
  if (marcaId) {
    const marca = await db.query('SELECT id FROM marcas WHERE id = $1 AND tenant_id = $2::uuid', [marcaId, tenantId])
    if (!marca.rows[0]) {
      reply.code(404).send({ error: 'Marca não encontrada' })
      return false
    }
  }

  if (clienteId) {
    const cliente = await db.query('SELECT id FROM clientes WHERE id = $1 AND tenant_id = $2::uuid', [clienteId, tenantId])
    if (!cliente.rows[0]) {
      reply.code(404).send({ error: 'Cliente não encontrado' })
      return false
    }
  }

  if (cabineId) {
    const cabine = await db.query('SELECT id FROM cabines WHERE id = $1 AND tenant_id = $2::uuid', [cabineId, tenantId])
    if (!cabine.rows[0]) {
      reply.code(404).send({ error: 'Cabine não encontrada' })
      return false
    }
  }

  if (apresentadoraId) {
    const apresentadora = await db.query('SELECT id FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid', [apresentadoraId, tenantId])
    if (!apresentadora.rows[0]) {
      reply.code(404).send({ error: 'Apresentadora não encontrada' })
      return false
    }
  }

  return true
}

async function resolveAgendaMarcaId(db, tenantId, { marcaId, clienteId }) {
  if (marcaId) return marcaId
  if (!clienteId) return null

  const existing = await db.query(
    `SELECT id
       FROM marcas
      WHERE tenant_id = $1::uuid
        AND cliente_id = $2::uuid
        AND tipo = 'cliente'
      ORDER BY status = 'ativa' DESC, atualizado_em DESC NULLS LAST
      LIMIT 1`,
    [tenantId, clienteId],
  )
  if (existing.rows[0]) return existing.rows[0].id

  const cliente = await db.query(
    `SELECT id, nome, tiktok_username, site
       FROM clientes
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid`,
    [clienteId, tenantId],
  )
  const row = cliente.rows[0]
  if (!row) return null

  const inserted = await db.query(
    `INSERT INTO marcas (
       tenant_id, cliente_id, nome, tipo, status, tiktok_username, site, observacoes
     )
     VALUES ($1,$2,$3,'cliente','ativa',$4,$5,'Criada automaticamente ao agendar uma cabine para cliente.')
     RETURNING id`,
    [tenantId, row.id, row.nome, row.tiktok_username ?? null, row.site ?? null],
  )
  return inserted.rows[0]?.id ?? null
}

async function getConflictingEvents(db, { tenantId, cabineId, dataInicio, dataFim, excludeId }) {
  if (!cabineId) return []

  const values = [tenantId, cabineId, dataInicio, dataFim, activeAgendaStatuses]
  let extra = ''
  if (excludeId) {
    values.push(excludeId)
    extra = `AND id <> $${values.length}::uuid`
  }

  const result = await db.query(
    `SELECT id, tipo, marca_id, data_inicio, data_fim, status
     FROM agenda_eventos
     WHERE tenant_id = $1::uuid
       AND cabine_id = $2::uuid
       AND status = ANY($5::text[])
       AND data_inicio < $4::timestamptz
       AND data_fim > $3::timestamptz
       ${extra}`,
    values,
  )
  return result.rows
}

async function hasAgendaOverlap(db, params) {
  const rows = await getConflictingEvents(db, params)
  return rows.length > 0
}

/**
 * Calcula datas de ocorrências recorrentes a partir do evento original.
 * Retorna array de objetos { data_inicio, data_fim } para cada ocorrência futura
 * (exclui a data do evento principal).
 */
function calcularRecorrencias(dataInicio, dataFim, recorrencia) {
  const { frequencia, dias_semana, ate, total_ocorrencias } = recorrencia

  const inicio = new Date(dataInicio)
  const fim = new Date(dataFim)
  const duracao = fim.getTime() - inicio.getTime()

  // Data limite: ate fornecido, ou 90 dias a partir da data início
  const dataLimite = ate
    ? new Date(ate + 'T23:59:59Z')
    : new Date(inicio.getTime() + 90 * 24 * 60 * 60 * 1000)

  const maxOcorrencias = total_ocorrencias ?? 52

  const ocorrencias = []
  let cursor = new Date(inicio)

  // Avança cursor para a próxima ocorrência sem incluir a data original
  function proximaData(d) {
    const next = new Date(d)
    switch (frequencia) {
      case 'diaria':
        next.setDate(next.getDate() + 1)
        break
      case 'semanal':
        next.setDate(next.getDate() + 7)
        break
      case 'quinzenal':
        next.setDate(next.getDate() + 14)
        break
      case 'mensal':
        next.setMonth(next.getMonth() + 1)
        break
    }
    return next
  }

  cursor = proximaData(cursor)

  while (cursor <= dataLimite && ocorrencias.length < maxOcorrencias) {
    // Para semanal/quinzenal com dias_semana, gera todas as ocorrências nos dias especificados dentro da semana
    if ((frequencia === 'semanal' || frequencia === 'quinzenal') && dias_semana && dias_semana.length > 0) {
      // Encontra a segunda-feira da semana atual do cursor
      const semanaBase = new Date(cursor)
      // Gera ocorrências para cada dia da semana especificado
      const diasOrdenados = [...dias_semana].sort((a, b) => a - b)
      for (const dia of diasOrdenados) {
        // Calcula a data do dia da semana dentro da semana do cursor
        const diff = dia - semanaBase.getDay()
        const dataDia = new Date(semanaBase)
        dataDia.setDate(semanaBase.getDate() + diff)
        // Mantém o horário original
        dataDia.setHours(inicio.getHours(), inicio.getMinutes(), inicio.getSeconds(), 0)

        if (dataDia > inicio && dataDia <= dataLimite && ocorrencias.length < maxOcorrencias) {
          const novoInicio = new Date(dataDia)
          const novoFim = new Date(novoInicio.getTime() + duracao)
          ocorrencias.push({
            data_inicio: novoInicio.toISOString(),
            data_fim: novoFim.toISOString(),
          })
        }
      }
      cursor = proximaData(cursor)
    } else {
      const novoInicio = new Date(cursor)
      const novoFim = new Date(novoInicio.getTime() + duracao)
      ocorrencias.push({
        data_inicio: novoInicio.toISOString(),
        data_fim: novoFim.toISOString(),
      })
      cursor = proximaData(cursor)
    }
  }

  return ocorrencias
}

export async function agendaRoutes(app) {
  const readAccess = [app.authenticate, app.requirePapel(READ_AGENDA)]
  const writeAccess = [app.authenticate, app.requirePapel(WRITE_AGENDA)]

  app.get('/v1/agenda', { preHandler: readAccess }, async (request) => {
    const { tenant_id } = request.user
    const { status, tipo, cabine_id, marca_id, cliente_id, data_inicio, data_fim } = request.query ?? {}

    return app.withTenant(tenant_id, async (db) => {
      const values = [tenant_id]
      const filters = ['ae.tenant_id = $1::uuid']
      const add = (sql, value) => {
        values.push(value)
        filters.push(sql.replace('?', `$${values.length}`))
      }

      if (status && status !== 'all') add('ae.status = ?', status)
      if (tipo && tipo !== 'all') add('ae.tipo = ?', tipo)
      if (cabine_id) add('ae.cabine_id = ?::uuid', cabine_id)
      if (marca_id) add('ae.marca_id = ?::uuid', marca_id)
      if (cliente_id) add('m.cliente_id = ?::uuid', cliente_id)
      if (data_inicio) add('ae.data_fim >= ?::timestamptz', data_inicio)
      if (data_fim) add('ae.data_inicio <= ?::timestamptz', data_fim)

      const result = await db.query(
        `SELECT ae.*,
                m.nome AS marca_nome,
                m.cliente_id AS cliente_id,
                cl.nome AS cliente_nome,
                COALESCE(m.tiktok_username, cl.tiktok_username) AS tiktok_username,
                c.numero AS cabine_numero,
                c.nome AS cabine_nome,
                a.nome AS apresentadora_nome
         FROM agenda_eventos ae
         LEFT JOIN marcas m ON m.id = ae.marca_id AND m.tenant_id = ae.tenant_id
         LEFT JOIN clientes cl ON cl.id = m.cliente_id AND cl.tenant_id = ae.tenant_id
         LEFT JOIN cabines c ON c.id = ae.cabine_id AND c.tenant_id = ae.tenant_id
         LEFT JOIN apresentadoras a ON a.id = ae.apresentadora_id AND a.tenant_id = ae.tenant_id
         WHERE ${filters.join(' AND ')}
         ORDER BY ae.data_inicio ASC
         LIMIT 500`,
        values,
      )
      return result.rows
    })
  })

  // GET /v1/agenda/conflitos — verifica conflitos para um intervalo/cabine
  app.get('/v1/agenda/conflitos', { preHandler: readAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    const { cabine_id, data_inicio, data_fim, exclude_id } = request.query ?? {}

    if (!cabine_id || !data_inicio || !data_fim) {
      return reply.code(400).send({ error: 'cabine_id, data_inicio e data_fim são obrigatórios' })
    }

    return app.withTenant(tenant_id, async (db) => {
      const conflitos = await getConflictingEvents(db, {
        tenantId: tenant_id,
        cabineId: cabine_id,
        dataInicio: data_inicio,
        dataFim: data_fim,
        excludeId: exclude_id,
      })
      return { conflitos, total: conflitos.length }
    })
  })

  app.post('/v1/agenda', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = agendaSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id, sub } = request.user
    const { recorrencia, cliente_id: clienteId, ...d } = parsed.data

    return app.withTenant(tenant_id, async (db) => {
      const refsOk = await ensureAgendaRefs(db, reply, {
        tenantId: tenant_id,
        marcaId: d.marca_id,
        clienteId,
        cabineId: d.cabine_id,
        apresentadoraId: d.apresentadora_id,
      })
      if (!refsOk) return reply

      const marcaId = await resolveAgendaMarcaId(db, tenant_id, { marcaId: d.marca_id, clienteId })
      if (d.tipo !== 'bloqueio_manutencao' && !marcaId) {
        return reply.code(400).send({ error: 'Selecione uma marca ou cliente para live e gravação' })
      }

      // Verifica conflito — cria mesmo assim, retorna aviso
      let conflito = null
      if (d.cabine_id && activeAgendaStatuses.includes(d.status)) {
        const eventosConflitantes = await getConflictingEvents(db, {
          tenantId: tenant_id,
          cabineId: d.cabine_id,
          dataInicio: d.data_inicio,
          dataFim: d.data_fim,
        })
        if (eventosConflitantes.length > 0) {
          conflito = {
            descricao: `Existe(m) ${eventosConflitantes.length} evento(s) ativo(s) nesta cabine no mesmo horário`,
            eventos_conflitantes: eventosConflitantes,
          }
        }
      }

      // Cria o evento principal
      const result = await db.query(
        `INSERT INTO agenda_eventos (
           tenant_id, tipo, marca_id, cabine_id, apresentadora_id, data_inicio, data_fim,
           status, recorrencia_rule, recorrencia_origem_id, responsavel_marketing, observacoes, criado_por
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          tenant_id, d.tipo, marcaId ?? null, d.cabine_id ?? null, d.apresentadora_id ?? null, d.data_inicio,
          d.data_fim, d.status, d.recorrencia_rule ?? null,
          d.recorrencia_origem_id ?? null, d.responsavel_marketing ?? null, d.observacoes ?? null, sub ?? null,
        ],
      )
      const evento = result.rows[0]

      // Processa recorrência se fornecida
      let recorrentes = 0
      if (recorrencia) {
        const ocorrencias = calcularRecorrencias(d.data_inicio, d.data_fim, recorrencia)
        const ruleJson = JSON.stringify({
          frequencia: recorrencia.frequencia,
          dias_semana: recorrencia.dias_semana,
          ate: recorrencia.ate,
        })

        for (const ocorrencia of ocorrencias) {
          await db.query(
            `INSERT INTO agenda_eventos (
               tenant_id, tipo, marca_id, cabine_id, apresentadora_id, data_inicio, data_fim,
               status, recorrencia_rule, recorrencia_origem_id, responsavel_marketing, observacoes, criado_por
             )
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [
              tenant_id, d.tipo, marcaId ?? null, d.cabine_id ?? null, d.apresentadora_id ?? null,
              ocorrencia.data_inicio, ocorrencia.data_fim,
              d.status, ruleJson, evento.id,
              d.responsavel_marketing ?? null, d.observacoes ?? null, sub ?? null,
            ],
          )
          recorrentes++
        }
      }

      const response = { evento, recorrentes }
      if (conflito) response.conflito = conflito

      return reply.code(201).send(response)
    })
  })

  app.patch('/v1/agenda/:id', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = agendaPatchSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { modo_recorrencia = 'apenas_este', recorrencia: _recorrencia, cliente_id: clienteId, ...updates } = parsed.data

    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const currentQ = await db.query(
        `SELECT * FROM agenda_eventos WHERE id = $1 AND tenant_id = $2::uuid FOR UPDATE`,
        [request.params.id, tenant_id],
      )
      const current = currentQ.rows[0]
      if (!current) return reply.code(404).send({ error: 'Evento não encontrado' })

      const refsOk = await ensureAgendaRefs(db, reply, {
        tenantId: tenant_id,
        marcaId: updates.marca_id,
        clienteId,
        cabineId: updates.cabine_id,
        apresentadoraId: updates.apresentadora_id,
      })
      if (!refsOk) return reply

      const patchUpdates = { ...updates }
      if (clienteId && !patchUpdates.marca_id) {
        patchUpdates.marca_id = await resolveAgendaMarcaId(db, tenant_id, { marcaId: patchUpdates.marca_id, clienteId })
      }
      const fields = Object.keys(patchUpdates)
      if (fields.length === 0) return reply.code(400).send({ error: 'Nenhum campo para atualizar' })

      const next = { ...current, ...patchUpdates }
      if (new Date(next.data_fim) <= new Date(next.data_inicio)) {
        return reply.code(400).send({ error: 'data_fim deve ser maior que data_inicio' })
      }
      if (next.tipo !== 'bloqueio_manutencao' && !next.marca_id) {
        return reply.code(400).send({ error: 'Selecione uma marca ou cliente para live e gravação' })
      }

      // Verifica conflito — retorna aviso, não bloqueia
      let conflito = null
      if (next.cabine_id && activeAgendaStatuses.includes(next.status)) {
        const eventosConflitantes = await getConflictingEvents(db, {
          tenantId: tenant_id,
          cabineId: next.cabine_id,
          dataInicio: next.data_inicio,
          dataFim: next.data_fim,
          excludeId: request.params.id,
        })
        if (eventosConflitantes.length > 0) {
          conflito = {
            descricao: `Existe(m) ${eventosConflitantes.length} evento(s) ativo(s) nesta cabine no mesmo horário`,
            eventos_conflitantes: eventosConflitantes,
          }
        }
      }

      const set = fields.map((field, index) => `${field} = $${index + 3}`).concat('atualizado_em = NOW()').join(', ')

      // Atualiza o evento principal
      const mainValues = [request.params.id, tenant_id, ...fields.map((field) => patchUpdates[field])]
      const result = await db.query(
        `UPDATE agenda_eventos SET ${set}
         WHERE id = $1 AND tenant_id = $2::uuid
         RETURNING *`,
        mainValues,
      )
      const evento = result.rows[0]

      // Atualiza recorrentes conforme modo_recorrencia
      let recurrentesAtualizados = 0
      if (modo_recorrencia !== 'apenas_este') {
        // Determina o recorrencia_origem_id para filtrar a série
        const origemId = current.recorrencia_origem_id ?? current.id

        // Monta: $1=tenant, $2=origemId, $3..$N=campos, $N+1=excludeId [, $N+2=data_inicio se este_e_proximos]
        const recValues = [tenant_id, origemId, ...fields.map((field) => patchUpdates[field]), request.params.id]
        const excludeIdx = recValues.length // posição do excludeId já inserido acima
        const setRecorrentes = fields.map((field, index) => `${field} = $${index + 3}`).concat('atualizado_em = NOW()').join(', ')

        let extraFilter = ''
        if (modo_recorrencia === 'este_e_proximos') {
          recValues.push(current.data_inicio)
          extraFilter = `AND data_inicio >= $${recValues.length}::timestamptz`
        }

        const recResult = await db.query(
          `UPDATE agenda_eventos SET ${setRecorrentes}
           WHERE tenant_id = $1::uuid
             AND recorrencia_origem_id = $2::uuid
             AND id <> $${excludeIdx}::uuid
             ${extraFilter}
           RETURNING id`,
          recValues,
        )
        recurrentesAtualizados = recResult.rowCount ?? 0
      }

      const response = { evento, recorrentes_atualizados: recurrentesAtualizados }
      if (conflito) response.conflito = conflito

      return response
    })
  })

  app.delete('/v1/agenda/:id', { preHandler: writeAccess }, async (request, reply) => {
    const parsedQuery = agendaDeleteQuerySchema.safeParse(request.query ?? {})
    const modo_recorrencia = parsedQuery.success ? parsedQuery.data.modo_recorrencia : 'apenas_este'

    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const currentQ = await db.query(
        `SELECT * FROM agenda_eventos WHERE id = $1 AND tenant_id = $2::uuid`,
        [request.params.id, tenant_id],
      )
      const current = currentQ.rows[0]
      if (!current) return reply.code(404).send({ error: 'Evento não encontrado' })

      // Cancela o evento principal
      await db.query(
        `UPDATE agenda_eventos SET status = 'cancelado', atualizado_em = NOW()
         WHERE id = $1 AND tenant_id = $2::uuid`,
        [request.params.id, tenant_id],
      )

      // Cancela recorrentes conforme modo_recorrencia
      let recurrentesCancelados = 0
      if (modo_recorrencia !== 'apenas_este') {
        const origemId = current.recorrencia_origem_id ?? current.id

        // $1=tenant, $2=origemId, $3=excludeId [, $4=data_inicio se este_e_proximos]
        const delValues = [tenant_id, origemId, request.params.id]
        let extraFilter = ''

        if (modo_recorrencia === 'este_e_proximos') {
          delValues.push(current.data_inicio)
          extraFilter = `AND data_inicio >= $4::timestamptz`
        }

        const recResult = await db.query(
          `UPDATE agenda_eventos SET status = 'cancelado', atualizado_em = NOW()
           WHERE tenant_id = $1::uuid
             AND recorrencia_origem_id = $2::uuid
             AND id <> $3::uuid
             AND status <> 'cancelado'
             ${extraFilter}`,
          delValues,
        )
        recurrentesCancelados = recResult.rowCount ?? 0
      }

      return reply.code(204).send()
    })
  })
}
