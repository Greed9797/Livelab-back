import { z } from 'zod'
import { READ_AGENDA, WRITE_AGENDA } from '../config/role_groups.js'
import { calcularRateioPlanejado } from '../lib/agenda-turnos.js'
import { saoPauloDateInput, saoPauloTimeInput } from '../lib/timezone.js'
import { tiktokUsernameSql } from '../lib/tiktok-username.js'
import { applyAgendaStatusFilter } from '../lib/filters.js'
import { ensureClienteMarca } from '../services/client-brand.js'

const activeAgendaStatuses = ['planejado', 'confirmado', 'ao_vivo']

// Status que efetivamente bloqueiam outra reserva no mesmo recurso.
// `planejado` é só reserva — não bloqueia tentativa de iniciar a própria live
// (POST /v1/lives já reusa o evento via agenda_evento_id em src/routes/lives.js:380-415).
// Bloquear `planejado` aqui causa false-positive: usuário com agenda 08-14 não
// consegue clicar "Iniciar live" porque modal alega conflito com a própria agenda.
const conflictBlockingStatuses = ['confirmado', 'ao_vivo']

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

function recorrenciaAteIsValid(data) {
  if (!data.recorrencia?.ate) return true
  const dataInicial = saoPauloDateInput(data.data_inicio)
  return !dataInicial || data.recorrencia.ate >= dataInicial
}

