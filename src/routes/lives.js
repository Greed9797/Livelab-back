import { z } from 'zod'
import { has as managerHas, stopConnector, syncLives } from '../services/tiktok-connector-manager.js'
import { READ_CABINES, WRITE_LIVES } from '../config/role_groups.js'
import { notify } from '../services/mailer.js'
import { upsertVendaAtribuida } from './vendas_atribuidas.js'
import { getRequestIp, logCabineEvent } from '../lib/cabine-events.js'
import { calcularComissoesDaLive } from '../services/commission-engine.js'
import { moneySchema } from '../lib/money.js'
import { saoPauloDateInput, saoPauloTimeInput, saoPauloTimestamp } from '../lib/timezone.js'
import { tiktokUsernameField, tiktokUsernameSql, updateCanonicalTikTokUsername } from '../lib/tiktok-username.js'

function parseIntegerMetric(value) {
  if (typeof value === 'number') return value
  if (value == null) return value
  if (typeof value !== 'string') return value

  const cleaned = value.trim().replace(/\s/g, '').replace(/[^\d,.-]/g, '')
  if (!cleaned || cleaned === '-' || cleaned === ',' || cleaned === '.') return undefined

  const separators = [...cleaned.matchAll(/[,.]/g)]
  if (separators.length === 0) return Number(cleaned)

  const lastSeparator = separators.at(-1)?.[0] ?? ''
  const lastIndex = Math.max(cleaned.lastIndexOf(','), cleaned.lastIndexOf('.'))
  const integerPart = cleaned.slice(0, lastIndex)
  const tail = cleaned.slice(lastIndex + 1)

  if (separators.length > 1 && tail.length <= 2 && /^0+$/.test(tail)) {
    return Number(integerPart.replace(/[,.]/g, ''))
  }

  const parts = cleaned.split(lastSeparator)
  const thousands = parts.length > 1 && parts.slice(1).every((part) => /^\d{3}$/.test(part))
  if (thousands) return Number(parts.join(''))

  const normalized = lastSeparator === ',' ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned.replace(/,/g, '')
  const parsed = Number(normalized)
  return parsed
}

const integerMetricSchema = z.preprocess(
  parseIntegerMetric,
  z.number().int().min(0),
)

const iniciarLiveSchema = z.object({
  cabine_id: z.string().uuid(),
  cliente_id: z.string().uuid().optional(),
  marca_id: z.string().uuid().optional().nullable(),
  apresentador_id: z.string().uuid().optional().nullable(),
  apresentadora_id: z.string().uuid().optional().nullable(),
  tiktok_username: tiktokUsernameField,
  tipo: z.enum(['cliente', 'afiliado', 'teste']).optional().default('cliente'),
  agenda_evento_id: z.string().uuid().optional().nullable(),
  previsto_fim: z.string().datetime({ offset: true }).optional().nullable(),
})

const encerrarSchema = z.object({
  fat_gerado:         moneySchema,
  qtd_pedidos:        integerMetricSchema.optional(),
  resumo:             z.string().max(2000).optional(),
  apresentadora_id:   z.string().uuid().optional().nullable(),
  encerrado_em:       z.string().datetime({ offset: true }).optional().nullable(),
  manual_likes:       integerMetricSchema.optional(),
  manual_views:       integerMetricSchema.optional(),
  manual_comments:    integerMetricSchema.optional(),
  manual_shares:      integerMetricSchema.optional(),
  manual_diamonds:    integerMetricSchema.optional(),
  manual_orders:      integerMetricSchema.optional(),
  manual_gmv:         moneySchema.optional(),
  status_publicacao:  z.enum(['rascunho', 'revisado', 'publicado']).optional().default('rascunho'),
  origem_dados:       z.enum(['manual', 'api']).optional().default('manual'),
})

const liveManualSchema = z.object({
  cabine_id:          z.string().uuid(),
  cliente_id:         z.string().uuid().optional(),
  marca_id:           z.string().uuid().optional(),
  apresentador_id:    z.string().uuid().optional(),
  apresentador2_id:   z.string().uuid().optional(),
  gestor_id:          z.string().uuid().optional(),
  agenda_evento_id:   z.string().uuid().optional().nullable(),
  data:               z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hora_inicio:        z.string().regex(/^\d{2}:\d{2}$/),
  hora_fim:           z.string().regex(/^\d{2}:\d{2}$/),
  fat_gerado:         moneySchema,
  qtd_pedidos:        integerMetricSchema,
  resumo:             z.string().max(2000).optional(),
  manual_views:       integerMetricSchema.optional(),
  manual_likes:       integerMetricSchema.optional(),
  manual_comments:    integerMetricSchema.optional(),
  manual_shares:      integerMetricSchema.optional(),
  manual_diamonds:    integerMetricSchema.optional(),
  manual_orders:      integerMetricSchema.optional(),
  manual_gmv:         moneySchema.optional(),
  tipo:               z.enum(['cliente', 'afiliado', 'teste']).optional().default('cliente'),
  status_publicacao:  z.enum(['rascunho', 'revisado', 'publicado']).optional().default('rascunho'),
  origem_dados:       z.enum(['manual', 'api']).optional().default('manual'),
}).refine(d => d.hora_fim > d.hora_inicio, {
  message: 'hora_fim deve ser maior que hora_inicio',
}).refine(d => !d.apresentador2_id || d.apresentador2_id !== d.apresentador_id, {
  message: 'apresentadora 2 deve ser diferente da apresentadora 1',
})

const liveManualEditSchema = z.object({
  cabine_id:        z.string().uuid().nullable().optional(),
  cliente_id:       z.string().uuid().nullable().optional(),
  marca_id:         z.string().uuid().nullable().optional(),
  apresentador_id:  z.string().uuid().nullable().optional(),
  apresentador2_id: z.string().uuid().nullable().optional(),
  gestor_id:        z.string().uuid().nullable().optional(),
  data:             z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  hora_inicio:      z.string().regex(/^\d{2}:\d{2}$/).optional(),
  hora_fim:         z.string().regex(/^\d{2}:\d{2}$/).optional(),
  fat_gerado:       moneySchema.optional(),
  qtd_pedidos:      integerMetricSchema.optional(),
  resumo:           z.string().max(2000).optional(),
  manual_views:     integerMetricSchema.optional(),
  manual_likes:     integerMetricSchema.optional(),
  manual_comments:  integerMetricSchema.optional(),
  manual_shares:    integerMetricSchema.optional(),
  manual_diamonds:  integerMetricSchema.optional(),
  manual_orders:    integerMetricSchema.optional(),
  manual_gmv:       moneySchema.optional(),
  ads_gmv:          moneySchema.optional().nullable(),
  ads_cost:         moneySchema.optional().nullable(),
  live_impressions: integerMetricSchema.optional().nullable(),
  product_impressions: integerMetricSchema.optional().nullable(),
  product_clicks:   integerMetricSchema.optional().nullable(),
  avg_viewing_duration: z.preprocess(parseIntegerMetric, z.number().min(0)).optional().nullable(),
  new_followers:    integerMetricSchema.optional().nullable(),
  tipo:             z.enum(['cliente', 'afiliado', 'teste']).optional(),
  status_publicacao: z.enum(['rascunho', 'revisado', 'publicado']).optional(),
  agenda_evento_id: z.string().uuid().nullable().optional(),
  tiktok_username:  tiktokUsernameField,
  previsto_fim:     z.string().datetime({ offset: true }).nullable().optional(),
  status:           z.enum(['em_andamento', 'encerrada', 'cancelada']).optional(),
  origem_dados:     z.enum(['manual', 'api']).optional(),
})

function officialGmvFromPayload(payload = {}, fallback = {}) {
  return Number(
    payload.ads_gmv
    ?? payload.manual_gmv
    ?? payload.fat_gerado
    ?? fallback.ads_gmv
    ?? fallback.manual_gmv
    ?? fallback.fat_gerado
    ?? 0
  )
}

function officialOrdersFromPayload(payload = {}, fallback = {}) {
  return Number(
    payload.manual_orders
    ?? payload.qtd_pedidos
    ?? fallback.manual_orders
    ?? fallback.final_orders_count
    ?? 0
  )
}

const publicarSchema = z.object({
  status_publicacao: z.enum(['revisado', 'publicado']),
  motivo: z.string().max(500).optional(),
})

function liveStatusToAgendaStatus(status) {
  if (status === 'encerrada') return 'concluido'
  if (status === 'cancelada') return 'cancelado'
  if (status === 'em_andamento') return 'ao_vivo'
  return 'planejado'
}

function safeAgendaEnd(dataInicio, dataFim) {
  const inicio = new Date(dataInicio)
  const fim = dataFim ? new Date(dataFim) : null
  if (!Number.isNaN(inicio.getTime()) && fim && !Number.isNaN(fim.getTime()) && fim > inicio) return dataFim
  return new Date(inicio.getTime() + 4 * 60 * 60 * 1000).toISOString()
}

async function getLivePrimaryApresentadoraId(db, { tenantId, liveId, apresentadorUserId }) {
  const result = await db.query(
    `SELECT COALESCE(v2.apresentadora_id, ap.id) AS id
     FROM (SELECT 1) base
     LEFT JOIN LATERAL (
       SELECT lav.apresentadora_id
       FROM live_apresentadoras_v2 lav
       WHERE lav.tenant_id = $1::uuid
         AND lav.live_id = $2::uuid
       ORDER BY (lav.papel = 'principal') DESC, lav.criado_em ASC
       LIMIT 1
     ) v2 ON true
     LEFT JOIN LATERAL (
       SELECT a.id
       FROM apresentadoras a
       WHERE a.tenant_id = $1::uuid
         AND a.user_id = $3::uuid
       LIMIT 1
     ) ap ON true`,
    [tenantId, liveId, apresentadorUserId ?? null],
  )
  return result.rows[0]?.id ?? null
}

