import { z } from 'zod'
import { has as managerHas, stopConnector, syncLives } from '../services/tiktok-connector-manager.js'
import { READ_CABINES, WRITE_LIVES } from '../config/role_groups.js'
import { origemDados } from '../plugins/auth.js'
import { notify } from '../services/mailer.js'
import { getRequestIp, logCabineEvent } from '../lib/cabine-events.js'
import { calcularComissoesDaLive } from '../services/commission-engine.js'
import { calcularComissaoApresentadora, isFimDeSemanaSP } from '../services/comissao.js'
import { moneySchema } from '../lib/money.js'
import { invalidateHomeDashboard } from './home.js'
import { saoPauloDateInput, saoPauloTimeInput, saoPauloTimestamp } from '../lib/timezone.js'
import { tiktokUsernameField, tiktokUsernameSql, updateCanonicalTikTokUsername } from '../lib/tiktok-username.js'
import { ensureClienteMarca } from '../services/client-brand.js'
import { applyApresentadorasToLive } from '../lib/live-rateio.js'
import { seedRateioPlanejado } from '../lib/agenda-turnos.js'

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
  ads_cost:             moneySchema.optional().nullable(),
  live_impressions:     integerMetricSchema.optional().nullable(),
  product_impressions:  integerMetricSchema.optional().nullable(),
  product_clicks:       integerMetricSchema.optional().nullable(),
  avg_viewing_duration: z.preprocess(parseIntegerMetric, z.number().min(0)).optional().nullable(),
  new_followers:        integerMetricSchema.optional().nullable(),
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
  ads_cost:             moneySchema.optional().nullable(),
  live_impressions:     integerMetricSchema.optional().nullable(),
  product_impressions:  integerMetricSchema.optional().nullable(),
  product_clicks:       integerMetricSchema.optional().nullable(),
  avg_viewing_duration: z.preprocess(parseIntegerMetric, z.number().min(0)).optional().nullable(),
  new_followers:        integerMetricSchema.optional().nullable(),
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
  // Rateio da live entre apresentadoras que se revezaram — "a Ana fez 4h e vendeu R$ 3.000,
  // a Bia fez 5h e vendeu R$ 2.000". Mesmo formato absoluto que a revisão do import já usa;
  // quem valida a soma contra o GMV e a duração da live é normalizarRateio, no lib.
  apresentadoras:   z.array(z.object({
    apresentadora_id: z.string().uuid(),
    gmv:      z.coerce.number().min(0).optional(),
    segundos: z.coerce.number().int().min(0).optional(),
  })).min(1).optional(),
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
           -- O sync roda em QUALQUER patch de live com marca e só conhece a apresentadora
           -- escalar. Com turnos gravados, sobrescrever o espelho achataria o revezamento
           -- em uma pessoa só; quem manda no espelho é PUT /v1/agenda/:id/apresentadoras.
           apresentadora_id = CASE
             WHEN EXISTS (SELECT 1 FROM agenda_evento_apresentadoras aea
                           WHERE aea.agenda_evento_id = agenda_eventos.id)
             THEN agenda_eventos.apresentadora_id
             ELSE $5::uuid
           END,
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

        // ── Marca obrigatória: toda live tem marca (exige-ou-erra) ──
        if (!resolvedMarcaId && resolvedTipo === 'cliente' && resolvedClienteId) {
          resolvedMarcaId = await ensureClienteMarca(db, { tenantId: tenant_id, clienteId: resolvedClienteId, origem: origemDados(request) })
        }
        if (!resolvedMarcaId) {
          await db.query('ROLLBACK')
          return reply.code(422).send({
            error: 'Live sem marca: cadastre/vincule a marca do cliente antes de iniciar a live',
            code: 'MARCA_OBRIGATORIA',
          })
        }
        // ── fim marca obrigatória ──

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
           VALUES ($1, $2, $3, $4, $5, 'rascunho', $9, $6, $7, $8)
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
            origemDados(request),
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

        // Rateio inicial da live. Evento com turnos (revezamento) vira uma linha por
        // apresentadora com o percentual planejado; sem turnos, é o insert único de sempre.
        await seedRateioPlanejado(db, {
          tenantId: tenant_id,
          liveId: live.id,
          agendaEventoId: resolvedAgendaEventoId,
          apresentadoraFallbackId: resolvedApresentadoraId,
          log: app.log,
        })

        // ── Evento automático de agenda (se nenhum evento foi encontrado/vinculado) ──
        // Executado dentro da transação; falha é soft (nunca bloqueia a live).
        // Marca é invariante (NOT NULL) — usa resolvedMarcaId diretamente.
        let finalAgendaEventoId = resolvedAgendaEventoId
        if (!resolvedAgendaEventoId && !agendaWarning) {
          try {
            const marcaId = resolvedMarcaId
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
                 SET agenda_evento_id = $1
                 WHERE id = $2 AND tenant_id = $3::uuid`,
                [finalAgendaEventoId, live.id, tenant_id]
              )
            }
            app.log.info({ liveId: live.id, agendaEventoId: finalAgendaEventoId }, 'agenda: evento automático criado')
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
    app.requirePapel(['franqueador_master', 'franqueado', 'gerente', 'produtor_live', 'automacao']),
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

        // ── Marca obrigatória (exige-ou-erra) ──
        if (!resolvedMarcaId && d.tipo === 'cliente' && resolvedClienteId) {
          resolvedMarcaId = await ensureClienteMarca(db, { tenantId: tenant_id, clienteId: resolvedClienteId, origem: origemDados(request) })
        }
        if (!resolvedMarcaId) {
          await db.query('ROLLBACK')
          return reply.code(422).send({
            error: 'Live sem marca: cadastre/vincule a marca do cliente antes de registrar a live',
            code: 'MARCA_OBRIGATORIA',
          })
        }
        // ── fim marca obrigatória ──

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

        // Resolve apresentadoras.id → users.id + comissao_pct (para snapshot operacional)
        let apresentadorUserId = null
        let apresentadoraComissaoPct = null
        if (d.apresentador_id) {
          const apRow = await db.query(
            `SELECT user_id, comissao_pct FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid`,
            [d.apresentador_id, tenant_id]
          )
          apresentadorUserId      = apRow.rows[0]?.user_id      ?? null
          apresentadoraComissaoPct = apRow.rows[0]?.comissao_pct != null
            ? Number(apRow.rows[0].comissao_pct)
            : null
        }

        let apresentador2UserId = null
        if (d.apresentador2_id) {
          const ap2Row = await db.query(
            `SELECT user_id FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid`,
            [d.apresentador2_id, tenant_id]
          )
          apresentador2UserId = ap2Row.rows[0]?.user_id ?? null
        }

        const iniciado  = saoPauloTimestamp(d.data, d.hora_inicio)
        const encerrado = saoPauloTimestamp(d.data, d.hora_fim)

        // Comissão apresentadora — snapshot operacional por live
        const fatGeradoManual   = Number(officialGmvFromPayload(d) ?? 0)
        const comApresManual    = calcularComissaoApresentadora({
          fatGerado:        fatGeradoManual,
          apresentadoraPct: apresentadoraComissaoPct,
          iniciadoEm:       iniciado,
          temApresentadora: apresentadorUserId != null,
        })

        const ins = await db.query(
          `INSERT INTO lives
             (tenant_id, cabine_id, cliente_id, apresentador_id, gestor_id,
              status, iniciado_em, encerrado_em, fat_gerado, comissao_calculada,
              final_orders_count, resumo,
              manual_views, manual_likes, manual_comments, manual_shares, manual_diamonds,
              manual_orders, manual_gmv,
              tipo, status_publicacao, origem_dados, agenda_evento_id, marca_id,
              comissao_apresentadora_pct, comissao_apresentadora_valor,
              ads_cost, live_impressions, product_impressions, product_clicks,
              avg_viewing_duration, new_followers)
           VALUES ($1,$2,$3,$4,$5,'encerrada',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
                   $26,$27,$28,$29,$30,$31)
           RETURNING id`,
          [
            tenant_id, d.cabine_id, resolvedClienteId ?? null, apresentadorUserId, gestorId,
            iniciado, encerrado, d.fat_gerado, comissao, d.qtd_pedidos, d.resumo ?? null,
            d.manual_views ?? null, d.manual_likes ?? null,
            d.manual_comments ?? null, d.manual_shares ?? null, d.manual_diamonds ?? null,
            d.manual_orders ?? null, d.manual_gmv ?? null,
            d.tipo, d.status_publicacao, origemDados(request, d.origem_dados), d.agenda_evento_id ?? null, resolvedMarcaId,
            comApresManual.pct, comApresManual.valor,
            d.ads_cost ?? null, d.live_impressions ?? null, d.product_impressions ?? null,
            d.product_clicks ?? null, d.avg_viewing_duration ?? null, d.new_followers ?? null,
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

        // Lançamento manual também consome evento de agenda (d.agenda_evento_id), então
        // também herda o revezamento planejado — é o 5º caminho que abre linha em v2.
        //
        // `apresentadoraConfirmadaId`: aqui a live JÁ ACONTECEU e o operador informou quem
        // apresentou (o mesmo id que virou lives.apresentador_id logo acima). Se ela não
        // está nos turnos, o plano é mais velho que o fato e o seed o descarta — senão o
        // rateio planejado ficaria com 100% do GMV e da comissão para quem não apresentou,
        // e quem apresentou receberia R$ 0,00.
        const linhasV2 = await seedRateioPlanejado(db, {
          tenantId: tenant_id,
          liveId,
          agendaEventoId: d.agenda_evento_id ?? null,
          apresentadoraFallbackId: d.apresentador_id ?? null,
          apresentadoraConfirmadaId: d.apresentador_id ?? null,
          log: app.log,
        })

        // Com o rateio de turnos gravado, a 2ª apresentadora já está em v2. Escrever também
        // no legado live_apresentadores acrescentaria uma 3ª linha ao UNION do
        // commission-engine que cai em rateioPadrao = 0 e recebe R$ 0,00.
        if (apresentador2UserId && linhasV2 < 2) {
          await db.query(
            `INSERT INTO live_apresentadores (tenant_id, live_id, apresentador_id)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [tenant_id, liveId, apresentador2UserId]
          )
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

        await db.query('COMMIT')

        // Escritor ÚNICO de vendas_atribuidas (origem='live'): commission-engine pós-commit.
        // (antes havia um upsert aqui que competia com o engine na mesma chave única — P1-1).
        {
          const gmvManual = officialGmvFromPayload(d)
          const pedidosManual = officialOrdersFromPayload(d)
          app.withTenant(tenant_id, async (db2) => {
            try {
              await calcularComissoesDaLive(db2, { liveId, tenantId: tenant_id, gmv: gmvManual, pedidos: pedidosManual })
            } catch (commErr) {
              app.log.warn({ err: commErr, liveId }, 'commission-engine: falha no cálculo da live manual (soft)')
            }
          }).catch(err => app.log.warn({ err, liveId }, 'commission-engine: withTenant falhou'))
        }

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
        if (d.apresentadoras !== undefined) {
          // Atribuições aprovadas são imutáveis no commission-engine. Permitir um novo
          // rateio aqui mudaria o v2 sem mudar as vendas aprovadas e deixaria Analytics
          // dividido entre duas verdades. Rejeita antes de qualquer escrita parcial.
          const aprovada = await db.query(
            `SELECT 1 AS exists
               FROM vendas_atribuidas
              WHERE tenant_id = $1::uuid
                AND origem = 'live'
                AND origem_id = $2::uuid
                AND status_aprovacao = 'aprovada'
              LIMIT 1`,
            [tenant_id, request.params.id],
          )
          if (aprovada.rows[0]) {
            await db.query('ROLLBACK')
            return reply.code(409).send({
              error: 'Não é possível alterar o rateio enquanto houver comissão aprovada para esta live.',
              code: 'RATEIO_COMISSAO_APROVADA',
            })
          }
        }

        const cabineId = d.cabine_id ?? live.cabine_id
        let comissao = undefined
        const gmvMudou = d.fat_gerado !== undefined || d.manual_gmv !== undefined || d.ads_gmv !== undefined
        // Mesma condição que dispara o recálculo lá embaixo — declarada uma vez só para as
        // duas não poderem divergir: marcar sem recalcular deixaria o cron trabalhando à toa,
        // recalcular sem marcar traz de volta a comissão congelada.
        const precisaRecalcularComissao = gmvMudou
          || d.marca_id !== undefined
          || d.apresentador_id !== undefined
          // Mudar só o rateio não mexe em nenhuma coluna de lives, mas muda quanto cada
          // apresentadora recebe — sem isto a divisão ficaria gravada e a comissão, velha.
          || d.apresentadoras !== undefined
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
        // Intenção durável de recálculo, gravada na MESMA transação da edição.
        //
        // O recálculo comum das vendas_atribuidas roda fora daqui; o de rateio roda dentro
        // da transação para que Analytics nunca misture o rateio novo com vendas antigas.
        // Se um recálculo assíncrono falhar — ou se o processo morrer entre o COMMIT e a
        // chamada — a venda fica com o
        // valor ANTIGO, não-zero. E o cron de reconciliação só varre comissão ZERADA, então
        // comissão errada mas não-zero nunca seria reprocessada: ficava errada para sempre,
        // sem erro e sem log.
        //
        // Marcando aqui, a intenção sobrevive a qualquer uma dessas falhas; quem limpa é o
        // recálculo bem-sucedido. Enquanto estiver marcada, o cron reprocessa.
        if (precisaRecalcularComissao) addField('comissao_recalculo_pendente', true)
        // Recalcular comissão apresentadora quando GMV muda (snapshot operacional)
        if (gmvMudou) {
          const gmvAtualPatch      = officialGmvFromPayload(d, live)
          const apResolvido        = resolvedApresentadorId ?? live.apresentador_id
          let apPctPatch           = null
          if (apResolvido) {
            const apPctQ = await db.query(
              `SELECT comissao_pct FROM apresentadoras WHERE user_id = $1 AND tenant_id = $2::uuid LIMIT 1`,
              [apResolvido, tenant_id]
            )
            apPctPatch = apPctQ.rows[0]?.comissao_pct != null
              ? Number(apPctQ.rows[0].comissao_pct)
              : null
          }
          const inicioParaComApres = live.iniciado_em ? new Date(live.iniciado_em) : new Date()
          const comApresPatch = calcularComissaoApresentadora({
            fatGerado:        Number(gmvAtualPatch ?? 0),
            apresentadoraPct: apPctPatch,
            iniciadoEm:       inicioParaComApres,
            temApresentadora: apResolvido != null,
          })
          addField('comissao_apresentadora_pct',   comApresPatch.pct)
          addField('comissao_apresentadora_valor',  comApresPatch.valor)
        }
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
        // Origem é fixada na criação: a chave de API não reescreve o que uma pessoa criou.
        if (d.origem_dados    !== undefined && !request.viaApiKey) addField('origem_dados',   d.origem_dados)
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

        // Trocar a apresentadora escalar apaga TODAS as linhas de v2 e insere uma — o que
        // destrói um rateio de duas pessoas sem recalcular nada e sem passar pelo guard de
        // comissão aprovada. A UI já esconde o campo nesse caso (EditarLiveModal.tsx:362);
        // a API precisava recusar também. Quem quiser mudar quem apresentou usa
        // `apresentadoras` (applyApresentadorasToLive), que é o escritor com validação.
        if (d.apresentador_id !== undefined && d.apresentadoras === undefined) {
          const n = await db.query(
            'SELECT COUNT(*)::int AS n FROM live_apresentadoras_v2 WHERE live_id = $1::uuid AND tenant_id = $2::uuid',
            [request.params.id, tenant_id],
          )
          if ((n.rows[0]?.n ?? 0) > 1) {
            await db.query('ROLLBACK')
            return reply.code(409).send({
              error: 'Esta live tem rateio entre apresentadoras. Use "Dividir entre apresentadoras" para alterar.',
              code: 'RATEIO_MULTIPLO',
            })
          }
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

        // Rateio entre apresentadoras que se revezaram na mesma live. Até aqui só o import do
        // TikTok escrevia isso, e o resultado medido em produção era 0 lives divididas no banco
        // inteiro: quem operava não tinha por onde separar quem fez o quê, e a comissão saía
        // toda para uma só. Vem DEPOIS do bloco de apresentador_id de propósito — quando o
        // mesmo PATCH manda os dois, a informação mais rica ganha.
        //
        // O UPDATE de lives acima já rodou, então liveTotals (dentro do helper) valida a soma
        // contra o GMV e a duração NOVOS, não contra os que a live tinha ao abrir a tela.
        let rateioAnterior = null
        if (d.apresentadoras !== undefined) {
          const antes = await db.query(
            `SELECT apresentadora_id, gmv_rateado, segundos_rateio
               FROM live_apresentadoras_v2
              WHERE live_id = $1::uuid AND tenant_id = $2::uuid
              ORDER BY (papel = 'principal') DESC, criado_em ASC`,
            [request.params.id, tenant_id],
          )
          rateioAnterior = antes.rows
          await applyApresentadorasToLive(db, {
            tenantId: tenant_id,
            liveId: request.params.id,
            apresentadoras: d.apresentadoras,
          })
          // A lista v2 passa a ser a única fonte de verdade. Manter a junção legada aqui
          // deixa uma segunda apresentadora "fantasma" quando o apoio é removido.
          await db.query(
            `DELETE FROM live_apresentadores
              WHERE live_id = $1::uuid AND tenant_id = $2::uuid`,
            [request.params.id, tenant_id],
          )
        }

        // (removido: upsert direto em vendas_atribuidas — o commission-engine pós-commit
        //  é o escritor único de origem='live'. P1-1)

        // Rastreia mudanças de GMV em live_metric_revisions.
        //
        // ads_gmv entrou aqui depois: é o TOPO de COALESCE(ads_gmv, manual_gmv, fat_gerado),
        // ou seja, o campo que manda no número exibido — e era o único dos três sem rastro.
        // Alterá-lo mudava todos os dashboards sem deixar linha no histórico de GMV
        // (GET /v1/lives/:id/historico-gmv) nem no diff do audit_log: o número mudava e não
        // havia como responder "quem mexeu, e quando".
        if (d.ads_gmv !== undefined && d.ads_gmv !== live.ads_gmv) {
          await db.query(
            `INSERT INTO live_metric_revisions (tenant_id, live_id, campo, valor_anterior, valor_novo, alterado_por, alterado_em, origem_dados)
             VALUES ($1, $2, 'ads_gmv', $3, $4, $5, NOW(), $6)`,
            [tenant_id, request.params.id, live.ads_gmv?.toString() ?? null, d.ads_gmv?.toString() ?? null, sub, origemDados(request)]
          )
        }
        if (d.fat_gerado !== undefined && d.fat_gerado !== live.fat_gerado) {
          await db.query(
            `INSERT INTO live_metric_revisions (tenant_id, live_id, campo, valor_anterior, valor_novo, alterado_por, alterado_em, origem_dados)
             VALUES ($1, $2, 'fat_gerado', $3, $4, $5, NOW(), $6)`,
            [tenant_id, request.params.id, live.fat_gerado?.toString() ?? null, d.fat_gerado.toString(), sub, origemDados(request)]
          )
        }
        if (d.manual_gmv !== undefined && d.manual_gmv !== live.manual_gmv) {
          await db.query(
            `INSERT INTO live_metric_revisions (tenant_id, live_id, campo, valor_anterior, valor_novo, alterado_por, alterado_em, origem_dados)
             VALUES ($1, $2, 'manual_gmv', $3, $4, $5, NOW(), $6)`,
            [tenant_id, request.params.id, live.manual_gmv?.toString() ?? null, d.manual_gmv.toString(), sub, origemDados(request)]
          )
        }

        if (d.apresentadoras === undefined && 'apresentador2_id' in d) {
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
          // ads_gmv junto dos outros dois: é o topo do COALESCE que define o GMV exibido,
          // e ficava de fora do diff — dava para mudar o número de todos os dashboards sem
          // deixar rastro de quem mexeu.
          'ads_gmv', 'fat_gerado', 'manual_gmv', 'final_orders_count',
        ]
        const diff = {}
        for (const f of auditFields) {
          const dKey = f === 'final_orders_count' ? 'qtd_pedidos' : f
          if (d[dKey] !== undefined && String(d[dKey] ?? '') !== String(live[f] ?? '')) {
            diff[f] = { before: live[f] ?? null, after: d[dKey] ?? null }
          }
        }
        // Rateio não é coluna de lives, então não cai no laço acima — mas é dinheiro mudando
        // de dona e precisa do mesmo rastro.
        if (rateioAnterior !== null) {
          diff.rateio_apresentadoras = {
            before: rateioAnterior.map((r) => ({
              apresentadora_id: r.apresentadora_id,
              gmv: r.gmv_rateado == null ? null : Number(r.gmv_rateado),
              segundos: r.segundos_rateio,
            })),
            after: d.apresentadoras,
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

        // Alterar o rateio muda simultaneamente GMV/horas por apresentadora e as linhas de
        // vendas/comissão. Persistir as duas fontes na mesma transação impede a leitura
        // híbrida que antes podia ficar armazenada nos caches de Analytics por até 60s.
        let rateioRecalculadoNaTransacao = false
        if (d.apresentadoras !== undefined) {
          await calcularComissoesDaLive(db, {
            liveId: request.params.id,
            tenantId: tenant_id,
            gmv: officialGmvFromPayload(d, live),
            pedidos: officialOrdersFromPayload(d, live),
          })
          await db.query(
            `UPDATE lives SET comissao_recalculo_pendente = FALSE
              WHERE id = $1::uuid AND tenant_id = $2::uuid`,
            [request.params.id, tenant_id],
          )
          rateioRecalculadoNaTransacao = true
        }

        await db.query('COMMIT')

        // A Home tem cache PRÓPRIO, fora do dashboard-cache.js, e o hook global de app.js
        // não o alcança (ver comentário em src/routes/home.js:26). Sem esta chamada, editar
        // o GMV de uma live deixa os cards da Home no valor antigo por até 45s — que o
        // usuário lê como "não salvou".
        invalidateHomeDashboard(tenant_id)

        // Demais edições mantêm o recálculo assíncrono existente. O rateio já foi concluído
        // atomicamente acima e não pode ser disparado duas vezes aqui.
        if (precisaRecalcularComissao && !rateioRecalculadoNaTransacao) {
          const gmvAtualizado = officialGmvFromPayload(d, live)
          const pedidosAtualizado = officialOrdersFromPayload(d, live)
          app.withTenant(tenant_id, async (db2) => {
            try {
              await calcularComissoesDaLive(db2, {
                liveId: request.params.id,
                tenantId: tenant_id,
                gmv: gmvAtualizado,
                pedidos: pedidosAtualizado,
              })
              // Só agora a marca sai: ela representa "falta recalcular", e recalcular
              // acabou de acontecer. Se este UPDATE falhar, a marca fica e o cron refaz —
              // recalcular duas vezes é inofensivo (o engine é idempotente por
              // origem+origem_id), deixar de recalcular não é.
              await db2.query(
                `UPDATE lives SET comissao_recalculo_pendente = FALSE
                  WHERE id = $1::uuid AND tenant_id = $2::uuid`,
                [request.params.id, tenant_id],
              )
            } catch (commErr) {
              // Sem elevar para error de propósito: a marca no banco já garante o
              // reprocessamento, então isto é aviso, não incidente.
              app.log.warn({ err: commErr, liveId: request.params.id },
                'commission-engine: recálculo pós-edição falhou — live segue marcada para o cron')
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
                -- Comissão da apresentadora: fonte é o motor (vendas_atribuidas, faixas por GMV
                -- mensal + 2% fim de semana), o mesmo que Financeiro e /comissoes leem. O snapshot
                -- lives.comissao_apresentadora_* vem do apresentadoras.comissao_pct chapado (0 em
                -- 13 de 18 cadastros) e fica só como fallback de live ainda sem venda atribuída.
                COALESCE(
                  (SELECT SUM(va_c.comissao_apresentadora) FROM vendas_atribuidas va_c
                    WHERE va_c.tenant_id = l.tenant_id AND va_c.origem = 'live' AND va_c.origem_id = l.id),
                  l.comissao_apresentadora_valor
                ) AS comissao_apresentadora,
                COALESCE(
                  (SELECT ROUND(SUM(va_c.comissao_apresentadora) / NULLIF(SUM(va_c.gmv), 0) * 100, 2)
                     FROM vendas_atribuidas va_c
                    WHERE va_c.tenant_id = l.tenant_id AND va_c.origem = 'live' AND va_c.origem_id = l.id),
                  l.comissao_apresentadora_pct
                ) AS pct_apresentadora,
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

      // O SELECT acima traz só a apresentadora principal (LATERAL … LIMIT 1). Para dividir a
      // live entre quem se revezou, a tela precisa da lista inteira com os valores rateados —
      // sem isto o modal de rateio abriria sempre em branco e apagaria a divisão anterior.
      const rateio = await db.query(
        `SELECT lav.apresentadora_id, a.nome, lav.papel,
                lav.gmv_rateado, lav.segundos_rateio, lav.percentual_rateio
           FROM live_apresentadoras_v2 lav
           JOIN apresentadoras a ON a.id = lav.apresentadora_id AND a.tenant_id = lav.tenant_id
          WHERE lav.live_id = $1::uuid AND lav.tenant_id = $2::uuid
          ORDER BY (lav.papel = 'principal') DESC, lav.criado_em ASC`,
        [request.params.id, tenant_id],
      )
      live.apresentadoras = rateio.rows.map((r) => ({
        apresentadora_id: r.apresentadora_id,
        nome: r.nome,
        papel: r.papel,
        gmv: r.gmv_rateado == null ? null : Number(r.gmv_rateado),
        segundos: r.segundos_rateio,
        percentual: r.percentual_rateio == null ? null : Number(r.percentual_rateio),
      }))
      // Compatibilidade dos campos simples com a fonte de verdade do rateio. O formulário
      // antigo ainda consome os aliases principal/segunda, enquanto Analytics e comissão
      // usam a lista completa. Derivar ambos da mesma consulta impede que o detalhe diga
      // "sem segunda apresentadora" quando live_apresentadoras_v2 já tem o apoio salvo.
      const principal = live.apresentadoras.find((item) => item.papel === 'principal') ?? live.apresentadoras[0]
      const apoio = live.apresentadoras.find((item) => item !== principal)
      if (principal) {
        live.apresentadora_id = principal.apresentadora_id
        live.apresentadora_nome = principal.nome
        live.apresentador_nome = principal.nome
      }
      if (apoio) {
        live.apresentadora2_id = apoio.apresentadora_id
        live.apresentador2_id = apoio.apresentadora_id
        live.apresentadora2_nome = apoio.nome
      }
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
    const fQ = String(request.query?.q ?? '').trim().slice(0, 120)
    const paginado = String(request.query?.paginado ?? '') === '1'
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
        where += ` AND (
          EXISTS (
            SELECT 1
              FROM live_apresentadoras_v2 lav_filter
             WHERE lav_filter.live_id = l.id
               AND lav_filter.tenant_id = l.tenant_id
               AND lav_filter.apresentadora_id = $${params.length}::uuid
          )
          OR COALESCE(ae.apresentadora_id, ap_user.id) = $${params.length}::uuid
        )`
      }
      if (fQ) {
        // Busca textual server-side: marca, cliente, apresentadora, resumo da live
        // e título/observações do evento de agenda. Os aliases dos LATERALs podem
        // ser referenciados no WHERE externo (mesmo padrão dos filtros marca_id/
        // apresentadora_id acima) — o plano segue dirigido pelos índices de lives.
        params.push(`%${fQ.replace(/[\\%_]/g, '\\$&')}%`)
        const qi = params.length
        where += ` AND (cl.nome ILIKE $${qi}
          OR va_marca.marca_nome ILIKE $${qi}
          OR COALESCE(ap_v2.nomes, ap_agenda.nome, ap_user.nome, u.nome) ILIKE $${qi}
          OR l.resumo ILIKE $${qi}
          OR ae.observacoes ILIKE $${qi})`
      }
      // cliente_parceiro só enxerga lives publicadas e do seu próprio cliente
      if (papel === 'cliente_parceiro') {
        params.push(tenant_id)
        const clienteSubIdx = params.length
        params.push(sub)
        where += ` AND l.status_publicacao = 'publicado'`
        where += ` AND l.cliente_id = (SELECT id FROM clientes WHERE user_id = $${clienteSubIdx + 1} AND tenant_id = $${clienteSubIdx}::uuid LIMIT 1)`
      }
      // ── Split query: página enxuta (ids + total) → hidratação dos laterais caros ──
      // Os LATERALs (ae, ap_v2, ap_extra, va_marca, ls) custam por linha do resultado.
      // Rodá-los sobre o histórico inteiro fazia a latência crescer com o tamanho da
      // tabela, não da página. Query 1 monta só os joins que os filtros ativos realmente
      // consultam e resolve ORDER BY / LIMIT / OFFSET / COUNT; query 2 hidrata apenas os
      // ids da página. Os fragmentos de join abaixo são compartilhados pelas duas queries,
      // então a resolução de marca/apresentadora é literalmente a mesma string nas duas —
      // uma live não pode casar o filtro por uma marca e exibir outra.
      const joinCabines = `JOIN cabines c ON c.id = l.cabine_id AND c.tenant_id = l.tenant_id`
      const joinContratos = `LEFT JOIN contratos ct ON ct.id = c.contrato_id AND ct.tenant_id = l.tenant_id`
      const joinClientes = `LEFT JOIN clientes cl ON cl.id = l.cliente_id AND cl.tenant_id = l.tenant_id`
      const joinUsers = `LEFT JOIN users u ON u.id = l.apresentador_id AND u.tenant_id = l.tenant_id`
      const joinApUser = `LEFT JOIN apresentadoras ap_user ON ap_user.user_id = l.apresentador_id AND ap_user.tenant_id = l.tenant_id`
      const joinAe = `LEFT JOIN LATERAL (
           SELECT ae2.id, ae2.data_inicio, ae2.data_fim, ae2.observacoes, ae2.apresentadora_id
           FROM agenda_eventos ae2
           WHERE (ae2.live_id = l.id OR ae2.id = l.agenda_evento_id OR ae2.cabine_id = l.cabine_id)
             AND ae2.tenant_id = l.tenant_id
             AND ae2.tipo = 'live'
             AND (ae2.live_id = l.id OR ae2.id = l.agenda_evento_id OR ae2.data_inicio::date = l.iniciado_em::date)
           ORDER BY ABS(EXTRACT(EPOCH FROM (ae2.data_inicio - l.iniciado_em)))
           LIMIT 1
         ) ae ON true`
      const joinApAgenda = `LEFT JOIN apresentadoras ap_agenda ON ap_agenda.id = ae.apresentadora_id AND ap_agenda.tenant_id = l.tenant_id`
      const joinApV2 = `LEFT JOIN LATERAL (
           SELECT
             (array_agg(lav.apresentadora_id ORDER BY (lav.papel = 'principal') DESC, lav.criado_em ASC))[1] AS apresentadora_id,
             (array_agg(a.nome ORDER BY (lav.papel = 'principal') DESC, lav.criado_em ASC))[1] AS nome,
             (array_agg(lav.apresentadora_id ORDER BY (lav.papel = 'principal') DESC, lav.criado_em ASC))[2] AS apresentadora2_id,
             (array_agg(a.nome ORDER BY (lav.papel = 'principal') DESC, lav.criado_em ASC))[2] AS apresentadora2_nome,
             string_agg(a.nome, ' ' ORDER BY (lav.papel = 'principal') DESC, lav.criado_em ASC) AS nomes,
             COUNT(*)::int AS total,
             jsonb_agg(
               jsonb_build_object(
                 'apresentadora_id', lav.apresentadora_id,
                 'nome', a.nome,
                 'papel', lav.papel,
                 'gmv', lav.gmv_rateado,
                 'segundos', lav.segundos_rateio,
                 'percentual', lav.percentual_rateio
               ) ORDER BY (lav.papel = 'principal') DESC, lav.criado_em ASC
             ) AS apresentadoras
           FROM live_apresentadoras_v2 lav
           JOIN apresentadoras a ON a.id = lav.apresentadora_id AND a.tenant_id = lav.tenant_id
           WHERE lav.live_id = l.id
             AND lav.tenant_id = l.tenant_id
         ) ap_v2 ON true`
      const joinApExtra = `LEFT JOIN LATERAL (
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
         ) ap_extra ON true`
      const joinVaMarca = `LEFT JOIN LATERAL (
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
         ) va_marca ON true`
      const joinClTiktok = `LEFT JOIN clientes cl_tiktok ON cl_tiktok.id = COALESCE(va_marca.cliente_id, l.cliente_id, ct.cliente_id) AND cl_tiktok.tenant_id = l.tenant_id`
      const joinLs = `LEFT JOIN LATERAL (
           SELECT viewer_count, total_viewers, total_orders, gmv,
                  likes_count, comments_count, gifts_diamonds, shares_count
           FROM live_snapshots
           WHERE live_id = l.id
             AND tenant_id = l.tenant_id
           ORDER BY captured_at DESC
           LIMIT 1
         ) ls ON true`

      // `cabines` é INNER JOIN: descarta lives órfãs, então precisa estar na query 1 para
      // que o COUNT bata. Os demais são 1:1 (PK ou LATERAL LIMIT 1; apresentadoras.user_id
      // tem índice único — migration 048), logo só entram quando um filtro os referencia.
      const needsApresentadora = Boolean(fApresentadoraId || fQ)
      const needsMarca = Boolean(fMarcaId || fQ)
      const pageJoins = [joinCabines]
      if (fQ) pageJoins.push(joinClientes, joinUsers)
      if (needsApresentadora) pageJoins.push(joinApUser, joinAe)
      if (fQ) pageJoins.push(joinApAgenda)
      if (fQ) pageJoins.push(joinApV2)
      if (needsMarca) pageJoins.push(joinVaMarca)

      const pageResult = await db.query(
        `SELECT l.id${paginado ? ', COUNT(*) OVER() AS total_count' : ''}
         FROM lives l
         ${pageJoins.join('\n         ')}
         ${where}
         ORDER BY l.iniciado_em DESC LIMIT ${reqLimit} OFFSET ${reqOffset}`,
        params
      )

      const pageIds = pageResult.rows.map((r) => r.id)
      // Mesmo quirk do código anterior: página fora do intervalo devolve total 0.
      const total = pageResult.rows.length > 0 ? Number(pageResult.rows[0].total_count ?? 0) : 0
      if (pageIds.length === 0) {
        if (!paginado) return []
        return { items: [], total, page: Math.floor(reqOffset / reqLimit), limit: reqLimit }
      }

      const result = await db.query(
        `SELECT l.id, l.tenant_id, l.cabine_id, l.cliente_id, l.apresentador_id,
                l.gestor_id, l.status, l.tipo, l.status_publicacao, l.origem_dados,
                l.iniciado_em, l.encerrado_em, l.fat_gerado, l.comissao_calculada,
                -- Comissão da apresentadora: fonte é o motor (vendas_atribuidas, faixas por GMV
                -- mensal + 2% fim de semana), o mesmo que Financeiro e /comissoes leem. O snapshot
                -- lives.comissao_apresentadora_* vem do apresentadoras.comissao_pct chapado (0 em
                -- 13 de 18 cadastros) e fica só como fallback de live ainda sem venda atribuída.
                COALESCE(
                  (SELECT SUM(va_c.comissao_apresentadora) FROM vendas_atribuidas va_c
                    WHERE va_c.tenant_id = l.tenant_id AND va_c.origem = 'live' AND va_c.origem_id = l.id),
                  l.comissao_apresentadora_valor
                ) AS comissao_apresentadora,
                COALESCE(
                  (SELECT ROUND(SUM(va_c.comissao_apresentadora) / NULLIF(SUM(va_c.gmv), 0) * 100, 2)
                     FROM vendas_atribuidas va_c
                    WHERE va_c.tenant_id = l.tenant_id AND va_c.origem = 'live' AND va_c.origem_id = l.id),
                  l.comissao_apresentadora_pct
                ) AS pct_apresentadora,
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
                CASE WHEN ap_v2.total >= 2 THEN ap_v2.apresentadora2_id ELSE ap_extra.apresentadora_id END AS apresentadora2_id,
                CASE WHEN ap_v2.total >= 2 THEN ap_v2.apresentadora2_id ELSE ap_extra.apresentadora_id END AS apresentador2_id,
                CASE WHEN ap_v2.total >= 2 THEN ap_v2.apresentadora2_nome ELSE ap_extra.nome END AS apresentadora2_nome,
                CASE WHEN ap_v2.total >= 2 THEN ap_v2.apresentadoras END AS apresentadoras,
                COALESCE(l.agenda_evento_id, ae.id) AS agenda_evento_id,
                ae.data_inicio AS agenda_data_inicio,
                ae.data_fim AS agenda_data_fim,
                ae.observacoes AS agenda_titulo,
                ls.viewer_count, ls.total_viewers, ls.total_orders,
                ls.gmv AS gmv_atual, ls.likes_count, ls.comments_count,
                ls.gifts_diamonds, ls.shares_count
         FROM lives l
         ${joinCabines}
         ${joinContratos}
         ${joinClientes}
         ${joinUsers}
         ${joinApUser}
         ${joinAe}
         ${joinApAgenda}
         ${joinApV2}
         ${joinApExtra}
         ${joinVaMarca}
         ${joinClTiktok}
         ${joinLs}
         WHERE l.id = ANY($1::uuid[]) AND l.tenant_id = $2::uuid`,
        [pageIds, tenant_id]
      )

      // ANY() não preserva ordem — reordena pela ordem da query 1.
      const byId = new Map(result.rows.map((row) => [row.id, row]))
      const ordered = pageIds.map((id) => byId.get(id)).filter(Boolean)

      // Sem `paginado`, o shape legado (array puro) fica intacto — há outros consumidores.
      if (!paginado) return ordered
      // `total_count` vive só na query 1; o strip garante que ele nunca vaze no envelope.
      const items = ordered.map(({ total_count, ...rest }) => rest)
      return { items, total, page: Math.floor(reqOffset / reqLimit), limit: reqLimit }
    })
  })

  // GET /v1/lives/duplicatas — agrupa lives possivelmente duplicadas em clusters.
  //
  // Uma regra só: MESMA CABINE, com sobreposição que cobre a maior parte da live mais
  // curta. Duas lives não cabem fisicamente na mesma cabine ao mesmo tempo, então aqui a
  // sobreposição é impossibilidade, não coincidência — e é a assinatura do caso real que a
  // operação relata: a mesma live lançada duas vezes à mão (POST /v1/lives/manual é o único
  // dos quatro caminhos de criação sem guarda de colisão).
  //
  // A regra antiga "mesma marca + mesma apresentadora no mesmo dia" foi REMOVIDA: ela
  // descrevia a operação normal — uma apresentadora faz várias lives da mesma marca no mesmo
  // dia, todo dia. Sozinha ela gerava da ordem de um cluster por apresentadora ativa por dia
  // e, sem janela de tempo, o total só crescia. Alerta que acende sempre é alerta ignorado
  // sempre, e aí a duplicata de verdade passa junto com o ruído.
  app.get('/v1/lives/duplicatas', { preHandler: cabineRoleAccess(app) }, async (request) => {
    const { tenant_id } = request.user
    // Janela: duplicata é problema de conferência recente. Sem bound, o self-join é O(n²)
    // sobre a base inteira e a contagem nunca decai — cluster de 2023 seguia acusando hoje.
    const dias = Math.min(Math.max(Number(request.query?.dias) || 90, 1), 365)
    return app.withTenant(tenant_id, async (db) => {
      const pares = await db.query(`
        WITH base AS (
          SELECT
            l.id,
            l.cabine_id,
            l.iniciado_em,
            -- Fim efetivo, com piso e teto. Sem piso, a live que o import grava com
            -- encerrado_em = iniciado_em vira intervalo de comprimento zero e casa com
            -- QUALQUER live que contenha aquele instante (0 >= 50% de 0). Sem teto, a live
            -- zumbi que o job fecha com até 24h engole a cabine inteira do dia e o
            -- union-find encadeia tudo num cluster gigante. 4h é a mesma convenção de
            -- fallback já usada na migration 104.
            GREATEST(
              LEAST(
                COALESCE(l.encerrado_em, l.previsto_fim, l.iniciado_em + INTERVAL '4 hours'),
                l.iniciado_em + INTERVAL '12 hours'
              ),
              l.iniciado_em + INTERVAL '15 minutes'
            ) AS fim
          FROM lives l
          WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
            AND l.status <> 'cancelada'
            AND l.cabine_id IS NOT NULL
            AND l.iniciado_em >= NOW() - ($1::int || ' days')::interval
        )
        SELECT a.id AS id_a, b.id AS id_b, 'cabine_horario' AS motivo
        FROM base a
        JOIN base b ON b.id > a.id AND b.cabine_id = a.cabine_id
        WHERE a.iniciado_em < b.fim AND b.iniciado_em < a.fim
          -- Encostar não é duplicar: live que começa quando a outra acaba se sobrepõe por
          -- segundos e não é a mesma transmissão. Duas linhas para a MESMA live se
          -- sobrepõem quase inteiras — exigir metade da mais curta separa os dois casos.
          AND EXTRACT(EPOCH FROM (LEAST(a.fim, b.fim) - GREATEST(a.iniciado_em, b.iniciado_em)))
              >= 0.5 * LEAST(
                   EXTRACT(EPOCH FROM (a.fim - a.iniciado_em)),
                   EXTRACT(EPOCH FROM (b.fim - b.iniciado_em))
                 )
      `, [dias])

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
        let encerramentoApresentadoraComissaoPct = null
        if (parsed.data.apresentadora_id) {
          const apRow = await db.query(
            `SELECT user_id, comissao_pct FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid`,
            [parsed.data.apresentadora_id, tenant_id]
          )
          if (!apRow.rows[0]) {
            await db.query('ROLLBACK')
            return reply.code(404).send({ error: 'Apresentadora não encontrada', code: 'APRESENTADORA_NOT_FOUND' })
          }
          encerramentoApresentadorUserId       = apRow.rows[0].user_id ?? null
          encerramentoApresentadoraComissaoPct = apRow.rows[0].comissao_pct != null
            ? Number(apRow.rows[0].comissao_pct)
            : null
        } else if (live.apresentador_id) {
          // Já havia apresentadora vinculada — buscar comissao_pct pelo user_id
          const apRow = await db.query(
            `SELECT comissao_pct FROM apresentadoras WHERE user_id = $1 AND tenant_id = $2::uuid LIMIT 1`,
            [live.apresentador_id, tenant_id]
          )
          encerramentoApresentadoraComissaoPct = apRow.rows[0]?.comissao_pct != null
            ? Number(apRow.rows[0].comissao_pct)
            : null
        }

        // Snapshot operacional de comissão apresentadora
        const temApresentadora = (encerramentoApresentadorUserId ?? live.apresentador_id) != null
        const inicioEncerrar   = live.iniciado_em ? new Date(live.iniciado_em) : new Date()
        const comApresEncerrar = calcularComissaoApresentadora({
          fatGerado:        Number(officialGmvFromPayload(parsed.data) ?? 0),
          apresentadoraPct: encerramentoApresentadoraComissaoPct,
          iniciadoEm:       inicioEncerrar,
          temApresentadora,
        })

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
               manual_diamonds    = COALESCE($17, manual_diamonds),
               comissao_apresentadora_pct   = $18,
               comissao_apresentadora_valor = $19,
               ads_cost             = COALESCE($20, ads_cost),
               live_impressions     = COALESCE($21, live_impressions),
               product_impressions  = COALESCE($22, product_impressions),
               product_clicks       = COALESCE($23, product_clicks),
               avg_viewing_duration = COALESCE($24, avg_viewing_duration),
               new_followers        = COALESCE($25, new_followers)
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
            comApresEncerrar.pct,
            comApresEncerrar.valor,
            parsed.data.ads_cost ?? null,
            parsed.data.live_impressions ?? null,
            parsed.data.product_impressions ?? null,
            parsed.data.product_clicks ?? null,
            parsed.data.avg_viewing_duration ?? null,
            parsed.data.new_followers ?? null,
          ]
        )

        if (parsed.data.apresentadora_id) {
          // A live abriu com um rateio PLANEJADO de uma pessoa só (linha sem
          // percentual/gmv/segundos, vinda do espelho da agenda) e quem encerra informa
          // OUTRA pessoa: o plano virou ficção. Deixar as duas linhas põe a substituta como
          // 'apoio' com percentual NULL, e a cascata de COALESCE dos rollups
          // (performance-rollups.js:224-249) cai no degrau `papel = 'principal'` — 100% do
          // GMV e das horas para quem não apresentou, R$ 0,00 e zero hora para quem
          // apresentou. O mesmo UPDATE acima já trocou lives.apresentador_id por ela; v2
          // tem que contar a mesma história.
          //
          // Só a linha planejada solitária sai. Rateio confirmado em "Dividir entre
          // apresentadoras" (gmv_rateado/segundos_rateio preenchidos) e revezamento
          // planejado de 2+ pessoas ficam intactos: ali há informação real que este
          // endpoint não tem como recalcular.
          //
          // O SELECT antes do INSERT não reabre a janela de corrida que o CASE fecha: a
          // live está travada por `SELECT ... FOR UPDATE ... status = 'em_andamento'` no
          // topo desta transação, então dois encerramentos não chegam aqui juntos.
          const v2Q = await db.query(
            `SELECT apresentadora_id, percentual_rateio, gmv_rateado, segundos_rateio
               FROM live_apresentadoras_v2
              WHERE live_id = $1::uuid AND tenant_id = $2::uuid`,
            [live.id, tenant_id],
          )
          const planejadaSolo = v2Q.rows.length === 1
            && v2Q.rows[0].percentual_rateio == null
            && v2Q.rows[0].gmv_rateado == null
            && v2Q.rows[0].segundos_rateio == null
            && v2Q.rows[0].apresentadora_id !== parsed.data.apresentadora_id

          if (planejadaSolo) {
            await db.query(
              `DELETE FROM live_apresentadoras_v2
                WHERE live_id = $1::uuid AND tenant_id = $2::uuid AND apresentadora_id = $3::uuid`,
              [live.id, tenant_id, v2Q.rows[0].apresentadora_id],
            )
          }

          // papel EXPLÍCITO em vez do DEFAULT 'principal' da coluna: quando a live já foi
          // aberta com revezamento, o encerramento acrescentaria uma SEGUNDA 'principal' e
          // todo LEFT JOIN por papel='principal' passaria a duplicar a live.
          await db.query(
            `INSERT INTO live_apresentadoras_v2 (tenant_id, live_id, apresentadora_id, papel)
             SELECT $1::uuid, $2::uuid, $3::uuid,
                    CASE WHEN EXISTS (SELECT 1 FROM live_apresentadoras_v2
                                       WHERE live_id = $2::uuid AND tenant_id = $1::uuid
                                         AND papel = 'principal')
                         THEN 'apoio' ELSE 'principal' END
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
        // (removido: resolução de apresentadora + upsert direto em vendas_atribuidas.
        //  O commission-engine pós-commit é o escritor único de origem='live'. P1-1.
        //  marcaQ permanece — é usado abaixo para sincronizar a agenda.)

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
        const pedidosFinal = officialOrdersFromPayload(parsed.data)
        app.withTenant(tenant_id, async (db2) => {
          try {
            await calcularComissoesDaLive(db2, {
              liveId: live.id,
              tenantId: tenant_id,
              gmv: gmvFinal,
              pedidos: pedidosFinal,
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
        // Lê tenant fora da conexão RLS (pool direto, sem set_config tenant).
        ;(async () => {
          try {
            // SYSTEM: lê config de notificação do próprio tenant (WHERE id = tenant_id do JWT). Filtro explícito.
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
            `INSERT INTO live_metric_revisions (tenant_id, live_id, campo, valor_anterior, valor_novo, alterado_por, alterado_em, origem_dados)
             VALUES ($1, $2, 'status_publicacao', $3, $4, $5, NOW(), $6)`,
            [tenant_id, request.params.id, statusAtual, status_publicacao, sub, origemDados(request)]
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
          const pedidosFinal = officialOrdersFromPayload({}, live)
          app.withTenant(tenant_id, async (db2) => {
            try {
              await calcularComissoesDaLive(db2, {
                liveId: request.params.id,
                tenantId: tenant_id,
                gmv: gmvFinal,
                pedidos: pedidosFinal,
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
        `SELECT campo, valor_anterior, valor_novo, motivo, alterado_em, r.origem_dados,
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