const agendaSchema = agendaBaseSchema.refine((data) => new Date(data.data_fim) > new Date(data.data_inicio), {
  message: 'data_fim deve ser maior que data_inicio',
}).refine((data) => data.tipo === 'bloqueio_manutencao' || Boolean(data.marca_id || data.cliente_id), {
  message: 'Selecione uma marca ou cliente para live e gravação',
}).refine(recorrenciaAteIsValid, {
  message: 'Repetir até deve ser igual ou posterior à data inicial',
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

// Turnos NÃO entram no agendaBaseSchema de propósito: o PATCH monta o UPDATE por
// reflexão sobre as chaves do corpo (`fields.map((f, i) => `${f} = $${i + 3}`)`), então
// um campo `apresentadoras` viraria `SET apresentadoras = $N` numa coluna que não existe.
// Por isso a escrita de turno é sub-rota própria (PUT /v1/agenda/:id/apresentadoras):
// backend sem esta versão devolve 404 de rota, e o front detecta em vez de gravar pela metade.
const turnosSchema = z.object({
  apresentadoras: z.array(z.object({
    apresentadora_id: z.string().uuid(),
    data_inicio: z.string().datetime({ offset: true }),
    data_fim: z.string().datetime({ offset: true }),
  })).max(10),
}).refine((d) => d.apresentadoras.every((t) => new Date(t.data_fim) > new Date(t.data_inicio)), {
  message: 'Cada turno precisa terminar depois de começar',
}).refine((d) => new Set(d.apresentadoras.map((t) => `${t.apresentadora_id}|${new Date(t.data_inicio).getTime()}`)).size === d.apresentadoras.length,
  // Compara INSTANTE, nao a string crua: a UNIQUE do banco
  // (agenda_evento_apresentadoras_turno_unico) e sobre timestamptz, e
  // z.string().datetime({ offset: true }) aceita qualquer offset. Comparando texto,
  // '2026-09-01T14:00:00-03:00' e '2026-09-01T17:00:00Z' passariam como turnos distintos
  // e o segundo INSERT estouraria 23505 — 500 no lugar do 400 que a rota promete.
  { message: 'Turno repetido para a mesma apresentadora' })

async function ensureAgendaRefs(db, reply, { tenantId, marcaId, clienteId, cabineId, apresentadoraId, apresentadoraIds }) {
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

  // Turnos: a FK de agenda_evento_apresentadoras não carrega tenant (mesmo molde de
  // live_apresentadoras_v2), então sem esta checagem um id de outro tenant entraria pela
  // FK e viraria linha de rateio com percentual — dinheiro cruzando tenant. De quebra
  // troca o 500 de violação de FK por um 404 que o front sabe mostrar.
  if (apresentadoraIds?.length) {
    const ids = [...new Set(apresentadoraIds)]
    const q = await db.query(
      'SELECT id FROM apresentadoras WHERE id = ANY($1::uuid[]) AND tenant_id = $2::uuid',
      [ids, tenantId],
    )
    if (q.rows.length !== ids.length) {
      reply.code(404).send({ error: 'Apresentadora não encontrada' })
      return false
    }
  }

  return true
}

async function resolveAgendaMarcaId(db, tenantId, { marcaId, clienteId }) {
  if (marcaId) return marcaId
  if (!clienteId) return null
  // Caminho ÚNICO de criação/resolução da marca-espelho do cliente.
  return ensureClienteMarca(db, {
    tenantId,
    clienteId,
    observacoes: 'Criada automaticamente ao agendar uma cabine para cliente.',
  })
}

async function getConflictingEvents(db, { tenantId, cabineId, apresentadoraId, dataInicio, dataFim, excludeId }) {
  if (!cabineId && !apresentadoraId) return []

  const values = [tenantId, dataInicio, dataFim, conflictBlockingStatuses]
  const entityFilters = []
  let cabineParam = null
  let apresentadoraParam = null

  if (cabineId) {
    values.push(cabineId)
    cabineParam = values.length
    entityFilters.push(`ae.cabine_id = $${cabineParam}::uuid`)
  }

  if (apresentadoraId) {
    values.push(apresentadoraId)
    apresentadoraParam = values.length
    entityFilters.push(`ae.apresentadora_id = $${apresentadoraParam}::uuid`)
  }

  let extra = ''
  if (excludeId) {
    values.push(excludeId)
    extra = `AND ae.id <> $${values.length}::uuid`
  }

  const result = await db.query(
    `SELECT ae.id,
            ae.tipo,
            ae.marca_id,
            ae.cabine_id,
            ae.apresentadora_id,
            ae.data_inicio,
            ae.data_fim,
            ae.status,
            c.numero AS cabine_numero,
            c.nome AS cabine_nome,
            a.nome AS apresentadora_nome,
            CASE
              ${cabineParam ? `WHEN ae.cabine_id = $${cabineParam}::uuid THEN 'cabine'` : ''}
              ${apresentadoraParam ? `WHEN ae.apresentadora_id = $${apresentadoraParam}::uuid THEN 'apresentadora'` : ''}
              ELSE 'agenda'
            END AS entidade
     FROM agenda_eventos ae
     LEFT JOIN cabines c ON c.id = ae.cabine_id AND c.tenant_id = ae.tenant_id
     LEFT JOIN apresentadoras a ON a.id = ae.apresentadora_id AND a.tenant_id = ae.tenant_id
     WHERE ae.tenant_id = $1::uuid
       AND ae.status = ANY($4::text[])
       AND ae.data_inicio < $3::timestamptz
       AND ae.data_fim > $2::timestamptz
       AND (${entityFilters.join(' OR ')})
       ${extra}`,
    values,
  )
  return result.rows
}

// Conflito olhando os TURNOS dos outros eventos, não o espelho escalar de
// agenda_eventos.apresentadora_id. Sem isto, a Bia que apresenta 16-18h dentro de um
// evento cujo espelho é a Ana ficaria invisível para qualquer outra reserva.
// `excludeId` continua singular e funciona: os turnos irmãos compartilham
// agenda_evento_id, então excluir o próprio evento exclui todos os seus turnos.
async function getConflictingTurnos(db, { tenantId, apresentadoraId, dataInicio, dataFim, excludeId }) {
  const q = await db.query(
    `SELECT ae.id, ae.tipo, ae.marca_id, ae.cabine_id,
            t.apresentadora_id, ae.data_inicio, ae.data_fim, ae.status,
            c.numero AS cabine_numero, c.nome AS cabine_nome,
            a.nome AS apresentadora_nome,
            'apresentadora' AS entidade
       FROM agenda_evento_apresentadoras t
       JOIN agenda_eventos ae ON ae.id = t.agenda_evento_id AND ae.tenant_id = t.tenant_id
       LEFT JOIN cabines c ON c.id = ae.cabine_id AND c.tenant_id = ae.tenant_id
       LEFT JOIN apresentadoras a ON a.id = t.apresentadora_id AND a.tenant_id = t.tenant_id
      WHERE t.tenant_id = $1::uuid
        AND t.apresentadora_id = $2::uuid
        AND t.data_inicio < $4::timestamptz
        AND t.data_fim    > $3::timestamptz
        AND ae.status = ANY($5::text[])
        AND ($6::uuid IS NULL OR ae.id <> $6::uuid)`,
    [tenantId, apresentadoraId, dataInicio, dataFim, conflictBlockingStatuses, excludeId || null],
  )
  return q.rows
}

function buildConflictPayload(conflitos) {
  return {
    error: 'Conflito de agenda. Ajuste cabine, apresentadora ou horário antes de salvar.',
    code: 'AGENDA_CONFLICT',
    conflitos: conflitos.map((item) => ({
      tipo: item.tipo,
      entidade: item.entidade,
      evento_id: item.id,
      cabine_id: item.cabine_id,
      cabine_numero: item.cabine_numero,
      cabine_nome: item.cabine_nome,
      apresentadora_id: item.apresentadora_id,
      apresentadora_nome: item.apresentadora_nome,
      data_inicio: item.data_inicio,
      data_fim: item.data_fim,
      horario_conflitante: {
        data_inicio: item.data_inicio,
        data_fim: item.data_fim,
      },
      status: item.status,
    })),
  }
}

function dedupConflitos(conflitos) {
  const seen = new Set()
  return conflitos.filter((item) => {
    const key = `${item.entidade}:${item.id}:${item.data_inicio}:${item.data_fim}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Conflito de UMA janela, olhando os DOIS lugares onde uma apresentadora pode estar
 * reservada: o espelho escalar de agenda_eventos e os turnos de revezamento.
 *
 * Ponto unico de propósito. Enquanto so o PUT de turnos consultava
 * getConflictingTurnos, o POST, o PATCH e o GET /v1/agenda/conflitos enxergavam apenas o
 * espelho — e o espelho so guarda a principal. A Bia que apresenta 16-18h dentro de um
 * evento cujo espelho e a Ana ficava invisivel, e dava para reserva-la em duas cabines no
 * mesmo horario sem nenhum aviso.
 */
async function findConflicts(db, { tenantId, cabineId, apresentadoraId, dataInicio, dataFim, excludeId }) {
  const porEspelho = await getConflictingEvents(db, { tenantId, cabineId, apresentadoraId, dataInicio, dataFim, excludeId })
  if (!apresentadoraId) return porEspelho

  const porTurno = await getConflictingTurnos(db, { tenantId, apresentadoraId, dataInicio, dataFim, excludeId })
  // Evento que ja veio pelo espelho nao pode voltar pelo turno: e a mesma reserva, e
  // conta-la duas vezes dobraria o `total` do payload de conflito que o front le.
  const idsPorEspelho = new Set(porEspelho.map((item) => item.id))
  return [...porEspelho, ...porTurno.filter((item) => !idsPorEspelho.has(item.id))]
}

async function collectAgendaConflicts(db, { tenantId, cabineId, apresentadoraId, intervals, excludeId }) {
  const conflitos = []
  for (const interval of intervals) {
    conflitos.push(...await findConflicts(db, {
      tenantId,
      cabineId,
      apresentadoraId,
      dataInicio: interval.data_inicio,
      dataFim: interval.data_fim,
      excludeId,
    }))
  }

  return dedupConflitos(conflitos)
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
    const { status, tipo, cabine_id, marca_id, cliente_id, data_inicio, data_fim, data } = request.query ?? {}

    return app.withTenant(tenant_id, async (db) => {
      const values = [tenant_id]
      const filters = ['ae.tenant_id = $1::uuid']
      const add = (sql, value) => {
        values.push(value)
        filters.push(sql.replace('?', `$${values.length}`))
      }

      // Default: exclui status='cancelado' (soft-delete leakage fix).
      // ?status=all → bypass; ?status=<valor> → filtra exato.
      applyAgendaStatusFilter(filters, values, status, 'ae')
      if (tipo && tipo !== 'all') add('ae.tipo = ?', tipo)
      if (cabine_id) add('ae.cabine_id = ?::uuid', cabine_id)
      if (marca_id) add('ae.marca_id = ?::uuid', marca_id)
      if (cliente_id) add('m.cliente_id = ?::uuid', cliente_id)
      if (data_inicio) add('ae.data_fim >= ?::timestamptz', data_inicio)
      if (data_fim) add('ae.data_inicio <= ?::timestamptz', data_fim)
      // ?data=YYYY-MM-DD — atalho pra eventos que cruzam o dia (SP TZ).
      // Cobre o caso da Home/Gantt que pede "agenda de hoje".
      if (data && /^\d{4}-\d{2}-\d{2}$/.test(String(data))) {
        const d = String(data)
        add(`(ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::date <= ?::date`, d)
        add(`(ae.data_fim   AT TIME ZONE 'America/Sao_Paulo')::date >= ?::date`, d)
      }

      const result = await db.query(
        `SELECT ae.*,
                m.nome AS marca_nome,
                m.cliente_id AS cliente_id,
                m.cor AS marca_cor,
                COALESCE(m.logo_url, cl.logo_url) AS marca_logo_url,
                COALESCE(m.site, cl.site) AS marca_site,
                cl.nome AS cliente_nome,
                ${tiktokUsernameSql({ marca: 'm', cliente: 'cl' })} AS tiktok_username,
                c.numero AS cabine_numero,
                c.nome AS cabine_nome,
                a.nome AS apresentadora_nome,
                COALESCE(t.turnos, '[]'::json) AS apresentadoras
         FROM agenda_eventos ae
         LEFT JOIN marcas m ON m.id = ae.marca_id AND m.tenant_id = ae.tenant_id
         LEFT JOIN clientes cl ON cl.id = m.cliente_id AND cl.tenant_id = ae.tenant_id
         LEFT JOIN cabines c ON c.id = ae.cabine_id AND c.tenant_id = ae.tenant_id
         LEFT JOIN apresentadoras a ON a.id = ae.apresentadora_id AND a.tenant_id = ae.tenant_id
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object(
                    'apresentadora_id', aea.apresentadora_id,
                    'apresentadora_nome', ap_t.nome,
                    'data_inicio', aea.data_inicio,
                    'data_fim', aea.data_fim
                  ) ORDER BY aea.data_inicio) AS turnos
             FROM agenda_evento_apresentadoras aea
             -- Sem filtro de ativo de propósito: apresentadora desativada (soft-delete)
             -- tem que continuar aparecendo no turno, senão o replace-all do front a
             -- apagaria em silêncio ao salvar o evento de novo.
             LEFT JOIN apresentadoras ap_t ON ap_t.id = aea.apresentadora_id AND ap_t.tenant_id = aea.tenant_id
            WHERE aea.agenda_evento_id = ae.id AND aea.tenant_id = ae.tenant_id
         ) t ON true
         WHERE ${filters.join(' AND ')}
         ORDER BY ae.data_inicio ASC
         LIMIT 500`,
        values,
      )
      return result.rows
    })
  })

  // GET /v1/agenda/conflitos — verifica conflitos para um intervalo/cabine/apresentadora
  app.get('/v1/agenda/conflitos', { preHandler: readAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    const { cabine_id, apresentadora_id, data_inicio, data_fim, exclude_id } = request.query ?? {}

    if ((!cabine_id && !apresentadora_id) || !data_inicio || !data_fim) {
      return reply.code(400).send({ error: 'cabine_id ou apresentadora_id, data_inicio e data_fim são obrigatórios' })
    }

    return app.withTenant(tenant_id, async (db) => {
      const conflitos = dedupConflitos(await findConflicts(db, {
        tenantId: tenant_id,
        cabineId: cabine_id,
        apresentadoraId: apresentadora_id,
        dataInicio: data_inicio,
        dataFim: data_fim,
        excludeId: exclude_id,
      }))
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

      let ocorrencias = []
      if (recorrencia) ocorrencias = calcularRecorrencias(d.data_inicio, d.data_fim, recorrencia)

      if (activeAgendaStatuses.includes(d.status)) {
        const eventosConflitantes = await collectAgendaConflicts(db, {
          tenantId: tenant_id,
          cabineId: d.cabine_id,
          apresentadoraId: d.apresentadora_id,
          intervals: [
            { data_inicio: d.data_inicio, data_fim: d.data_fim },
            ...ocorrencias,
          ],
        })
        if (eventosConflitantes.length > 0) {
          return reply.code(409).send(buildConflictPayload(eventosConflitantes))
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

      return reply.code(201).send({ evento, recorrentes })
    })
  })

  app.patch('/v1/agenda/:id', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = agendaPatchSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { modo_recorrencia = 'apenas_este', recorrencia: _recorrencia, cliente_id: clienteId, ...updates } = parsed.data

    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      // BEGIN explícito pelo mesmo motivo do PUT de turnos: withTenant é autocommit, e este
      // handler escreve em três lugares (evento, lives em sync e a série recorrente) além
      // de deslocar os turnos quando a janela muda. Sem transação o `FOR UPDATE` abaixo não
      // segura nada e uma falha no meio deixa metade escrita.
      await db.query('BEGIN')
      try {
        const currentQ = await db.query(
          `SELECT * FROM agenda_eventos WHERE id = $1 AND tenant_id = $2::uuid FOR UPDATE`,
          [request.params.id, tenant_id],
        )
        const current = currentQ.rows[0]
        if (!current) {
          await db.query('ROLLBACK')
          return reply.code(404).send({ error: 'Evento não encontrado' })
        }

        const refsOk = await ensureAgendaRefs(db, reply, {
          tenantId: tenant_id,
          marcaId: updates.marca_id,
          clienteId,
          cabineId: updates.cabine_id,
          apresentadoraId: updates.apresentadora_id,
        })
        if (!refsOk) {
          await db.query('ROLLBACK')
          return reply
        }

        const patchUpdates = { ...updates }
        if (clienteId && !patchUpdates.marca_id) {
          patchUpdates.marca_id = await resolveAgendaMarcaId(db, tenant_id, { marcaId: patchUpdates.marca_id, clienteId })
        }
        const fields = Object.keys(patchUpdates)
        if (fields.length === 0) {
          await db.query('ROLLBACK')
          return reply.code(400).send({ error: 'Nenhum campo para atualizar' })
        }

        const next = { ...current, ...patchUpdates }
        if (new Date(next.data_fim) <= new Date(next.data_inicio)) {
          await db.query('ROLLBACK')
          return reply.code(400).send({ error: 'data_fim deve ser maior que data_inicio' })
        }
        if (next.tipo !== 'bloqueio_manutencao' && !next.marca_id) {
          await db.query('ROLLBACK')
          return reply.code(400).send({ error: 'Selecione uma marca ou cliente para live e gravação' })
        }

        if (activeAgendaStatuses.includes(next.status)) {
          const eventosConflitantes = await collectAgendaConflicts(db, {
            tenantId: tenant_id,
            cabineId: next.cabine_id,
            apresentadoraId: next.apresentadora_id,
            intervals: [{ data_inicio: next.data_inicio, data_fim: next.data_fim }],
            excludeId: request.params.id,
          })
          if (eventosConflitantes.length > 0) {
            await db.query('ROLLBACK')
            return reply.code(409).send(buildConflictPayload(eventosConflitantes))
          }
        }

        // ── Janela do evento x turnos de revezamento ─────────────────────────────
        // O PUT de turnos recusa turno fora da janela, mas o PATCH mexia na janela sem
        // olhar os turnos: o revezamento ficava pendurado no horário antigo. Quando a live
        // abrisse, o seed somaria turnos que a live nunca teve e o percentual sairia errado
        // (pior: turno inteiro fora da janela nova continua valendo tempo no rateio).
        //
        // Mover o evento (mesmo deslocamento nas duas pontas) desloca os turnos junto —
        // é o que o operador quer dizer com "arrastar o evento". Redimensionar é outra
        // coisa: não dá para adivinhar de quem tirar o tempo, então recusa e manda ajustar
        // o revezamento primeiro.
        const janelaMudou = 'data_inicio' in patchUpdates || 'data_fim' in patchUpdates
        if (janelaMudou) {
          const turnosQ = await db.query(
            `SELECT apresentadora_id, data_inicio, data_fim FROM agenda_evento_apresentadoras
              WHERE agenda_evento_id = $1::uuid AND tenant_id = $2::uuid`,
            [request.params.id, tenant_id],
          )
          if (turnosQ.rows.length > 0) {
            const deltaInicio = new Date(next.data_inicio).getTime() - new Date(current.data_inicio).getTime()
            const deltaFim = new Date(next.data_fim).getTime() - new Date(current.data_fim).getTime()

            if (deltaInicio !== 0 && deltaInicio === deltaFim) {
              // A checagem de conflito lá em cima olha só `next.apresentadora_id` (a
              // principal). Mover o evento move o turno de TODO MUNDO para um horário que
              // ninguém validou — sem isto, arrastar o evento reserva a segunda
              // apresentadora numa hora em que ela já está em outra cabine.
              if (activeAgendaStatuses.includes(next.status)) {
                const conflitosDeTurno = []
                for (const t of turnosQ.rows) {
                  conflitosDeTurno.push(...await findConflicts(db, {
                    tenantId: tenant_id,
                    apresentadoraId: t.apresentadora_id,
                    dataInicio: new Date(new Date(t.data_inicio).getTime() + deltaInicio).toISOString(),
                    dataFim: new Date(new Date(t.data_fim).getTime() + deltaInicio).toISOString(),
                    excludeId: request.params.id,
                  }))
                }
                const unicos = dedupConflitos(conflitosDeTurno)
                if (unicos.length > 0) {
                  await db.query('ROLLBACK')
                  return reply.code(409).send(buildConflictPayload(unicos))
                }
              }

              await db.query(
                `UPDATE agenda_evento_apresentadoras
                    SET data_inicio = data_inicio + ($3 || ' milliseconds')::interval,
                        data_fim    = data_fim    + ($3 || ' milliseconds')::interval
                  WHERE agenda_evento_id = $1::uuid AND tenant_id = $2::uuid`,
                [request.params.id, tenant_id, String(deltaInicio)],
              )
            } else {
              const novaInicio = new Date(next.data_inicio).getTime()
              const novaFim = new Date(next.data_fim).getTime()
              const fora = turnosQ.rows.some((t) => (
                new Date(t.data_inicio).getTime() < novaInicio || new Date(t.data_fim).getTime() > novaFim
              ))
              if (fora) {
                await db.query('ROLLBACK')
                return reply.code(400).send({
                  error: 'O revezamento desta agenda ficaria fora do novo horário. Ajuste os turnos antes de mudar a duração.',
                  code: 'TURNOS_FORA_DA_JANELA',
                })
              }
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

        // ── Sync agenda→live para eventos ao_vivo com live vinculada ──────────────
        if (evento.live_id && evento.status === 'ao_vivo') {
          const liveSync = []
          const liveVals = []
          let lIdx = 1
          const liveAdd = (col, val) => { liveSync.push(`${col} = $${lIdx++}`); liveVals.push(val) }

          if ('marca_id' in patchUpdates) liveAdd('marca_id', patchUpdates.marca_id)
          if ('data_fim' in patchUpdates) liveAdd('previsto_fim', patchUpdates.data_fim)

          // apresentadora_id em agenda_eventos é apresentadoras.id;
          // lives.apresentador_id é users.id — converte via lookup.
          if ('apresentadora_id' in patchUpdates && patchUpdates.apresentadora_id) {
            const apRow = await db.query(
              `SELECT user_id FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid`,
              [patchUpdates.apresentadora_id, tenant_id]
            )
            const userId = apRow.rows[0]?.user_id
            if (userId) liveAdd('apresentador_id', userId)
          }

          if (liveSync.length > 0) {
            liveVals.push(evento.live_id, tenant_id)
            await db.query(
              `UPDATE lives SET ${liveSync.join(', ')}, atualizado_em = NOW()
               WHERE id = $${lIdx}::uuid AND tenant_id = $${lIdx + 1}::uuid AND status = 'em_andamento'`,
              liveVals
            )
          }
        }
        // ── fim sync ─────────────────────────────────────────────────────────────

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

        await db.query('COMMIT')
        return { evento, recorrentes_atualizados: recurrentesAtualizados }
      } catch (err) {
        await db.query('ROLLBACK').catch(() => {})
        throw err
      }
    })
  })

  // PUT /v1/agenda/:id/apresentadoras — turnos do evento (revezamento), replace-all.
  //
  // Sub-rota separada porque o PATCH monta o UPDATE por reflexão sobre os campos do
  // corpo — ver o comentário do turnosSchema. Replace-all mantém a regra simples: o que
  // o front mandar é a verdade do evento, e array vazio desfaz o revezamento.
  //
  // NÃO replica para a série recorrente: turno é decisão de evento. O loop de recorrência
  // do POST não tem RETURNING id e o UPDATE em massa do PATCH devolve só id, então não há
  // como saber a qual ocorrência cada turno pertenceria.
  app.put('/v1/agenda/:id/apresentadoras', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = turnosSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const turnos = parsed.data.apresentadoras
    const { tenant_id } = request.user

    return app.withTenant(tenant_id, async (db) => {
      // BEGIN explícito: withTenant só empresta um client do pool (src/plugins/db.js:229),
      // não abre transação. Em autocommit o `FOR UPDATE` abaixo soltaria o lock no fim da
      // própria statement e o replace-all viraria DELETE + N INSERT + UPDATE em N commits
      // separados — uma queda de conexão no meio apaga o revezamento sem deixar rastro, e
      // dois operadores no mesmo evento intercalam livremente. Mesmo molde de
      // lives.js:368 e apresentadora_disponibilidade.js:144.
      await db.query('BEGIN')
      try {
        const eventoQ = await db.query(
          `SELECT * FROM agenda_eventos WHERE id = $1 AND tenant_id = $2::uuid FOR UPDATE`,
          [request.params.id, tenant_id],
        )
        const evento = eventoQ.rows[0]
        if (!evento) {
          await db.query('ROLLBACK')
          return reply.code(404).send({ error: 'Evento não encontrado' })
        }

        const refsOk = await ensureAgendaRefs(db, reply, {
          tenantId: tenant_id,
          apresentadoraIds: turnos.map((turno) => turno.apresentadora_id),
        })
        if (!refsOk) {
          await db.query('ROLLBACK')
          return reply
        }

        // Turno fora da janela do evento viraria rateio de tempo que a live nunca teve.
        const janelaInicio = new Date(evento.data_inicio).getTime()
        const janelaFim = new Date(evento.data_fim).getTime()
        const foraDaJanela = turnos.some((turno) => (
          new Date(turno.data_inicio).getTime() < janelaInicio || new Date(turno.data_fim).getTime() > janelaFim
        ))
        if (foraDaJanela) {
          await db.query('ROLLBACK')
          return reply.code(400).send({
            error: `Turno fora da janela do evento (${saoPauloTimeInput(evento.data_inicio)}–${saoPauloTimeInput(evento.data_fim)})`,
          })
        }

        if (activeAgendaStatuses.includes(evento.status)) {
          const conflitos = []
          for (const turno of turnos) {
            // findConflicts olha espelho E turnos: evento antigo só tem o espelho escalar,
            // evento novo com revezamento só aparece pelos turnos.
            conflitos.push(...await findConflicts(db, {
              tenantId: tenant_id,
              apresentadoraId: turno.apresentadora_id,
              dataInicio: turno.data_inicio,
              dataFim: turno.data_fim,
              excludeId: evento.id,
            }))
          }

          const unicos = dedupConflitos(conflitos)
          if (unicos.length > 0) {
            await db.query('ROLLBACK')
            return reply.code(409).send(buildConflictPayload(unicos))
          }
        }

        await db.query(
          'DELETE FROM agenda_evento_apresentadoras WHERE agenda_evento_id = $1::uuid AND tenant_id = $2::uuid',
          [evento.id, tenant_id],
        )

        for (const turno of turnos) {
          await db.query(
            `INSERT INTO agenda_evento_apresentadoras
               (tenant_id, agenda_evento_id, apresentadora_id, data_inicio, data_fim)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::timestamptz)`,
            [tenant_id, evento.id, turno.apresentadora_id, turno.data_inicio, turno.data_fim],
          )
        }

        // Espelho escalar de agenda_eventos.apresentadora_id: quem tem mais tempo de turno.
        // A regra vem de calcularRateioPlanejado — a MESMA que o seed usa ao abrir a live —
        // senão o espelho (que agenda_autostart e o GET leem) apontaria para outra pessoa.
        //
        // Com lista VAZIA o espelho não é tocado. Sair do revezamento não pode deixar o
        // evento sem ninguém: o front promove a apresentadora para o campo escalar via
        // PATCH e só então manda o PUT vazio, então zerar aqui apagaria justamente quem o
        // operador acabou de escolher — a live abriria com apresentador_id NULL e a
        // comissão inteira cairia numa linha sem dono. Quem apaga o escalar é o PATCH,
        // dono do campo; este PUT só o espelha quando há turno para espelhar.
        if (turnos.length > 0) {
          const principal = calcularRateioPlanejado(turnos).find((linha) => linha.papel === 'principal')
          await db.query(
            `UPDATE agenda_eventos SET apresentadora_id = $1::uuid, atualizado_em = NOW()
             WHERE id = $2 AND tenant_id = $3::uuid`,
            [principal?.apresentadora_id ?? null, evento.id, tenant_id],
          )
        }

        const gravados = await db.query(
          `SELECT aea.apresentadora_id, a.nome AS apresentadora_nome, aea.data_inicio, aea.data_fim
             FROM agenda_evento_apresentadoras aea
             LEFT JOIN apresentadoras a ON a.id = aea.apresentadora_id AND a.tenant_id = aea.tenant_id
            WHERE aea.agenda_evento_id = $1::uuid AND aea.tenant_id = $2::uuid
            ORDER BY aea.data_inicio ASC`,
          [evento.id, tenant_id],
        )

        await db.query('COMMIT')
        return { evento_id: evento.id, apresentadoras: gravados.rows }
      } catch (err) {
        await db.query('ROLLBACK').catch(() => {})
        throw err
      }
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

      app.audit?.log?.(request, {
        action: 'cancelar_agenda',
        entity_type: 'agenda_eventos',
        entity_id: request.params.id,
        metadata: { modo_recorrencia },
      }).catch(() => {})

      return reply.code(204).send()
    })
  })
}