async function syncAgendaEventForLive(db, {
  tenantId,
  liveId,
  agendaEventoId,
  cabineId,
  marcaId,
  apresentadoraId,
  dataInicio,
  dataFim,
  status,
  observacoes,
  criadoPor,
}) {
  if (!tenantId || !liveId || !marcaId || !dataInicio) return null

  const agendaStatus = liveStatusToAgendaStatus(status)
  const agendaFim = safeAgendaEnd(dataInicio, dataFim)
  let eventId = agendaEventoId ?? null

  if (!eventId) {
    const existing = await db.query(
      `SELECT ae.id
       FROM agenda_eventos ae
       WHERE ae.tenant_id = $1::uuid
         AND ae.tipo = 'live'
         AND ae.status <> 'cancelado'
         AND (
           ae.live_id = $2::uuid
           OR (
             ae.live_id IS NULL
             AND ae.marca_id = $3::uuid
             AND ae.cabine_id IS NOT DISTINCT FROM $4::uuid
             AND ae.data_inicio < $6::timestamptz
             AND ae.data_fim > $5::timestamptz
           )
         )
       ORDER BY (ae.live_id = $2::uuid) DESC,
                ABS(EXTRACT(EPOCH FROM (ae.data_inicio - $5::timestamptz)))
       LIMIT 1`,
      [tenantId, liveId, marcaId, cabineId ?? null, dataInicio, agendaFim],
    )
    eventId = existing.rows[0]?.id ?? null
  }

  if (eventId) {
    const updated = await db.query(
      `UPDATE agenda_eventos
       SET tipo = 'live',
           marca_id = $3::uuid,
           cabine_id = $4::uuid,
           apresentadora_id = $5::uuid,
           data_inicio = $6::timestamptz,
           data_fim = $7::timestamptz,
           status = $8,
           live_id = $9::uuid,
           observacoes = COALESCE(NULLIF(observacoes, ''), $10),
           atualizado_em = NOW()
       WHERE id = $1::uuid
         AND tenant_id = $2::uuid
       RETURNING id`,
      [
        eventId,
        tenantId,
        marcaId,
        cabineId ?? null,
        apresentadoraId ?? null,
        dataInicio,
        agendaFim,
        agendaStatus,
        liveId,
        observacoes ?? 'Live sincronizada automaticamente pelo registro operacional.',
      ],
    )
    eventId = updated.rows[0]?.id ?? eventId
  } else {
    const inserted = await db.query(
      `INSERT INTO agenda_eventos (
         tenant_id, tipo, marca_id, cabine_id, apresentadora_id, data_inicio, data_fim,
         status, live_id, observacoes, criado_por
       )
       VALUES ($1,'live',$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        tenantId,
        marcaId,
        cabineId ?? null,
        apresentadoraId ?? null,
        dataInicio,
        agendaFim,
        agendaStatus,
        liveId,
        observacoes ?? 'Live criada automaticamente a partir do registro operacional.',
        criadoPor ?? null,
      ],
    )
    eventId = inserted.rows[0]?.id ?? null
  }

  if (eventId) {
    await db.query(
      `UPDATE lives
       SET agenda_evento_id = $1::uuid
       WHERE id = $2::uuid
         AND tenant_id = $3::uuid
         AND agenda_evento_id IS DISTINCT FROM $1::uuid`,
      [eventId, liveId, tenantId],
    )
  }

  return eventId
}

export async function livesRoutes(app) {

  const cabineRoleAccess = (app) => [
    app.authenticate,
    app.requirePapel(READ_CABINES),
  ]

  // POST /v1/lives — inicia live a partir da cabine reservada/ativa
  app.post('/v1/lives', { preHandler: [app.authenticate, app.requirePapel(WRITE_LIVES)] }, async (request, reply) => {
    const parsed = iniciarLiveSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id, sub, papel } = request.user
    const {
      cabine_id,
      cliente_id: requestedClienteId,
      marca_id: requestedMarcaId,
      apresentador_id: requestedApresentadoraIdLegacy,
      apresentadora_id: requestedApresentadoraIdNew,
      tiktok_username: rawTiktok,
      tipo,
      agenda_evento_id,
      previsto_fim: rawPrevistoFim,
    } = parsed.data
    const requestedApresentadoraId = requestedApresentadoraIdNew ?? requestedApresentadoraIdLegacy ?? null
    const previstoFim = rawPrevistoFim ? new Date(rawPrevistoFim) : null
    const hasTikTokUpdate = rawTiktok !== undefined
    let tiktokUsername = rawTiktok ?? null
    const ip = getRequestIp(request)
    return app.withTenant(tenant_id, async (db) => {
      await db.query('BEGIN')

      try {
        const cabineQ = await db.query(
          `SELECT id, numero, status, contrato_id, live_atual_id, ativo
           FROM cabines
           WHERE id = $1 AND tenant_id = $2::uuid
           FOR UPDATE`,
          [cabine_id, tenant_id]
        )
        const cabine = cabineQ.rows[0]

        if (!cabine) {
          await db.query('ROLLBACK')
          return reply.code(404).send({ error: 'Cabine não encontrada' })
        }

        if (cabine.ativo === false) {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'Cabine inativa não pode iniciar live', code: 'CABINE_INATIVA' })
        }

        // ── Resolução via agenda_eventos ─────────────────────────────────────
        // agenda_eventos usa marca_id; marcas tem cliente_id. Nenhuma coluna
        // live_id/cliente_id/titulo existe em agenda_eventos (schema migration 080).
        let resolvedAgendaEventoId = null
        let resolvedAgendaClienteId = null
        let resolvedMarcaId = requestedMarcaId ?? null
        let resolvedApresentadoraId = requestedApresentadoraId ?? null
        let resolvedPrevistoFim = previstoFim
        let resolvedTipo = tipo
        let agendaWarning = null

        try {
          let agendaEvento = null

          if (agenda_evento_id) {
            // Caminho explícito: evento passado no body
            const evQ = await db.query(
              `SELECT ae.id, ae.status, ae.marca_id, ae.cabine_id, ae.apresentadora_id,
                      ae.data_fim, ae.live_id,
                      m.cliente_id AS marca_cliente_id,
                      m.tipo AS marca_tipo,
                      ${tiktokUsernameSql({ marca: 'm', cliente: 'cl_marca' })} AS marca_tiktok_username
               FROM agenda_eventos ae
               LEFT JOIN marcas m ON m.id = ae.marca_id AND m.tenant_id = ae.tenant_id
               LEFT JOIN clientes cl_marca ON cl_marca.id = m.cliente_id AND cl_marca.tenant_id = ae.tenant_id
               WHERE ae.id = $1 AND ae.tenant_id = $2`,
              [agenda_evento_id, tenant_id]
            )
            if (!evQ.rows[0]) {
              await db.query('ROLLBACK')
              return reply.code(404).send({ error: 'Evento de agenda não encontrado', code: 'AGENDA_NOT_FOUND' })
            }
            agendaEvento = evQ.rows[0]
            if (agendaEvento.cabine_id && agendaEvento.cabine_id !== cabine_id) {
              await db.query('ROLLBACK')
              return reply.code(409).send({ error: 'Evento pertence a outra cabine', code: 'AGENDA_CABINE_MISMATCH' })
            }
          } else {
            // Caminho automático: busca evento de hoje nesta cabine
            const evQ = await db.query(
              `SELECT ae.id, ae.status, ae.marca_id, ae.cabine_id, ae.apresentadora_id,
                      ae.data_fim, ae.live_id,
                      m.cliente_id AS marca_cliente_id,
                      m.tipo AS marca_tipo,
                      ${tiktokUsernameSql({ marca: 'm', cliente: 'cl_marca' })} AS marca_tiktok_username
               FROM agenda_eventos ae
               LEFT JOIN marcas m ON m.id = ae.marca_id AND m.tenant_id = ae.tenant_id
               LEFT JOIN clientes cl_marca ON cl_marca.id = m.cliente_id AND cl_marca.tenant_id = ae.tenant_id
               WHERE ae.cabine_id = $1
                 AND ae.tenant_id = $2
                 AND ae.tipo = 'live'
                 AND ae.data_inicio::date = CURRENT_DATE
                 AND ae.status IN ('planejado', 'confirmado')
               ORDER BY ABS(EXTRACT(EPOCH FROM (ae.data_inicio - NOW())))
               LIMIT 1`,
              [cabine_id, tenant_id]
            )
            agendaEvento = evQ.rows[0] ?? null
          }

          if (agendaEvento) {
            resolvedAgendaEventoId = agendaEvento.id
            resolvedAgendaClienteId = agendaEvento.marca_cliente_id ?? null
            resolvedMarcaId = agendaEvento.marca_id ?? resolvedMarcaId
            resolvedApresentadoraId = agendaEvento.apresentadora_id ?? resolvedApresentadoraId
            resolvedPrevistoFim = resolvedPrevistoFim ?? (agendaEvento.data_fim ? new Date(agendaEvento.data_fim) : null)
            if (!tiktokUsername && agendaEvento.marca_tiktok_username) tiktokUsername = agendaEvento.marca_tiktok_username
            if (!requestedClienteId && agendaEvento.marca_tipo && agendaEvento.marca_tipo !== 'cliente') {
              resolvedTipo = agendaEvento.marca_tipo === 'afiliada' ? 'afiliado' : 'teste'
            }
            if (agendaEvento.live_id) {
              await db.query('ROLLBACK')
              return reply.code(409).send({ error: 'Evento de agenda já está vinculado a uma live', code: 'AGENDA_ALREADY_LINKED' })
            }
          }
          // Se não encontrou evento e agenda_evento_id não foi passado: segue legado e criará evento automático após INSERT
        } catch (agendaErr) {
          // Integração com agenda nunca bloqueia a live
          app.log.warn({ err: agendaErr, cabine_id, agenda_evento_id }, 'agenda: falha ao resolver evento, seguindo fluxo legado')
          agendaWarning = 'Falha ao verificar agenda — live iniciada sem vínculo de evento'
        }
        // ── fim resolução agenda ─────────────────────────────────────────────

        // Auto-reserve: se cabine não está reservada/ativa com contrato, busca contrato pelo cliente ou live_request
        let resolvedContratoId = cabine.contrato_id
        // Se agenda resolveu um cliente_id, usa como base; senão usa o do body
        let resolvedClienteId = resolvedAgendaClienteId ?? requestedClienteId ?? null
        if (!resolvedClienteId && resolvedMarcaId) {
          const marcaQ = await db.query(
            `SELECT m.cliente_id, m.tipo, ${tiktokUsernameSql({ marca: 'm', cliente: 'cl_marca' })} AS tiktok_username
             FROM marcas m
             LEFT JOIN clientes cl_marca ON cl_marca.id = m.cliente_id AND cl_marca.tenant_id = m.tenant_id
             WHERE m.id = $1 AND m.tenant_id = $2::uuid`,
            [resolvedMarcaId, tenant_id]
          )
          const marca = marcaQ.rows[0]
          if (!marca) {
            await db.query('ROLLBACK')
            return reply.code(404).send({ error: 'Marca não encontrada', code: 'MARCA_NOT_FOUND' })
          }
          resolvedClienteId = marca.cliente_id ?? null
          if (!requestedClienteId && marca.tipo && marca.tipo !== 'cliente') {
            resolvedTipo = marca.tipo === 'afiliada' ? 'afiliado' : 'teste'
          }
          if (!tiktokUsername && marca.tiktok_username) tiktokUsername = marca.tiktok_username
        }
        if (!['reservada', 'ao_vivo'].includes(cabine.status) || !cabine.contrato_id) {
          if (!['disponivel', 'ao_vivo', 'reservada'].includes(cabine.status)) {
            await db.query('ROLLBACK')
            return reply.code(409).send({ error: 'Cabine indisponível para iniciar live', code: 'CABINE_NOT_AVAILABLE' })
          }

          // Para afiliado/teste: não é necessário live_request nem cliente_id
          if (resolvedTipo === 'cliente' && !resolvedClienteId) {
            // Busca live_request aprovada para hoje nesta cabine (qualquer horário do dia)
            const lrQ = await db.query(
              `SELECT lr.cliente_id
               FROM live_requests lr
               WHERE lr.cabine_id = $1
                 AND lr.tenant_id = $2
                 AND lr.status = 'aprovada'
                 AND lr.data_solicitada = CURRENT_DATE
               ORDER BY ABS(EXTRACT(EPOCH FROM (lr.hora_inicio - NOW()::TIME)))
               LIMIT 1`,
              [cabine_id, tenant_id]
            )
            if (lrQ.rows[0]) {
              resolvedClienteId = lrQ.rows[0].cliente_id
            }
          }

          if (resolvedClienteId) {
            const ctLrQ = await db.query(
              `SELECT id FROM contratos
               WHERE cliente_id = $1 AND tenant_id = $2 AND status = 'ativo'
               ORDER BY ativado_em DESC NULLS LAST, criado_em DESC
               LIMIT 1`,
              [resolvedClienteId, tenant_id]
            )
            resolvedContratoId = ctLrQ.rows[0]?.id ?? null
            if (resolvedContratoId) {
              await db.query(
                `UPDATE cabines SET status = 'reservada', contrato_id = $1 WHERE id = $2 AND tenant_id = $3::uuid`,
                [resolvedContratoId, cabine_id, tenant_id]
              )
            }
          }
        }

        if (cabine.live_atual_id) {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'Cabine já possui uma live em andamento' })
        }

        const contratoQ = resolvedContratoId
          ? await db.query(
              `SELECT id, cliente_id, status
               FROM contratos
               WHERE id = $1 AND tenant_id = $2::uuid
               FOR UPDATE`,
              [resolvedContratoId, tenant_id]
            )
          : { rows: [] }
        let contrato = contratoQ.rows[0]
        if (contrato?.cliente_id) resolvedClienteId = contrato.cliente_id

        if (contrato && contrato.status !== 'ativo') {
          // Tenta encontrar contrato ativo para o mesmo cliente (contrato vinculado pode ser rascunho antigo)
          const clienteIdFallback = contrato?.cliente_id ?? cabine.cliente_id
          if (clienteIdFallback) {
            const activeCtQ = await db.query(
              `SELECT id, cliente_id, status FROM contratos
               WHERE cliente_id = $1 AND tenant_id = $2 AND status = 'ativo'
               ORDER BY ativado_em DESC NULLS LAST, criado_em DESC
               LIMIT 1`,
              [clienteIdFallback, tenant_id]
            )
            if (activeCtQ.rows[0]) {
              contrato = activeCtQ.rows[0]
              resolvedContratoId = contrato.id
              await db.query('UPDATE cabines SET contrato_id = $1 WHERE id = $2 AND tenant_id = $3::uuid', [contrato.id, cabine_id, tenant_id])
            }
          }
          if (contrato && contrato.status !== 'ativo') {
            await db.query('ROLLBACK')
            return reply.code(409).send({ error: 'Contrato em rascunho — ative o contrato em Clientes → Contratos → Ativar', code: 'CONTRACT_NOT_ACTIVE' })
          }
        }

        if (!resolvedClienteId && resolvedTipo === 'cliente') {
          await db.query('ROLLBACK')
          return reply.code(409).send({
            error: 'Live de tipo "cliente" requer cliente_id ou solicitação aprovada',
            code: 'CLIENTE_REQUIRED'
          })
        }

        // Bloqueio de inadimplência — apenas para tipo 'cliente'
        if (resolvedTipo === 'cliente' && resolvedClienteId) {
          const clienteQ = await db.query(
            `SELECT status FROM clientes WHERE id = $1 AND tenant_id = $2`,
            [resolvedClienteId, tenant_id]
          )
          if (clienteQ.rows[0]?.status === 'inadimplente') {
            await db.query('ROLLBACK')
            return reply.code(403).send({
              error: 'Cliente inadimplente — não é possível iniciar nova live',
              code: 'CLIENTE_INADIMPLENTE'
            })
          }
        }

        // ── Fallback: marca sistema do tenant para lives afiliado/teste sem marca ──
        if (['afiliado', 'teste'].includes(resolvedTipo) && !resolvedMarcaId) {
          const { rows: [marcaSistema] } = await db.query(
            `SELECT id FROM marcas WHERE tenant_id = $1::uuid AND sistema = TRUE LIMIT 1`,
            [tenant_id]
          )
          if (!marcaSistema) {
            await db.query('ROLLBACK')
            return reply.code(500).send({
              error: 'Marca sistema do tenant não encontrada — execute a migration 104'
            })
          }
          resolvedMarcaId = marcaSistema.id
        }
        // ── fim fallback marca sistema ───────────────────────────────────────────

        if (hasTikTokUpdate) {
          await updateCanonicalTikTokUsername(db, {
            tenantId: tenant_id,
            username: tiktokUsername,
            marcaId: resolvedMarcaId,
            clienteId: resolvedClienteId,
            contratoId: resolvedContratoId,
          })
        }

        let apresentadorUserId = null
        if (resolvedApresentadoraId) {
          const apRow = await db.query(
            `SELECT user_id FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid`,
            [resolvedApresentadoraId, tenant_id]
          )
          if (!apRow.rows[0]) {
            await db.query('ROLLBACK')
            return reply.code(404).send({ error: 'Apresentador não encontrado', code: 'APRESENTADOR_NOT_FOUND' })
          }
          apresentadorUserId = apRow.rows[0].user_id ?? null
        }

        const liveQ = await db.query(
          `INSERT INTO lives (tenant_id, cabine_id, cliente_id, apresentador_id, tipo,
                              status_publicacao, origem_dados, agenda_evento_id, previsto_fim, marca_id)
           VALUES ($1, $2, $3, $4, $5, 'rascunho', 'manual', $6, $7, $8)
           RETURNING id, cabine_id, iniciado_em, cliente_id, apresentador_id, tipo,
                     status_publicacao, origem_dados, agenda_evento_id, previsto_fim, marca_id`,
          [
            tenant_id,
            cabine_id,
            resolvedClienteId,
            apresentadorUserId,
            resolvedTipo,
            resolvedAgendaEventoId,
            resolvedPrevistoFim,
            resolvedMarcaId,
          ]
        )
        const live = liveQ.rows[0]

        if (resolvedAgendaEventoId) {
          await db.query(
            `UPDATE agenda_eventos SET status = 'ao_vivo',
                 live_id = $3,
                 atualizado_em = NOW()
             WHERE id = $1 AND tenant_id = $2::uuid`,
            [resolvedAgendaEventoId, tenant_id, live.id]
          )
        }

        if (resolvedApresentadoraId) {
          await db.query(
            `INSERT INTO live_apresentadoras_v2 (tenant_id, live_id, apresentadora_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (live_id, apresentadora_id) DO NOTHING`,
            [tenant_id, live.id, resolvedApresentadoraId],
          )
        }

        // ── Evento automático de agenda (se nenhum evento foi encontrado/vinculado) ──
        // Executado dentro da transação; falha é soft (nunca bloqueia a live).
        let finalAgendaEventoId = resolvedAgendaEventoId
        if (!resolvedAgendaEventoId && !agendaWarning) {
          try {
            // Usa marca já resolvida do payload; fallback busca por cliente.
            let marcaId = resolvedMarcaId ?? null
            if (!marcaId && resolvedClienteId) {
              const marcaQ = await db.query(
                `SELECT id FROM marcas
                 WHERE tenant_id = $1::uuid AND cliente_id = $2::uuid AND status = 'ativa'
                 ORDER BY criado_em ASC LIMIT 1`,
                [tenant_id, resolvedClienteId]
              )
              marcaId = marcaQ.rows[0]?.id ?? null
            }

            if (marcaId) {
              // previsto_fim informado pelo operador toma precedência; fallback de 4h só se nada foi enviado.
              const dataFimSql = resolvedPrevistoFim ? '$6::timestamptz' : "NOW() + interval '4 hours'"
              const params = resolvedPrevistoFim
                ? [tenant_id, cabine_id, marcaId, sub, live.id, resolvedPrevistoFim]
                : [tenant_id, cabine_id, marcaId, sub, live.id]
              const autoEvQ = await db.query(
                `INSERT INTO agenda_eventos
                   (tenant_id, cabine_id, tipo, status, marca_id, data_inicio, data_fim, observacoes, criado_por, live_id)
                 VALUES ($1, $2, 'live', 'ao_vivo', $3, NOW(), ${dataFimSql},
                         'Live iniciada sem agenda', $4, $5)
                 RETURNING id`,
                params
              )
              finalAgendaEventoId = autoEvQ.rows[0]?.id ?? null
              // Persiste vínculo na live recém-criada
              if (finalAgendaEventoId) {
                await db.query(
                  `UPDATE lives
                   SET agenda_evento_id = $1,
                       marca_id = COALESCE(marca_id, $4::uuid)
                   WHERE id = $2 AND tenant_id = $3::uuid`,
                  [finalAgendaEventoId, live.id, tenant_id, marcaId]
                )
              }
              app.log.info({ liveId: live.id, agendaEventoId: finalAgendaEventoId }, 'agenda: evento automático criado')
            } else {
              app.log.info({ liveId: live.id, resolvedClienteId }, 'agenda: sem marca_id disponível, evento automático omitido')
            }
          } catch (autoEvErr) {
            // Falha no evento automático nunca bloqueia a live
            app.log.warn({ err: autoEvErr, liveId: live.id }, 'agenda: falha ao criar evento automático (soft)')
            agendaWarning = agendaWarning ?? 'Falha ao criar evento automático de agenda'
          }
        }
        // ── fim evento automático ────────────────────────────────────────────

        await db.query(
          `UPDATE cabines
           SET status = 'ao_vivo', live_atual_id = $1
           WHERE id = $2 AND tenant_id = $3::uuid`,
          [live.id, cabine_id, tenant_id]
        )

        await logCabineEvent(db, {
          tenantId: tenant_id,
          cabineId: cabine_id,
          contratoId: resolvedContratoId,
          tipoEvento: 'cabine_live_iniciada',
          actorUserId: sub,
          actorPapel: papel,
          ip,
          payload: {
            live_id: live.id,
            cliente_id: resolvedClienteId,
            previous_status: cabine.status,
            agenda_evento_id: finalAgendaEventoId,
          },
        })

        await db.query('COMMIT')

        // Não espera 60s do cron — sincroniza connector imediatamente
        syncLives().catch(err =>
          app.log.warn({ err, liveId: live.id }, 'syncLives pós-iniciar-live falhou')
        )

        app.audit?.log?.(request, { action: 'live.start', entity_type: 'live', entity_id: live.id, metadata: { cabine_id, cliente_id: resolvedClienteId, contrato_id: resolvedContratoId, agenda_evento_id: finalAgendaEventoId } })?.catch(err => app.log.error({ err }, 'audit log failed'))

        const responseBody = { ...live, agenda_evento_id: finalAgendaEventoId }
        if (agendaWarning) responseBody.agenda_warning = agendaWarning
        return reply.code(201).send(responseBody)
      } catch (error) {
        await db.query('ROLLBACK')
        throw error
      }
    })
  })

  // POST /v1/lives/manual — cria live já encerrada (entrada manual pelo gestor)
  // Restrito a admin/gerente/produtor_live: apresentador NÃO pode criar
  // entradas retroativas (atribuição de comissão é responsabilidade do gestor).
  const gestorRoleAccess = [
    app.authenticate,
    app.requirePapel(['franqueador_master', 'franqueado', 'gerente', 'produtor_live']),
  ]
  app.post('/v1/lives/manual', { preHandler: gestorRoleAccess }, async (request, reply) => {
    const parsed = liveManualSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const d = parsed.data
    const { tenant_id, sub } = request.user
    const gestorId = d.gestor_id ?? sub

    // Para live manual: tipo 'cliente' exige cliente ou marca de cliente
    if (d.tipo === 'cliente' && !d.cliente_id && !d.marca_id) {
      return reply.code(400).send({
        error: 'Live de tipo "cliente" requer cliente_id ou marca_id',
        code: 'CLIENTE_REQUIRED'
      })
    }
    return app.withTenant(tenant_id, async (db) => {
      try {
        await db.query('BEGIN')

        let resolvedMarcaId = d.marca_id ?? null
        let resolvedClienteId = d.cliente_id ?? null

        if (resolvedMarcaId) {
          const marcaQ = await db.query(
            `SELECT id, cliente_id, tipo
             FROM marcas
             WHERE id = $1::uuid
               AND tenant_id = $2::uuid`,
            [resolvedMarcaId, tenant_id],
          )
          const marca = marcaQ.rows[0]
          if (!marca) {
            await db.query('ROLLBACK')
            return reply.code(404).send({ error: 'Marca não encontrada' })
          }
          resolvedClienteId = resolvedClienteId ?? marca.cliente_id ?? null
        }

        // ── Fallback: marca sistema do tenant para lives afiliado/teste sem marca ──
        if (['afiliado', 'teste'].includes(d.tipo) && !resolvedMarcaId) {
          const { rows: [marcaSistema] } = await db.query(
            `SELECT id FROM marcas WHERE tenant_id = $1::uuid AND sistema = TRUE LIMIT 1`,
            [tenant_id]
          )
          if (!marcaSistema) {
            await db.query('ROLLBACK')
            return reply.code(500).send({
              error: 'Marca sistema do tenant não encontrada — execute a migration 104'
            })
          }
          resolvedMarcaId = marcaSistema.id
        }
        // ── fim fallback marca sistema ───────────────────────────────────────────

        if (d.tipo === 'cliente' && !resolvedClienteId) {
          await db.query('ROLLBACK')
          return reply.code(400).send({
            error: 'Live de tipo "cliente" requer cliente_id ou marca de cliente',
            code: 'CLIENTE_REQUIRED'
          })
        }

        // Bloqueio de inadimplência — apenas para tipo 'cliente'
        if (d.tipo === 'cliente' && resolvedClienteId) {
          const clienteQ = await db.query(
            `SELECT status FROM clientes WHERE id = $1 AND tenant_id = $2`,
            [resolvedClienteId, tenant_id]
          )
          if (clienteQ.rows[0]?.status === 'inadimplente') {
            await db.query('ROLLBACK')
            return reply.code(403).send({
              error: 'Cliente inadimplente — não é possível iniciar nova live',
              code: 'CLIENTE_INADIMPLENTE'
            })
          }
        }

        const cab = await db.query(
          `SELECT c.contrato_id, ct.comissao_pct
             FROM cabines c
             LEFT JOIN contratos ct ON ct.id = c.contrato_id AND ct.status = 'ativo'
            WHERE c.id = $1`,
          [d.cabine_id]
        )
        const comissaoPct = Number(cab.rows[0]?.comissao_pct ?? 0)
        const comissao = officialGmvFromPayload(d) * (comissaoPct / 100)

        // Resolve apresentadoras.id → users.id (pode ser null para apresentadoras sem conta)
        let apresentadorUserId = null
        if (d.apresentador_id) {
          const apRow = await db.query(
            `SELECT user_id FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid`,
            [d.apresentador_id, tenant_id]
          )
          apresentadorUserId = apRow.rows[0]?.user_id ?? null
        }

        let apresentador2UserId = null
        if (d.apresentador2_id) {
          const ap2Row = await db.query(
            `SELECT user_id FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid`,
            [d.apresentador2_id, tenant_id]
          )
          apresentador2UserId = ap2Row.rows[0]?.user_id ?? null
        }

        const iniciado = saoPauloTimestamp(d.data, d.hora_inicio)
        const encerrado = saoPauloTimestamp(d.data, d.hora_fim)

        const ins = await db.query(
          `INSERT INTO lives
             (tenant_id, cabine_id, cliente_id, apresentador_id, gestor_id,
              status, iniciado_em, encerrado_em, fat_gerado, comissao_calculada,
              final_orders_count, resumo,
              manual_views, manual_likes, manual_comments, manual_shares, manual_diamonds,
              manual_orders, manual_gmv,
              tipo, status_publicacao, origem_dados, agenda_evento_id, marca_id)
           VALUES ($1,$2,$3,$4,$5,'encerrada',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
           RETURNING id`,
          [
            tenant_id, d.cabine_id, resolvedClienteId ?? null, apresentadorUserId, gestorId,
            iniciado, encerrado, d.fat_gerado, comissao, d.qtd_pedidos, d.resumo ?? null,
            d.manual_views ?? null, d.manual_likes ?? null,
            d.manual_comments ?? null, d.manual_shares ?? null, d.manual_diamonds ?? null,
            d.manual_orders ?? null, d.manual_gmv ?? null,
            d.tipo, d.status_publicacao, d.origem_dados, d.agenda_evento_id ?? null, resolvedMarcaId,
          ]
        )
        const liveId = ins.rows[0].id
        let finalAgendaEventoId = d.agenda_evento_id ?? null

        if (d.agenda_evento_id) {
          await db.query(
            `UPDATE agenda_eventos
             SET status = 'concluido',
                 live_id = $3::uuid,
                 atualizado_em = NOW()
             WHERE id = $1::uuid
               AND tenant_id = $2::uuid`,
            [d.agenda_evento_id, tenant_id, liveId],
          )
        }

        if (d.apresentador_id) {
          await db.query(
            `INSERT INTO live_apresentadoras_v2 (tenant_id, live_id, apresentadora_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (live_id, apresentadora_id) DO NOTHING`,
            [tenant_id, liveId, d.apresentador_id],
          )
        }

        if (apresentador2UserId) {
          await db.query(
            `INSERT INTO live_apresentadores (tenant_id, live_id, apresentador_id)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [tenant_id, liveId, apresentador2UserId]
          )
        }

        if (!resolvedMarcaId && resolvedClienteId) {
          const marcaQ = await db.query(
            `SELECT id
             FROM marcas
             WHERE tenant_id = $1::uuid
               AND cliente_id = $2::uuid
               AND status = 'ativa'
             ORDER BY criado_em ASC
             LIMIT 1`,
            [tenant_id, resolvedClienteId],
          )
          resolvedMarcaId = marcaQ.rows[0]?.id ?? null
          if (resolvedMarcaId) {
            await db.query(
              `UPDATE lives
               SET marca_id = $1
               WHERE id = $2 AND tenant_id = $3::uuid AND marca_id IS NULL`,
              [resolvedMarcaId, liveId, tenant_id],
            )
          }
        }

        if (resolvedMarcaId) {
          finalAgendaEventoId = await syncAgendaEventForLive(db, {
            tenantId: tenant_id,
            liveId,
            agendaEventoId: finalAgendaEventoId,
            cabineId: d.cabine_id,
            marcaId: resolvedMarcaId,
            apresentadoraId: d.apresentador_id ?? null,
            dataInicio: iniciado,
            dataFim: encerrado,
            status: 'encerrada',
            observacoes: d.resumo ?? 'Live manual sincronizada com a agenda.',
            criadoPor: gestorId,
          }) ?? finalAgendaEventoId
        }

        if (resolvedMarcaId) {
          await upsertVendaAtribuida(db, {
            tenantId: tenant_id,
            origem: 'live',
            origemId: liveId,
            marcaId: resolvedMarcaId,
            apresentadoraId: d.apresentador_id ?? null,
            data: d.data,
            gmv: officialGmvFromPayload(d),
            pedidos: officialOrdersFromPayload(d),
            comissaoApresentadora: comissao,
          })
        }

        await db.query('COMMIT')
        return reply.code(201).send({ id: liveId, agenda_evento_id: finalAgendaEventoId })
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
    const { tenant_id, sub } = request.user
    return app.withTenant(tenant_id, async (db) => {
      try {
        await db.query('BEGIN')

        const liveQ = await db.query(
          `SELECT l.id, l.cabine_id, l.cliente_id, l.marca_id, l.apresentador_id, l.gestor_id, l.agenda_evento_id,
                  ${tiktokUsernameSql({ marca: 'm_current', cliente: 'cl_tiktok', contrato: 'ct' })} AS tiktok_username,
                  l.previsto_fim, l.tipo, l.status_publicacao, l.origem_dados,
                  l.status, l.fat_gerado, l.manual_gmv, l.ads_gmv, l.final_orders_count, l.manual_orders, l.iniciado_em, l.encerrado_em,
                  c.contrato_id
             FROM lives l
             LEFT JOIN cabines c ON c.id = l.cabine_id AND c.tenant_id = l.tenant_id
             LEFT JOIN contratos ct ON ct.id = c.contrato_id AND ct.tenant_id = l.tenant_id
             LEFT JOIN marcas m_current ON m_current.id = l.marca_id AND m_current.tenant_id = l.tenant_id
             LEFT JOIN clientes cl_tiktok ON cl_tiktok.id = COALESCE(m_current.cliente_id, l.cliente_id, ct.cliente_id) AND cl_tiktok.tenant_id = l.tenant_id
            WHERE l.id = $1
              AND l.tenant_id = $2::uuid
            FOR UPDATE OF l`,
          [request.params.id, tenant_id]
        )
        const live = liveQ.rows[0]
        if (!live) {
          await db.query('ROLLBACK')
          return reply.code(404).send({ error: 'Live não encontrada neste tenant' })
        }
        if (live.status === 'cancelada') {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'Live cancelada não pode ser editada' })
        }

        const cabineId = d.cabine_id ?? live.cabine_id
        let comissao = undefined
        const gmvMudou = d.fat_gerado !== undefined || d.manual_gmv !== undefined || d.ads_gmv !== undefined
        if (gmvMudou) {
          const cab = await db.query(
            `SELECT ct.comissao_pct FROM cabines c
               LEFT JOIN contratos ct ON ct.id = c.contrato_id AND ct.status = 'ativo'
              WHERE c.id = $1
                AND c.tenant_id = $2::uuid`,
            [cabineId, tenant_id]
          )
          const pct = Number(cab.rows[0]?.comissao_pct ?? 0)
          comissao = officialGmvFromPayload(d, live) * (pct / 100)
        }

        const updates = []
        const values = []
        let idx = 1
        let nextIniciadoEm = live.iniciado_em
        let nextEncerradoEm = live.encerrado_em

        const addField = (col, val) => { updates.push(`${col} = $${idx++}`); values.push(val) }

        let resolvedApresentadorId
        if (d.apresentador_id !== undefined) {
          if (d.apresentador_id === null) {
            // Desvincula apresentadora principal.
            resolvedApresentadorId = null
          } else {
            const apRow = await db.query('SELECT user_id FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid', [d.apresentador_id, tenant_id])
            if (!apRow.rows[0]) {
              await db.query('ROLLBACK')
              return reply.code(404).send({ error: 'Apresentadora não encontrada' })
            }
            // user_id é nullable — apresentadoras sem conta não atualizam lives.apresentador_id
            if (apRow.rows[0].user_id) resolvedApresentadorId = apRow.rows[0].user_id
          }
        }

        let resolvedClienteId = d.cliente_id
        if (d.marca_id !== undefined && d.marca_id !== null) {
          const marcaQ = await db.query(
            `SELECT id, cliente_id FROM marcas WHERE id = $1 AND tenant_id = $2::uuid`,
            [d.marca_id, tenant_id]
          )
          if (!marcaQ.rows[0]) {
            await db.query('ROLLBACK')
            return reply.code(404).send({ error: 'Marca não encontrada' })
          }
          resolvedClienteId = resolvedClienteId ?? marcaQ.rows[0].cliente_id ?? null
        }

        // ── Fallback: marca sistema do tenant para lives afiliado/teste sem marca ──
        // Aplica quando o tipo efetivo é afiliado/teste e a marca efetiva ficaria nula.
        {
          const tipoEfetivo = d.tipo ?? live.tipo
          const marcaEfetiva = d.marca_id !== undefined ? d.marca_id : (live.marca_id ?? null)
          if (['afiliado', 'teste'].includes(tipoEfetivo) && !marcaEfetiva) {
            const { rows: [marcaSistema] } = await db.query(
              `SELECT id FROM marcas WHERE tenant_id = $1::uuid AND sistema = TRUE LIMIT 1`,
              [tenant_id]
            )
            if (!marcaSistema) {
              await db.query('ROLLBACK')
              return reply.code(500).send({
                error: 'Marca sistema do tenant não encontrada — execute a migration 104'
              })
            }
            // Sobrescreve d.marca_id para que addField persista o valor correto
            d.marca_id = marcaSistema.id
          }
        }
        // ── fim fallback marca sistema ───────────────────────────────────────────

        // cabine_id nunca vira NULL por engano — live sempre tem cabine.
        if (d.cabine_id) addField('cabine_id', d.cabine_id)
        if (resolvedClienteId !== undefined) addField('cliente_id', resolvedClienteId)
        if (d.marca_id !== undefined) addField('marca_id', d.marca_id)
        if (resolvedApresentadorId !== undefined) addField('apresentador_id', resolvedApresentadorId)
        if (d.gestor_id    !== undefined) addField('gestor_id',          d.gestor_id)
        if (d.tipo         !== undefined) addField('tipo',               d.tipo)
        if (d.status_publicacao !== undefined) addField('status_publicacao', d.status_publicacao)
        if (d.fat_gerado      !== undefined) addField('fat_gerado', d.fat_gerado)
        if (gmvMudou) addField('comissao_calculada', comissao)
        if (d.qtd_pedidos     !== undefined) addField('final_orders_count', d.qtd_pedidos)
        if (d.resumo          !== undefined) addField('resumo',             d.resumo)
        if (d.manual_views    !== undefined) addField('manual_views',    d.manual_views)
        if (d.manual_likes    !== undefined) addField('manual_likes',    d.manual_likes)
        if (d.manual_comments !== undefined) addField('manual_comments', d.manual_comments)
        if (d.manual_shares   !== undefined) addField('manual_shares',   d.manual_shares)
        if (d.manual_diamonds !== undefined) addField('manual_diamonds', d.manual_diamonds)
        if (d.manual_orders          !== undefined) addField('manual_orders',          d.manual_orders)
        if (d.manual_gmv             !== undefined) addField('manual_gmv',             d.manual_gmv)
        if (d.ads_gmv                !== undefined) addField('ads_gmv',                d.ads_gmv)
        if (d.ads_cost               !== undefined) addField('ads_cost',               d.ads_cost)
        if (d.live_impressions       !== undefined) addField('live_impressions',       d.live_impressions)
        if (d.product_impressions    !== undefined) addField('product_impressions',    d.product_impressions)
        if (d.product_clicks         !== undefined) addField('product_clicks',         d.product_clicks)
        if (d.avg_viewing_duration   !== undefined) addField('avg_viewing_duration',   d.avg_viewing_duration)
        if (d.new_followers          !== undefined) addField('new_followers',          d.new_followers)
        if (d.agenda_evento_id !== undefined) addField('agenda_evento_id', d.agenda_evento_id)
        if (d.previsto_fim    !== undefined) addField('previsto_fim',   d.previsto_fim)
        if (d.origem_dados    !== undefined) addField('origem_dados',   d.origem_dados)
        if (d.status          !== undefined) {
          addField('status', d.status)
          if (d.status === 'encerrada' && !live.encerrado_em) {
            addField('encerrado_em', new Date().toISOString())
          }
        }

        if (d.data !== undefined || d.hora_inicio !== undefined || d.hora_fim !== undefined) {
          const currentInicio = new Date(live.iniciado_em)
          const currentFim    = new Date(live.encerrado_em)
          const data    = d.data        ?? saoPauloDateInput(currentInicio)
          const hInicio = d.hora_inicio ?? saoPauloTimeInput(currentInicio)
          const hFim    = d.hora_fim    ?? saoPauloTimeInput(currentFim)
          if (hFim <= hInicio) {
            await db.query('ROLLBACK')
            return reply.code(400).send({ error: 'hora_fim deve ser maior que hora_inicio' })
          }
          nextIniciadoEm = saoPauloTimestamp(data, hInicio)
          nextEncerradoEm = saoPauloTimestamp(data, hFim)
          addField('iniciado_em',  nextIniciadoEm)
          addField('encerrado_em', nextEncerradoEm)
        }

        if (updates.length > 0) {
          values.push(request.params.id)
          values.push(tenant_id)
          await db.query(`UPDATE lives SET ${updates.join(', ')} WHERE id = $${idx} AND tenant_id = $${idx + 1}::uuid`, values)
        }

        if (d.tiktok_username !== undefined) {
          await updateCanonicalTikTokUsername(db, {
            tenantId: tenant_id,
            username: d.tiktok_username,
            marcaId: d.marca_id !== undefined ? d.marca_id : live.marca_id,
            clienteId: resolvedClienteId !== undefined ? resolvedClienteId : live.cliente_id,
            contratoId: live.contrato_id,
          })
        }

        if (d.apresentador_id !== undefined) {
          await db.query('DELETE FROM live_apresentadoras_v2 WHERE live_id = $1 AND tenant_id = $2::uuid', [request.params.id, tenant_id])
          if (d.apresentador_id) {
            await db.query(
              `INSERT INTO live_apresentadoras_v2 (tenant_id, live_id, apresentadora_id)
               VALUES ($1, $2, $3)
               ON CONFLICT (live_id, apresentadora_id) DO NOTHING`,
              [tenant_id, request.params.id, d.apresentador_id]
            )
          }
        }

        if (d.marca_id) {
          await upsertVendaAtribuida(db, {
            tenantId: tenant_id,
            origem: 'live',
            origemId: request.params.id,
            marcaId: d.marca_id,
            apresentadoraId: d.apresentador_id ?? null,
            data: (d.data ?? new Date(live.iniciado_em).toISOString().slice(0, 10)),
            gmv: officialGmvFromPayload(d, live),
            pedidos: officialOrdersFromPayload(d, live),
          })
        }

        // Rastreia mudanças em fat_gerado e manual_gmv na tabela live_metric_revisions
        if (d.fat_gerado !== undefined && d.fat_gerado !== live.fat_gerado) {
          await db.query(
            `INSERT INTO live_metric_revisions (tenant_id, live_id, campo, valor_anterior, valor_novo, alterado_por, alterado_em)
             VALUES ($1, $2, 'fat_gerado', $3, $4, $5, NOW())`,
            [tenant_id, request.params.id, live.fat_gerado?.toString() ?? null, d.fat_gerado.toString(), sub]
          )
        }
        if (d.manual_gmv !== undefined && d.manual_gmv !== live.manual_gmv) {
          await db.query(
            `INSERT INTO live_metric_revisions (tenant_id, live_id, campo, valor_anterior, valor_novo, alterado_por, alterado_em)
             VALUES ($1, $2, 'manual_gmv', $3, $4, $5, NOW())`,
            [tenant_id, request.params.id, live.manual_gmv?.toString() ?? null, d.manual_gmv.toString(), sub]
          )
        }

        if ('apresentador2_id' in d) {
          await db.query(`DELETE FROM live_apresentadores WHERE live_id = $1 AND tenant_id = $2::uuid`, [request.params.id, tenant_id])
          if (d.apresentador2_id) {
            const ap2Row = await db.query('SELECT user_id FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid', [d.apresentador2_id, tenant_id])
            const ap2UserId = ap2Row.rows[0]?.user_id
            if (ap2UserId) {
              await db.query(
                `INSERT INTO live_apresentadores (tenant_id, live_id, apresentador_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
                [tenant_id, request.params.id, ap2UserId]
              )
            }
          }
        }

        // ── Sync live→agenda_eventos: agenda é espelho operacional da live ─────
        const nextMarcaId = d.marca_id !== undefined ? d.marca_id : live.marca_id
        let nextApresentadoraId = d.apresentador_id !== undefined ? d.apresentador_id : null
        if (nextMarcaId && d.apresentador_id === undefined) {
          nextApresentadoraId = await getLivePrimaryApresentadoraId(db, {
            tenantId: tenant_id,
            liveId: request.params.id,
            apresentadorUserId: resolvedApresentadorId !== undefined ? resolvedApresentadorId : live.apresentador_id,
          })
        }
        if (nextMarcaId) {
          await syncAgendaEventForLive(db, {
            tenantId: tenant_id,
            liveId: request.params.id,
            agendaEventoId: d.agenda_evento_id !== undefined ? d.agenda_evento_id : live.agenda_evento_id,
            cabineId,
            marcaId: nextMarcaId,
            apresentadoraId: nextApresentadoraId ?? null,
            dataInicio: nextIniciadoEm,
            dataFim: d.previsto_fim ?? nextEncerradoEm ?? live.previsto_fim,
            status: d.status ?? live.status,
            observacoes: d.resumo ?? 'Live sincronizada com a agenda.',
            criadoPor: sub,
          })
        }
        // ── fim sync ────────────────────────────────────────────────────────────

        // Audit log — diff de campos efetivamente alterados
        const auditFields = [
          'cabine_id', 'cliente_id', 'marca_id', 'apresentador_id', 'gestor_id',
          'agenda_evento_id', 'tiktok_username', 'previsto_fim', 'tipo',
          'status', 'status_publicacao', 'origem_dados',
          'fat_gerado', 'manual_gmv', 'final_orders_count',
        ]
        const diff = {}
        for (const f of auditFields) {
          const dKey = f === 'final_orders_count' ? 'qtd_pedidos' : f
          if (d[dKey] !== undefined && String(d[dKey] ?? '') !== String(live[f] ?? '')) {
            diff[f] = { before: live[f] ?? null, after: d[dKey] ?? null }
          }
        }
        if (Object.keys(diff).length > 0) {
          app.audit?.log?.(request, {
            action: 'live.update',
            entity_type: 'live',
            entity_id: request.params.id,
            metadata: { diff },
          })?.catch?.(err => app.log.warn({ err }, 'audit log live.update falhou'))
        }

        await db.query('COMMIT')

        // Recalcula comissões se a base oficial de GMV mudou (fire-and-forget).
        if (gmvMudou) {
          const gmvAtualizado = officialGmvFromPayload(d, live)
          app.withTenant(tenant_id, async (db2) => {
            try {
              await calcularComissoesDaLive(db2, {
                liveId: request.params.id,
                tenantId: tenant_id,
                gmv: gmvAtualizado,
              })
            } catch (commErr) {
              app.log.warn({ err: commErr, liveId: request.params.id }, 'commission-engine: falha no recálculo pós-edição (soft)')
            }
          }).catch(err => app.log.warn({ err, liveId: request.params.id }, 'commission-engine: withTenant falhou'))
        }

        return reply.send({ ok: true })
      } catch (e) {
        await db.query('ROLLBACK')
        throw e
      }
    })
  })

  // GET /v1/lives/:id — live selecionada pelo Live Toolkit
  app.get('/v1/lives/:id', { preHandler: cabineRoleAccess(app) }, async (request, reply) => {
    const { tenant_id, papel, sub } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const params = [tenant_id, request.params.id]
      let visibility = ''
      if (papel === 'cliente_parceiro') {
        params.push(sub)
        visibility = `
          AND l.status_publicacao = 'publicado'
          AND l.cliente_id = (
            SELECT id FROM clientes
            WHERE user_id = $3 AND tenant_id = $1::uuid
            LIMIT 1
          )`
      }

      const result = await db.query(
        `SELECT l.id, l.tenant_id, l.cabine_id, l.cliente_id, l.apresentador_id,
                l.gestor_id, l.status, l.tipo, l.status_publicacao, l.origem_dados,
                l.iniciado_em, l.encerrado_em, l.fat_gerado, l.comissao_calculada,
                l.final_orders_count, l.final_peak_viewers,
                l.final_total_likes, l.final_total_comments,
                l.final_total_shares, l.final_gifts_diamonds,
                l.resumo, l.previsto_fim,
                l.manual_views, l.manual_likes, l.manual_comments, l.manual_shares,
                l.manual_diamonds, l.manual_orders, l.manual_gmv,
                l.ads_gmv, l.ads_cost, l.live_impressions, l.product_impressions,
                l.product_clicks, l.avg_viewing_duration, l.new_followers,
                l.ads_import_batch_id, l.ads_import_row_id, l.ads_metrics_updated_at,
                c.numero AS cabine_numero, c.contrato_id,
                cl.nome AS cliente_nome,
                COALESCE(l.marca_id, va_marca.marca_id) AS marca_id,
                va_marca.marca_nome AS marca_nome,
                ${tiktokUsernameSql({ marca: 'va_marca', cliente: 'cl_tiktok', contrato: 'ct' })} AS tiktok_username,
                COALESCE(ap_v2.nome, ap_agenda.nome, ap_user.nome, CASE WHEN u.papel IN ('apresentador', 'apresentadora', 'produtor_live') THEN u.nome END) AS apresentadora_nome,
                COALESCE(ap_v2.nome, ap_agenda.nome, ap_user.nome, CASE WHEN u.papel IN ('apresentador', 'apresentadora', 'produtor_live') THEN u.nome END) AS apresentador_nome,
                COALESCE(ap_v2.apresentadora_id, ae.apresentadora_id, ap_user.id) AS apresentadora_id,
                ap_extra.apresentadora_id AS apresentadora2_id,
                ap_extra.apresentadora_id AS apresentador2_id,
                ap_extra.nome AS apresentadora2_nome,
                COALESCE(l.agenda_evento_id, ae.id) AS agenda_evento_id,
                ae.data_inicio AS agenda_data_inicio,
                ae.data_fim AS agenda_data_fim,
                ae.observacoes AS agenda_titulo,
                ls.viewer_count, ls.total_viewers, ls.total_orders,
                ls.gmv AS gmv_atual, ls.likes_count, ls.comments_count,
                ls.gifts_diamonds, ls.shares_count
         FROM lives l
         JOIN cabines c ON c.id = l.cabine_id AND c.tenant_id = l.tenant_id
         LEFT JOIN contratos ct ON ct.id = c.contrato_id AND ct.tenant_id = l.tenant_id
         LEFT JOIN clientes cl ON cl.id = l.cliente_id AND cl.tenant_id = l.tenant_id
         LEFT JOIN users u ON u.id = l.apresentador_id AND u.tenant_id = l.tenant_id
         LEFT JOIN apresentadoras ap_user ON ap_user.user_id = l.apresentador_id AND ap_user.tenant_id = l.tenant_id
         LEFT JOIN LATERAL (
           SELECT ae2.id, ae2.data_inicio, ae2.data_fim, ae2.observacoes, ae2.apresentadora_id
           FROM agenda_eventos ae2
           WHERE (ae2.live_id = l.id OR ae2.id = l.agenda_evento_id OR ae2.cabine_id = l.cabine_id)
             AND ae2.tenant_id = l.tenant_id
             AND ae2.tipo = 'live'
             AND (ae2.live_id = l.id OR ae2.id = l.agenda_evento_id OR ae2.data_inicio::date = l.iniciado_em::date)
           ORDER BY ABS(EXTRACT(EPOCH FROM (ae2.data_inicio - l.iniciado_em)))
           LIMIT 1
         ) ae ON true
         LEFT JOIN apresentadoras ap_agenda ON ap_agenda.id = ae.apresentadora_id AND ap_agenda.tenant_id = l.tenant_id
         LEFT JOIN LATERAL (
           SELECT lav.apresentadora_id, a.nome
           FROM live_apresentadoras_v2 lav
           JOIN apresentadoras a ON a.id = lav.apresentadora_id AND a.tenant_id = lav.tenant_id
           WHERE lav.live_id = l.id
             AND lav.tenant_id = l.tenant_id
           ORDER BY (lav.papel = 'principal') DESC, lav.criado_em ASC
           LIMIT 1
         ) ap_v2 ON true
         LEFT JOIN LATERAL (
           SELECT ap_extra_profile.id AS apresentadora_id,
                  COALESCE(ap_extra_profile.nome, u_extra.nome) AS nome
           FROM live_apresentadores la_extra
           LEFT JOIN users u_extra
             ON u_extra.id = la_extra.apresentador_id
            AND u_extra.tenant_id = la_extra.tenant_id
           LEFT JOIN apresentadoras ap_extra_profile
             ON ap_extra_profile.user_id = la_extra.apresentador_id
            AND ap_extra_profile.tenant_id = la_extra.tenant_id
           WHERE la_extra.live_id = l.id
             AND la_extra.tenant_id = l.tenant_id
           ORDER BY la_extra.criado_em ASC
           LIMIT 1
         ) ap_extra ON true
         LEFT JOIN LATERAL (
           SELECT m.id, m.id AS marca_id, m.nome AS marca_nome, m.tipo, m.cliente_id, m.tiktok_username
           FROM marcas m
           LEFT JOIN vendas_atribuidas va ON va.marca_id = m.id
            AND va.tenant_id = m.tenant_id
            AND va.origem = 'live'
            AND va.origem_id = l.id
           WHERE m.tenant_id = l.tenant_id
             AND (m.id = l.marca_id OR va.id IS NOT NULL)
           ORDER BY (m.id = l.marca_id) DESC, va.criado_em DESC NULLS LAST
           LIMIT 1
         ) va_marca ON true
         LEFT JOIN clientes cl_tiktok ON cl_tiktok.id = COALESCE(va_marca.cliente_id, l.cliente_id, ct.cliente_id) AND cl_tiktok.tenant_id = l.tenant_id
         LEFT JOIN LATERAL (
           SELECT viewer_count, total_viewers, total_orders, gmv,
                  likes_count, comments_count, gifts_diamonds, shares_count
           FROM live_snapshots
           WHERE live_id = l.id
             AND tenant_id = l.tenant_id
           ORDER BY captured_at DESC
           LIMIT 1
         ) ls ON true
         WHERE l.tenant_id = $1::uuid
           AND l.id = $2
           ${visibility}
         LIMIT 1`,
        params
      )

      const live = result.rows[0]
      if (!live) return reply.code(404).send({ error: 'Live não encontrada' })
      return live
    })
  })

  // GET /v1/lives
  app.get('/v1/lives', { preHandler: cabineRoleAccess(app) }, async (request) => {
    const { tenant_id, papel, sub } = request.user
    const statusFilter = request.query?.status // 'em_andamento' | 'encerrada' | undefined
    const reqLimit = Math.min(200, Math.max(10, parseInt(request.query?.limit ?? '50', 10)))
    const reqOffset = Math.max(0, parseInt(request.query?.page ?? '0', 10)) * reqLimit
    const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
    const dateRe = /^\d{4}-\d{2}-\d{2}$/
    const fDataInicio = dateRe.test(request.query?.data_inicio ?? '') ? request.query.data_inicio : null
    const fDataFim = dateRe.test(request.query?.data_fim ?? '') ? request.query.data_fim : null
    const fMarcaId = UUID_RE.test(request.query?.marca_id ?? '') ? request.query.marca_id : null
    const fApresentadoraId = UUID_RE.test(request.query?.apresentadora_id ?? '') ? request.query.apresentadora_id : null
    return app.withTenant(tenant_id, async (db) => {
      const params = [tenant_id]
      let where = 'WHERE l.tenant_id = $1::uuid'
      if (statusFilter && ['em_andamento', 'encerrada', 'faturada'].includes(statusFilter)) {
        params.push(statusFilter)
        where += ` AND l.status = $${params.length}`
      }
      // Filtros opcionais da barra de "Lives realizadas" (server-side).
      if (fDataInicio) {
        params.push(fDataInicio)
        where += ` AND (l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date >= $${params.length}::date`
      }
      if (fDataFim) {
        params.push(fDataFim)
        where += ` AND (l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date <= $${params.length}::date`
      }
      if (fMarcaId) {
        params.push(fMarcaId)
        where += ` AND COALESCE(l.marca_id, va_marca.marca_id) = $${params.length}::uuid`
      }
      if (fApresentadoraId) {
        params.push(fApresentadoraId)
        where += ` AND COALESCE(ap_v2.apresentadora_id, ae.apresentadora_id, ap_user.id) = $${params.length}::uuid`
      }
      // cliente_parceiro só enxerga lives publicadas e do seu próprio cliente
      if (papel === 'cliente_parceiro') {
        params.push(tenant_id)
        const clienteSubIdx = params.length
        params.push(sub)
        where += ` AND l.status_publicacao = 'publicado'`
        where += ` AND l.cliente_id = (SELECT id FROM clientes WHERE user_id = $${clienteSubIdx + 1} AND tenant_id = $${clienteSubIdx}::uuid LIMIT 1)`
      }
      const result = await db.query(
        `SELECT l.id, l.tenant_id, l.cabine_id, l.cliente_id, l.apresentador_id,
                l.gestor_id, l.status, l.tipo, l.status_publicacao, l.origem_dados,
                l.iniciado_em, l.encerrado_em, l.fat_gerado, l.comissao_calculada,
                l.final_orders_count, l.final_peak_viewers,
                l.final_total_likes, l.final_total_comments,
                l.final_total_shares, l.final_gifts_diamonds,
                l.resumo, l.previsto_fim,
                l.manual_views, l.manual_likes, l.manual_comments, l.manual_shares,
                l.manual_diamonds, l.manual_orders, l.manual_gmv,
                l.ads_gmv, l.ads_cost, l.live_impressions, l.product_impressions,
                l.product_clicks, l.avg_viewing_duration, l.new_followers,
                l.ads_import_batch_id, l.ads_import_row_id, l.ads_metrics_updated_at,
                c.numero AS cabine_numero, c.contrato_id,
                cl.nome AS cliente_nome,
                COALESCE(l.marca_id, va_marca.marca_id) AS marca_id,
                va_marca.marca_nome AS marca_nome,
                ${tiktokUsernameSql({ marca: 'va_marca', cliente: 'cl_tiktok', contrato: 'ct' })} AS tiktok_username,
                COALESCE(ap_v2.nome, ap_agenda.nome, ap_user.nome, CASE WHEN u.papel IN ('apresentador', 'apresentadora', 'produtor_live') THEN u.nome END) AS apresentadora_nome,
                COALESCE(ap_v2.nome, ap_agenda.nome, ap_user.nome, CASE WHEN u.papel IN ('apresentador', 'apresentadora', 'produtor_live') THEN u.nome END) AS apresentador_nome,
                COALESCE(ap_v2.apresentadora_id, ae.apresentadora_id, ap_user.id) AS apresentadora_id,
                ap_extra.apresentadora_id AS apresentadora2_id,
                ap_extra.apresentadora_id AS apresentador2_id,
                ap_extra.nome AS apresentadora2_nome,
                COALESCE(l.agenda_evento_id, ae.id) AS agenda_evento_id,
                ae.data_inicio AS agenda_data_inicio,
                ae.data_fim AS agenda_data_fim,
                ae.observacoes AS agenda_titulo,
                ls.viewer_count, ls.total_viewers, ls.total_orders,
                ls.gmv AS gmv_atual, ls.likes_count, ls.comments_count,
                ls.gifts_diamonds, ls.shares_count
         FROM lives l
         JOIN cabines c ON c.id = l.cabine_id AND c.tenant_id = l.tenant_id
         LEFT JOIN contratos ct ON ct.id = c.contrato_id AND ct.tenant_id = l.tenant_id
         LEFT JOIN clientes cl ON cl.id = l.cliente_id AND cl.tenant_id = l.tenant_id
         LEFT JOIN users u ON u.id = l.apresentador_id AND u.tenant_id = l.tenant_id
         LEFT JOIN apresentadoras ap_user ON ap_user.user_id = l.apresentador_id AND ap_user.tenant_id = l.tenant_id
         LEFT JOIN LATERAL (
           SELECT ae2.id, ae2.data_inicio, ae2.data_fim, ae2.observacoes, ae2.apresentadora_id
           FROM agenda_eventos ae2
           WHERE (ae2.live_id = l.id OR ae2.id = l.agenda_evento_id OR ae2.cabine_id = l.cabine_id)
             AND ae2.tenant_id = l.tenant_id
             AND ae2.tipo = 'live'
             AND (ae2.live_id = l.id OR ae2.id = l.agenda_evento_id OR ae2.data_inicio::date = l.iniciado_em::date)
           ORDER BY ABS(EXTRACT(EPOCH FROM (ae2.data_inicio - l.iniciado_em)))
           LIMIT 1
         ) ae ON true
         LEFT JOIN apresentadoras ap_agenda ON ap_agenda.id = ae.apresentadora_id AND ap_agenda.tenant_id = l.tenant_id
         LEFT JOIN LATERAL (
           SELECT lav.apresentadora_id, a.nome
           FROM live_apresentadoras_v2 lav
           JOIN apresentadoras a ON a.id = lav.apresentadora_id AND a.tenant_id = lav.tenant_id
           WHERE lav.live_id = l.id
             AND lav.tenant_id = l.tenant_id
           ORDER BY (lav.papel = 'principal') DESC, lav.criado_em ASC
           LIMIT 1
         ) ap_v2 ON true
         LEFT JOIN LATERAL (
           SELECT ap_extra_profile.id AS apresentadora_id,
                  COALESCE(ap_extra_profile.nome, u_extra.nome) AS nome
           FROM live_apresentadores la_extra
           LEFT JOIN users u_extra
             ON u_extra.id = la_extra.apresentador_id
            AND u_extra.tenant_id = la_extra.tenant_id
           LEFT JOIN apresentadoras ap_extra_profile
             ON ap_extra_profile.user_id = la_extra.apresentador_id
            AND ap_extra_profile.tenant_id = la_extra.tenant_id
           WHERE la_extra.live_id = l.id
             AND la_extra.tenant_id = l.tenant_id
           ORDER BY la_extra.criado_em ASC
           LIMIT 1
         ) ap_extra ON true
         LEFT JOIN LATERAL (
           SELECT m.id, m.id AS marca_id, m.nome AS marca_nome, m.tipo, m.cliente_id, m.tiktok_username
           FROM marcas m
           LEFT JOIN vendas_atribuidas va ON va.marca_id = m.id
            AND va.tenant_id = m.tenant_id
            AND va.origem = 'live'
            AND va.origem_id = l.id
           WHERE m.tenant_id = l.tenant_id
             AND (m.id = l.marca_id OR va.id IS NOT NULL)
           ORDER BY (m.id = l.marca_id) DESC, va.criado_em DESC NULLS LAST
           LIMIT 1
         ) va_marca ON true
         LEFT JOIN clientes cl_tiktok ON cl_tiktok.id = COALESCE(va_marca.cliente_id, l.cliente_id, ct.cliente_id) AND cl_tiktok.tenant_id = l.tenant_id
         LEFT JOIN LATERAL (
           SELECT viewer_count, total_viewers, total_orders, gmv,
                  likes_count, comments_count, gifts_diamonds, shares_count
           FROM live_snapshots
           WHERE live_id = l.id
             AND tenant_id = l.tenant_id
           ORDER BY captured_at DESC
           LIMIT 1
         ) ls ON true
         ${where}
         ORDER BY l.iniciado_em DESC LIMIT ${reqLimit} OFFSET ${reqOffset}`,
        params
      )
      return result.rows
    })
  })

  // GET /v1/lives/duplicatas — agrupa lives possivelmente duplicadas em clusters.
  // Heurística (soft, sem constraint rígida): mesma cabine com horários
  // sobrepostos, OU mesma marca + mesma apresentadora no mesmo dia.
  app.get('/v1/lives/duplicatas', { preHandler: cabineRoleAccess(app) }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const pares = await db.query(`
        WITH base AS (
          SELECT
            l.id,
            l.cabine_id,
            l.marca_id,
            l.iniciado_em,
            COALESCE(l.encerrado_em, l.previsto_fim, l.iniciado_em) AS fim,
            (l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
            COALESCE(ap_v2.apresentadora_id, ap_user.id) AS apresentadora_id
          FROM lives l
          LEFT JOIN apresentadoras ap_user ON ap_user.user_id = l.apresentador_id AND ap_user.tenant_id = l.tenant_id
          LEFT JOIN LATERAL (
            SELECT lav.apresentadora_id
            FROM live_apresentadoras_v2 lav
            WHERE lav.live_id = l.id AND lav.tenant_id = l.tenant_id
            ORDER BY (lav.papel = 'principal') DESC, lav.criado_em ASC
            LIMIT 1
          ) ap_v2 ON true
          WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
            AND l.status <> 'cancelada'
        )
        SELECT a.id AS id_a, b.id AS id_b,
          CASE
            WHEN a.cabine_id = b.cabine_id AND a.iniciado_em < b.fim AND b.iniciado_em < a.fim
              THEN 'cabine_horario'
            ELSE 'marca_apresentadora_dia'
          END AS motivo
        FROM base a
        JOIN base b ON b.id > a.id
        WHERE
          (a.cabine_id = b.cabine_id AND a.iniciado_em < b.fim AND b.iniciado_em < a.fim)
          OR (a.marca_id IS NOT NULL AND a.marca_id = b.marca_id
              AND a.apresentadora_id IS NOT NULL AND a.apresentadora_id = b.apresentadora_id
              AND a.dia = b.dia)
      `)

      if (pares.rows.length === 0) return { clusters: [] }

      // União de pares em clusters (union-find com path halving).
      const parent = new Map()
      const find = (x) => {
        while (parent.get(x) !== x) {
          parent.set(x, parent.get(parent.get(x)))
          x = parent.get(x)
        }
        return x
      }
      const union = (x, y) => { parent.set(find(x), find(y)) }
      const motivoDe = new Map()
      for (const { id_a, id_b, motivo } of pares.rows) {
        if (!parent.has(id_a)) parent.set(id_a, id_a)
        if (!parent.has(id_b)) parent.set(id_b, id_b)
        union(id_a, id_b)
        for (const id of [id_a, id_b]) {
          if (!motivoDe.has(id)) motivoDe.set(id, new Set())
          motivoDe.get(id).add(motivo)
        }
      }

      const ids = [...parent.keys()]
      const detalhe = await db.query(`
        SELECT
          l.id, l.iniciado_em, l.encerrado_em, l.status, l.status_publicacao,
          COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0) AS gmv,
          c.numero AS cabine_numero,
          COALESCE(va_m.nome, m.nome, cl.nome, 'Sem marca') AS marca_nome,
          COALESCE(ap_v2.nome, ap_user.nome, u.nome, 'Sem apresentadora') AS apresentadora_nome
        FROM lives l
        JOIN cabines c ON c.id = l.cabine_id AND c.tenant_id = l.tenant_id
        LEFT JOIN marcas m ON m.id = l.marca_id AND m.tenant_id = l.tenant_id
        LEFT JOIN clientes cl ON cl.id = l.cliente_id AND cl.tenant_id = l.tenant_id
        LEFT JOIN users u ON u.id = l.apresentador_id AND u.tenant_id = l.tenant_id
        LEFT JOIN apresentadoras ap_user ON ap_user.user_id = l.apresentador_id AND ap_user.tenant_id = l.tenant_id
        LEFT JOIN LATERAL (
          SELECT a.nome
          FROM live_apresentadoras_v2 lav
          JOIN apresentadoras a ON a.id = lav.apresentadora_id AND a.tenant_id = lav.tenant_id
          WHERE lav.live_id = l.id AND lav.tenant_id = l.tenant_id
          ORDER BY (lav.papel = 'principal') DESC, lav.criado_em ASC
          LIMIT 1
        ) ap_v2 ON true
        LEFT JOIN LATERAL (
          SELECT m2.nome
          FROM vendas_atribuidas va
          JOIN marcas m2 ON m2.id = va.marca_id AND m2.tenant_id = va.tenant_id
          WHERE va.origem = 'live' AND va.origem_id = l.id AND va.tenant_id = l.tenant_id
          LIMIT 1
        ) va_m ON true
        WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
          AND l.id = ANY($1::uuid[])
      `, [ids])

      const byId = new Map(detalhe.rows.map((r) => [r.id, r]))
      const clusters = new Map()
      for (const id of ids) {
        const root = find(id)
        if (!clusters.has(root)) clusters.set(root, [])
        const row = byId.get(id)
        if (!row) continue
        clusters.get(root).push({
          id: row.id,
          iniciado_em: row.iniciado_em,
          encerrado_em: row.encerrado_em,
          status: row.status,
          status_publicacao: row.status_publicacao,
          gmv: Number(row.gmv ?? 0),
          cabine_numero: row.cabine_numero,
          marca_nome: row.marca_nome,
          apresentadora_nome: row.apresentadora_nome,
          motivos: [...(motivoDe.get(id) ?? [])],
        })
      }

      const result = [...clusters.values()]
        .filter((lives) => lives.length > 1)
        .map((lives) => {
          const motivos = new Set()
          for (const live of lives) for (const m of live.motivos) motivos.add(m)
          return {
            motivos: [...motivos],
            total: lives.length,
            lives: lives.sort((a, b) => new Date(a.iniciado_em) - new Date(b.iniciado_em)),
          }
        })
        .sort((a, b) => b.total - a.total)

      return { clusters: result }
    })
  })

  // DELETE /v1/lives/:id
  app.delete('/v1/lives/:id', { preHandler: gestorRoleAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      await db.query('BEGIN')
      try {
        const liveQ = await db.query(
          `SELECT id, status, cabine_id, iniciado_em, agenda_evento_id
             FROM lives
            WHERE id = $1
              AND tenant_id = $2::uuid
            FOR UPDATE`,
          [request.params.id, tenant_id],
        )
        const live = liveQ.rows[0]
        if (!live) {
          await db.query('ROLLBACK')
          return reply.code(404).send({ error: 'Live não encontrada' })
        }

        if (live.status === 'em_andamento' && live.cabine_id) {
          await db.query(
            `UPDATE cabines
                SET status = 'disponivel',
                    live_atual_id = NULL
              WHERE id = $1
                AND tenant_id = $2::uuid`,
            [live.cabine_id, tenant_id],
          )

          const agendaCanceladaQ = await db.query(
            `UPDATE agenda_eventos
                SET status = 'cancelado',
                    atualizado_em = NOW()
              WHERE tenant_id = $1::uuid
                AND status = 'ao_vivo'
                AND (
                  live_id = $2::uuid
                  OR ($3::uuid IS NOT NULL AND id = $3::uuid)
                )
              RETURNING id`,
            [tenant_id, live.id, live.agenda_evento_id ?? null],
          )
          if ((agendaCanceladaQ.rows?.length ?? 0) === 0) {
            await db.query(
              `UPDATE agenda_eventos
                  SET status = 'cancelado',
                      atualizado_em = NOW()
                WHERE tenant_id = $1::uuid
                  AND cabine_id = $2::uuid
                  AND tipo = 'live'
                  AND status = 'ao_vivo'
                  AND (data_inicio AT TIME ZONE 'America/Sao_Paulo')::date =
                      ($3::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date`,
              [tenant_id, live.cabine_id, live.iniciado_em],
            )
          }
        }

        await db.query(`DELETE FROM vendas_atribuidas WHERE origem = 'live' AND origem_id = $1 AND tenant_id = $2::uuid`, [request.params.id, tenant_id])
        await db.query('DELETE FROM live_apresentadoras_v2 WHERE live_id = $1 AND tenant_id = $2::uuid', [request.params.id, tenant_id])
        await db.query('DELETE FROM live_apresentadores WHERE live_id = $1 AND tenant_id = $2::uuid', [request.params.id, tenant_id])
        await db.query('DELETE FROM live_snapshots WHERE live_id = $1 AND tenant_id = $2::uuid', [request.params.id, tenant_id])
        await db.query('DELETE FROM lives WHERE id = $1 AND tenant_id = $2::uuid', [request.params.id, tenant_id])
        await db.query('COMMIT')

        app.audit?.log?.(request, {
          action: 'deletar_live',
          entity_type: 'lives',
          entity_id: request.params.id,
        }).catch(() => {})

        if (live.status === 'em_andamento' && managerHas(live.id)) {
          stopConnector(live.id).catch(err =>
            app.log.error({ err, liveId: live.id }, 'tiktokManager: falha ao parar connector na exclusão')
          )
        }

        return reply.code(204).send()
      } catch (e) {
        await db.query('ROLLBACK')
        if (e.code === '23503') {
          return reply.code(409).send({
            error: 'Live possui vínculos no banco e não pode ser excluída definitivamente.',
            code: 'LIVE_FOREIGN_KEY_DEPENDENCY',
          })
        }
        throw e
      }
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
          `SELECT id, cabine_id, cliente_id, apresentador_id, status, iniciado_em, marca_id, agenda_evento_id
           FROM lives
           WHERE id = $1 AND tenant_id = $2::uuid AND status = 'em_andamento'
           FOR UPDATE`,
          [request.params.id, tenant_id]
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
        const comissao = officialGmvFromPayload(parsed.data) * (comissaoPct / 100)
        const encerradoEm = parsed.data.encerrado_em ? new Date(parsed.data.encerrado_em) : null
        let encerramentoApresentadorUserId = null
        if (parsed.data.apresentadora_id) {
          const apRow = await db.query(
            `SELECT user_id FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid`,
            [parsed.data.apresentadora_id, tenant_id]
          )
          if (!apRow.rows[0]) {
            await db.query('ROLLBACK')
            return reply.code(404).send({ error: 'Apresentadora não encontrada', code: 'APRESENTADORA_NOT_FOUND' })
          }
          encerramentoApresentadorUserId = apRow.rows[0].user_id ?? null
        }

        await db.query(
          `UPDATE lives
           SET status = 'encerrada',
               encerrado_em = COALESCE($13::timestamptz, NOW()),
               fat_gerado = $1, comissao_calculada = $2,
               final_orders_count = COALESCE($3, final_orders_count),
               resumo = COALESCE($4, resumo),
               manual_likes       = COALESCE($6, manual_likes),
               manual_views       = COALESCE($7, manual_views),
               manual_orders      = COALESCE($8, manual_orders),
               manual_gmv         = COALESCE($9, manual_gmv),
               status_publicacao  = $10,
               origem_dados       = $11,
               apresentador_id    = COALESCE($14::uuid, apresentador_id),
               manual_comments    = COALESCE($15, manual_comments),
               manual_shares      = COALESCE($16, manual_shares),
               manual_diamonds    = COALESCE($17, manual_diamonds)
           WHERE id = $5 AND tenant_id = $12::uuid`,
          [
            parsed.data.fat_gerado,
            comissao,
            parsed.data.qtd_pedidos ?? null,
            parsed.data.resumo ?? null,
            request.params.id,
            parsed.data.manual_likes       ?? null,
            parsed.data.manual_views       ?? null,
            parsed.data.manual_orders      ?? null,
            parsed.data.manual_gmv         ?? null,
            parsed.data.status_publicacao,
            parsed.data.origem_dados,
            tenant_id,
            encerradoEm,
            encerramentoApresentadorUserId,
            parsed.data.manual_comments ?? null,
            parsed.data.manual_shares ?? null,
            parsed.data.manual_diamonds ?? null,
          ]
        )

        if (parsed.data.apresentadora_id) {
          await db.query(
            `INSERT INTO live_apresentadoras_v2 (tenant_id, live_id, apresentadora_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (live_id, apresentadora_id) DO NOTHING`,
            [tenant_id, live.id, parsed.data.apresentadora_id],
          )
        }

        const marcaQ = live.marca_id
          ? { rows: [{ id: live.marca_id }] }
          : await db.query(
              `SELECT id
               FROM marcas
               WHERE tenant_id = $1::uuid
                 AND cliente_id = $2::uuid
                 AND status = 'ativa'
               ORDER BY criado_em ASC
               LIMIT 1`,
              [tenant_id, live.cliente_id],
            )
        if (marcaQ.rows[0]) {
          const apresentadoraQ = await db.query(
            `SELECT COALESCE(v2.apresentadora_id, agenda.apresentadora_id, user_ap.id) AS id
             FROM (SELECT 1) base
             LEFT JOIN LATERAL (
               SELECT lav.apresentadora_id
               FROM live_apresentadoras_v2 lav
               WHERE lav.live_id = $2
                 AND lav.tenant_id = $1::uuid
               ORDER BY (lav.papel = 'principal') DESC, lav.criado_em ASC
               LIMIT 1
             ) v2 ON true
             LEFT JOIN LATERAL (
               SELECT ae.apresentadora_id
               FROM agenda_eventos ae
               WHERE ae.tenant_id = $1::uuid
                 AND (
                   ae.live_id = $2::uuid
                   OR ($6::uuid IS NOT NULL AND ae.id = $6::uuid)
                   OR (
                     ae.cabine_id = $4
                     AND ae.tipo = 'live'
                     AND ae.data_inicio::date = $5::date
                   )
                 )
               ORDER BY ABS(EXTRACT(EPOCH FROM (ae.data_inicio - $5::timestamptz)))
               LIMIT 1
             ) agenda ON true
             LEFT JOIN LATERAL (
               SELECT a.id
               FROM apresentadoras a
               WHERE a.user_id = $3
                 AND a.tenant_id = $1::uuid
               LIMIT 1
             ) user_ap ON true`,
            [tenant_id, live.id, live.apresentador_id, live.cabine_id, live.iniciado_em, live.agenda_evento_id ?? null],
          )
          await upsertVendaAtribuida(db, {
            tenantId: tenant_id,
            origem: 'live',
            origemId: live.id,
            marcaId: marcaQ.rows[0].id,
            apresentadoraId: parsed.data.apresentadora_id ?? apresentadoraQ.rows[0]?.id ?? null,
            data: (encerradoEm ?? new Date()).toISOString().slice(0, 10),
            gmv: parsed.data.fat_gerado,
            pedidos: parsed.data.qtd_pedidos ?? 0,
            comissaoApresentadora: comissao,
          })
        }

        // Deduct live duration from contrato's horas_consumidas
        if (contrato && live.iniciado_em) {
          const duracaoHoras = ((encerradoEm?.getTime() ?? Date.now()) - new Date(live.iniciado_em).getTime()) / 3_600_000
          await db.query(
            `UPDATE contratos
             SET horas_consumidas = horas_consumidas + $1
             WHERE id = $2`,
            [duracaoHoras, contrato.id]
          )
        }

        const marcaIdForAgenda = live.marca_id ?? marcaQ.rows[0]?.id ?? null
        let apresentadoraIdForAgenda = parsed.data.apresentadora_id ?? null
        if (marcaIdForAgenda && !apresentadoraIdForAgenda) {
          apresentadoraIdForAgenda = await getLivePrimaryApresentadoraId(db, {
            tenantId: tenant_id,
            liveId: live.id,
            apresentadorUserId: encerramentoApresentadorUserId ?? live.apresentador_id,
          })
        }
        const syncedAgendaId = await syncAgendaEventForLive(db, {
          tenantId: tenant_id,
          liveId: live.id,
          agendaEventoId: live.agenda_evento_id ?? null,
          cabineId: live.cabine_id,
          marcaId: marcaIdForAgenda,
          apresentadoraId: apresentadoraIdForAgenda,
          dataInicio: live.iniciado_em,
          dataFim: (encerradoEm ?? new Date()).toISOString(),
          status: 'encerrada',
          observacoes: parsed.data.resumo ?? 'Live encerrada e sincronizada com a agenda.',
          criadoPor: sub,
        })
        if (!syncedAgendaId) {
          const agendaEncerradaQ = await db.query(
            `UPDATE agenda_eventos
             SET status = 'concluido',
                 live_id = COALESCE(live_id, $2::uuid),
                 atualizado_em = NOW()
             WHERE tenant_id = $1::uuid
               AND (
                 live_id = $2::uuid
                 OR ($3::uuid IS NOT NULL AND id = $3::uuid)
               )
             RETURNING id`,
            [tenant_id, live.id, live.agenda_evento_id ?? null]
          )
          if ((agendaEncerradaQ.rows?.length ?? 0) === 0) {
            await db.query(
              `UPDATE agenda_eventos
               SET status = 'concluido',
                   live_id = COALESCE(live_id, $4::uuid),
                   atualizado_em = NOW()
               WHERE tenant_id = $1::uuid
                 AND cabine_id = $2::uuid
                 AND tipo = 'live'
                 AND status = 'ao_vivo'
                 AND data_inicio::date = $3::date`,
              [tenant_id, live.cabine_id, live.iniciado_em, live.id]
            )
          }
        }
        // ── fim encerramento agenda ──────────────────────────────────────────

        // Migration 105 removeu status 'ativa' das cabines — cabine sempre volta para 'disponivel'
        const proximoStatus = 'disponivel'
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

        // Motor de comissões — recalcula variável da apresentadora; fixo entra no ranking consolidado.
        const gmvFinal = officialGmvFromPayload(parsed.data)
        app.withTenant(tenant_id, async (db2) => {
          try {
            await calcularComissoesDaLive(db2, {
              liveId: live.id,
              tenantId: tenant_id,
              gmv: gmvFinal,
            })
          } catch (commErr) {
            app.log.warn({ err: commErr, liveId: live.id }, 'commission-engine: falha no cálculo pós-encerramento (soft)')
          }
        }).catch(err => app.log.warn({ err, liveId: live.id }, 'commission-engine: withTenant falhou'))

        // Parar connector TikTok e fazer flush final do snapshot (fire-and-forget)
        if (managerHas(live.id)) {
          stopConnector(live.id).catch(err =>
            app.log.error({ err, liveId: live.id }, 'tiktokManager: falha ao parar connector no encerramento')
          )
        }

        // F1: notificação por e-mail — fire-and-forget, jamais bloqueia o response.
        // Lê tenant fora da conexão RLS (app.db.query, sem set_config tenant).
        ;(async () => {
          try {
            const tQ = await app.db.query(
              `SELECT email_contato, notif_email_ativo, notif_live_meta
               FROM tenants WHERE id = $1`,
              [tenant_id],
            )
            const tenant = tQ.rows[0]
            if (!tenant?.email_contato) return

            const duracaoMs = live.iniciado_em
              ? Date.now() - new Date(live.iniciado_em).getTime()
              : 0
            const hh = String(Math.floor(duracaoMs / 3600000)).padStart(2, '0')
            const mm = String(Math.floor((duracaoMs % 3600000) / 60000)).padStart(2, '0')
            const ss = String(Math.floor((duracaoMs % 60000) / 1000)).padStart(2, '0')

            await notify({
              app,
              tenantId: tenant_id,
              to: tenant.email_contato,
              template: 'live_encerrada',
              refId: live.id,
              settings: {
                notif_email_ativo: tenant.notif_email_ativo,
                notif_live_meta: tenant.notif_live_meta,
              },
              settingsKey: 'notif_live_meta',
              dedupe: true,
              vars: {
                gmv: parsed.data.fat_gerado,
                qtd_pedidos: parsed.data.qtd_pedidos,
                viewers: parsed.data.viewers ?? '—',
                duracao: `${hh}:${mm}:${ss}`,
              },
            })
          } catch (err) {
            app.log.error({ err, liveId: live.id }, 'mailer: falha ao notificar live_encerrada')
          }
        })()

        app.audit?.log?.(request, { action: 'live.end', entity_type: 'live', entity_id: live.id, metadata: { cabine_id: live.cabine_id, fat_gerado: parsed.data.fat_gerado, comissao_calculada: comissao, qtd_pedidos: parsed.data.qtd_pedidos ?? null } })?.catch(err => app.log.error({ err }, 'audit log failed'))
        return { ok: true, fat_gerado: parsed.data.fat_gerado, comissao_calculada: comissao }
      } catch (error) {
        await db.query('ROLLBACK')
        throw error
      }
    })
  })

  // PATCH /v1/lives/:id/publicar — altera status_publicacao de live
  app.patch('/v1/lives/:id/publicar', { preHandler: [app.authenticate, app.requirePapel(['franqueador_master', 'franqueado', 'gerente', 'operacional'])] }, async (request, reply) => {
    const parsed = publicarSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id, sub, papel } = request.user
    const { status_publicacao, motivo } = parsed.data

    return app.withTenant(tenant_id, async (db) => {
      const liveQ = await db.query(
        `SELECT id, status_publicacao, marca_id, ads_gmv, manual_gmv, fat_gerado FROM lives WHERE id = $1`,
        [request.params.id]
      )
      const live = liveQ.rows[0]
      if (!live) return reply.code(404).send({ error: 'Live não encontrada' })

      // Validação de state machine: únicas transições permitidas são
      //   rascunho → revisado  e  revisado → publicado
      const transicoesValidas = {
        rascunho: 'revisado',
        revisado:  'publicado',
      }
      const statusAtual = live.status_publicacao
      if (transicoesValidas[statusAtual] !== status_publicacao) {
        return reply.code(422).send({
          error: `Transição inválida: '${statusAtual}' → '${status_publicacao}'. Permitido: rascunho → revisado, revisado → publicado`,
        })
      }

      // Pré-requisito: marca obrigatória pra publicar — engine de comissão
      // (commission-engine.js:53) retorna [] sem marca, gerando lives "fantasma"
      // no ranking sem vendas atribuídas. Lucas reportou isso (WEVANS 67bbeef6).
      if (status_publicacao === 'publicado' && !live.marca_id) {
        return reply.code(422).send({
          error: 'Defina a marca da live antes de publicar — necessária para calcular comissão.',
          code: 'MARCA_OBRIGATORIA_PUBLICAR',
        })
      }

      await db.query('BEGIN')
      try {
        const resultado = await db.query(
          `UPDATE lives SET status_publicacao = $1 WHERE id = $2
           RETURNING id, status_publicacao`,
          [status_publicacao, request.params.id]
        )

        // Persiste motivo em live_metric_revisions, seguindo o mesmo padrão de fat_gerado/manual_gmv
        if (motivo) {
          await db.query(
            `INSERT INTO live_metric_revisions (tenant_id, live_id, campo, valor_anterior, valor_novo, alterado_por, alterado_em)
             VALUES ($1, $2, 'status_publicacao', $3, $4, $5, NOW())`,
            [tenant_id, request.params.id, statusAtual, status_publicacao, sub]
          )
        }

        await db.query('COMMIT')

        // Registra na auditoria se existir
        app.audit?.log?.(request, {
          action: 'lives.publicar',
          entity_type: 'live',
          entity_id: request.params.id,
          metadata: { status_publicacao, de: statusAtual, para: status_publicacao, motivo, alterado_por: sub, papel }
        })?.catch(err => app.log.error({ err }, 'audit log failed'))

        // Engine de comissões — gera vendas_atribuidas pra cada apresentadora
        // da live. Fire-and-forget (não bloqueia transição). Requer marca,
        // já validada acima.
        if (status_publicacao === 'publicado') {
          const gmvFinal = officialGmvFromPayload({}, live)
          app.withTenant(tenant_id, async (db2) => {
            try {
              await calcularComissoesDaLive(db2, {
                liveId: request.params.id,
                tenantId: tenant_id,
                gmv: gmvFinal,
              })
            } catch (err) {
              app.log.warn({ err, liveId: request.params.id }, 'commission-engine: falha pós-publicar (soft)')
            }
          }).catch(err => app.log.warn({ err, liveId: request.params.id }, 'commission-engine: withTenant falhou'))
        }

        return resultado.rows[0]
      } catch (e) {
        await db.query('ROLLBACK')
        throw e
      }
    })
  })

  // GET /v1/lives/:id/historico-gmv — retorna histórico de alterações de GMV
  app.get('/v1/lives/:id/historico-gmv', { preHandler: cabineRoleAccess(app) }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT campo, valor_anterior, valor_novo, motivo, alterado_em,
                u.nome AS alterado_por_nome
         FROM live_metric_revisions r
         LEFT JOIN users u ON u.id = r.alterado_por
         WHERE r.live_id = $1 AND r.tenant_id = $2
         ORDER BY r.alterado_em DESC`,
        [request.params.id, tenant_id]
      )
      return { historico: result.rows }
    })
  })
}
