import { z } from 'zod'
import { has as managerHas, stopConnector, syncLives } from '../services/tiktok-connector-manager.js'
import { READ_CABINES, WRITE_LIVES } from '../config/role_groups.js'
import { notify } from '../services/mailer.js'
import { upsertVendaAtribuida } from './vendas_atribuidas.js'
import { getRequestIp, logCabineEvent } from '../lib/cabine-events.js'
import { calcularComissoesDaLive } from '../services/commission-engine.js'

const iniciarLiveSchema = z.object({
  cabine_id: z.string().uuid(),
  cliente_id: z.string().uuid().optional(),
  marca_id: z.string().uuid().optional().nullable(),
  apresentador_id: z.string().uuid().optional().nullable(),
  tiktok_username: z.string().max(100).optional().nullable(),
  tipo: z.enum(['cliente', 'afiliado', 'teste']).optional().default('cliente'),
  agenda_evento_id: z.string().uuid().optional().nullable(),
})

const encerrarSchema = z.object({
  fat_gerado:         z.number().min(0),
  qtd_pedidos:        z.number().int().min(0).optional(),
  resumo:             z.string().max(2000).optional(),
  manual_likes:       z.number().int().min(0).optional(),
  manual_views:       z.number().int().min(0).optional(),
  manual_orders:      z.number().int().min(0).optional(),
  manual_gmv:         z.number().min(0).optional(),
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
  data:               z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hora_inicio:        z.string().regex(/^\d{2}:\d{2}$/),
  hora_fim:           z.string().regex(/^\d{2}:\d{2}$/),
  fat_gerado:         z.number().min(0),
  qtd_pedidos:        z.number().int().min(0),
  resumo:             z.string().max(2000).optional(),
  manual_views:       z.number().int().min(0).optional(),
  manual_likes:       z.number().int().min(0).optional(),
  manual_comments:    z.number().int().min(0).optional(),
  manual_shares:      z.number().int().min(0).optional(),
  manual_diamonds:    z.number().int().min(0).optional(),
  manual_orders:      z.number().int().min(0).optional(),
  manual_gmv:         z.number().min(0).optional(),
  tipo:               z.enum(['cliente', 'afiliado', 'teste']).optional().default('cliente'),
  status_publicacao:  z.enum(['rascunho', 'revisado', 'publicado']).optional().default('rascunho'),
  origem_dados:       z.enum(['manual', 'api']).optional().default('manual'),
}).refine(d => d.hora_fim > d.hora_inicio, {
  message: 'hora_fim deve ser maior que hora_inicio',
}).refine(d => !d.apresentador2_id || d.apresentador2_id !== d.apresentador_id, {
  message: 'apresentadora 2 deve ser diferente da apresentadora 1',
})

const liveManualEditSchema = z.object({
  cabine_id:        z.string().uuid().optional(),
  cliente_id:       z.string().uuid().optional(),
  marca_id:         z.string().uuid().optional(),
  apresentador_id:  z.string().uuid().optional(),
  apresentador2_id: z.string().uuid().nullable().optional(),
  gestor_id:        z.string().uuid().optional(),
  data:             z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  hora_inicio:      z.string().regex(/^\d{2}:\d{2}$/).optional(),
  hora_fim:         z.string().regex(/^\d{2}:\d{2}$/).optional(),
  fat_gerado:       z.number().min(0).optional(),
  qtd_pedidos:      z.number().int().min(0).optional(),
  resumo:           z.string().max(2000).optional(),
  manual_views:     z.number().int().min(0).optional(),
  manual_likes:     z.number().int().min(0).optional(),
  manual_comments:  z.number().int().min(0).optional(),
  manual_shares:    z.number().int().min(0).optional(),
  manual_diamonds:  z.number().int().min(0).optional(),
  manual_orders:    z.number().int().min(0).optional(),
  manual_gmv:       z.number().min(0).optional(),
  tipo:             z.enum(['cliente', 'afiliado', 'teste']).optional(),
  status_publicacao: z.enum(['rascunho', 'revisado', 'publicado']).optional(),
})

const publicarSchema = z.object({
  status_publicacao: z.enum(['revisado', 'publicado']),
  motivo: z.string().max(500).optional(),
})

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
      apresentador_id: requestedApresentadoraId,
      tiktok_username: rawTiktok,
      tipo,
      agenda_evento_id,
    } = parsed.data
    let tiktokUsername = rawTiktok ? rawTiktok.replace(/^@/, '').trim() || null : null
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
        let resolvedTipo = tipo
        let agendaWarning = null

        try {
          let agendaEvento = null

          if (agenda_evento_id) {
            // Caminho explícito: evento passado no body
            const evQ = await db.query(
              `SELECT ae.id, ae.status, ae.marca_id, ae.cabine_id, ae.apresentadora_id,
                      m.cliente_id AS marca_cliente_id,
                      m.tipo AS marca_tipo,
                      m.tiktok_username AS marca_tiktok_username
               FROM agenda_eventos ae
               LEFT JOIN marcas m ON m.id = ae.marca_id AND m.tenant_id = ae.tenant_id
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
                      m.cliente_id AS marca_cliente_id,
                      m.tipo AS marca_tipo,
                      m.tiktok_username AS marca_tiktok_username
               FROM agenda_eventos ae
               LEFT JOIN marcas m ON m.id = ae.marca_id AND m.tenant_id = ae.tenant_id
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
            if (!tiktokUsername && agendaEvento.marca_tiktok_username) {
              tiktokUsername = String(agendaEvento.marca_tiktok_username).replace(/^@/, '').trim() || null
            }
            if (!requestedClienteId && agendaEvento.marca_tipo && agendaEvento.marca_tipo !== 'cliente') {
              resolvedTipo = agendaEvento.marca_tipo === 'afiliada' ? 'afiliado' : 'teste'
            }
            // Marca evento como em_andamento — live_id não existe na tabela
            await db.query(
              `UPDATE agenda_eventos SET status = 'ao_vivo', atualizado_em = NOW()
               WHERE id = $1 AND tenant_id = $2`,
              [agendaEvento.id, tenant_id]
            )
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
            `SELECT cliente_id, tipo, tiktok_username
             FROM marcas
             WHERE id = $1 AND tenant_id = $2::uuid`,
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
          if (!tiktokUsername && marca.tiktok_username) {
            tiktokUsername = String(marca.tiktok_username).replace(/^@/, '').trim() || null
          }
        }
        if (!['reservada', 'ativa'].includes(cabine.status) || !cabine.contrato_id) {
          if (!['disponivel', 'ativa', 'reservada'].includes(cabine.status)) {
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

        if (tiktokUsername && resolvedContratoId) {
          await db.query(
            `UPDATE contratos SET tiktok_username = $1 WHERE id = $2 AND tenant_id = $3::uuid`,
            [tiktokUsername, resolvedContratoId, tenant_id]
          )
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
          `INSERT INTO lives (tenant_id, cabine_id, cliente_id, apresentador_id, tipo, status_publicacao, origem_dados)
           VALUES ($1, $2, $3, $4, $5, 'rascunho', 'manual')
           RETURNING id, cabine_id, iniciado_em, cliente_id, apresentador_id, tipo, status_publicacao, origem_dados`,
          [tenant_id, cabine_id, resolvedClienteId, apresentadorUserId, resolvedTipo]
        )
        const live = liveQ.rows[0]

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
            // Busca marca_id para o cliente resolvido (necessário pois agenda_eventos.marca_id é NOT NULL)
            let marcaId = null
            if (resolvedClienteId) {
              const marcaQ = await db.query(
                `SELECT id FROM marcas
                 WHERE tenant_id = $1::uuid AND cliente_id = $2::uuid AND status = 'ativa'
                 ORDER BY criado_em ASC LIMIT 1`,
                [tenant_id, resolvedClienteId]
              )
              marcaId = marcaQ.rows[0]?.id ?? null
            }

            if (marcaId) {
              const autoEvQ = await db.query(
                `INSERT INTO agenda_eventos
                   (tenant_id, cabine_id, tipo, status, marca_id, data_inicio, data_fim, observacoes, criado_por)
                 VALUES ($1, $2, 'live', 'ao_vivo', $3, NOW(), NOW() + interval '4 hours',
                         'Live iniciada sem agenda', $4)
                 RETURNING id`,
                [tenant_id, cabine_id, marcaId, sub]
              )
              finalAgendaEventoId = autoEvQ.rows[0]?.id ?? null
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
    if (d.tipo === 'afiliado' && !d.marca_id) {
      return reply.code(400).send({
        error: 'Live de tipo "afiliado" requer marca_id',
        code: 'MARCA_REQUIRED'
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
        const comissao = d.fat_gerado * (comissaoPct / 100)

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

        const iniciado = `${d.data} ${d.hora_inicio}:00`
        const encerrado = `${d.data} ${d.hora_fim}:00`

        // Verificação de overlap: não permite criar live manual em período já ocupado na mesma cabine
        const overlapQ = await db.query(
          `SELECT id FROM lives
           WHERE cabine_id = $1
             AND status NOT IN ('cancelada', 'encerrada')
             AND (iniciado_em, encerrado_em) OVERLAPS ($2::timestamptz, $3::timestamptz)
           LIMIT 1`,
          [d.cabine_id, iniciado, encerrado]
        )
        if (overlapQ.rows[0]) {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'Já existe uma live neste período para esta cabine' })
        }

        const ins = await db.query(
          `INSERT INTO lives
             (tenant_id, cabine_id, cliente_id, apresentador_id, gestor_id,
              status, iniciado_em, encerrado_em, fat_gerado, comissao_calculada,
              final_orders_count, resumo,
              manual_views, manual_likes, manual_comments, manual_shares, manual_diamonds,
              manual_orders, manual_gmv,
              tipo, status_publicacao, origem_dados)
           VALUES ($1,$2,$3,$4,$5,'encerrada',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
           RETURNING id`,
          [
            tenant_id, d.cabine_id, resolvedClienteId ?? null, apresentadorUserId, gestorId,
            iniciado, encerrado, d.fat_gerado, comissao, d.qtd_pedidos, d.resumo ?? null,
            d.manual_views ?? null, d.manual_likes ?? null,
            d.manual_comments ?? null, d.manual_shares ?? null, d.manual_diamonds ?? null,
            d.manual_orders ?? null, d.manual_gmv ?? null,
            d.tipo, d.status_publicacao, d.origem_dados,
          ]
        )
        const liveId = ins.rows[0].id

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
        }

        if (resolvedMarcaId) {
          await upsertVendaAtribuida(db, {
            tenantId: tenant_id,
            origem: 'live',
            origemId: liveId,
            marcaId: resolvedMarcaId,
            apresentadoraId: d.apresentador_id ?? null,
            data: d.data,
            gmv: d.fat_gerado,
            pedidos: d.qtd_pedidos,
            comissaoApresentadora: comissao,
          })
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
    const { tenant_id, sub } = request.user
    return app.withTenant(tenant_id, async (db) => {
      try {
        await db.query('BEGIN')

        const liveQ = await db.query(
          `SELECT id, cabine_id, cliente_id, fat_gerado, manual_gmv, final_orders_count, iniciado_em, encerrado_em
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

        let resolvedApresentadorId
        if (d.apresentador_id !== undefined) {
          const apRow = await db.query('SELECT user_id FROM apresentadoras WHERE id = $1', [d.apresentador_id])
          if (!apRow.rows[0]) {
            await db.query('ROLLBACK')
            return reply.code(404).send({ error: 'Apresentadora não encontrada' })
          }
          // user_id é nullable — apresentadoras sem conta não atualizam lives.apresentador_id
          if (apRow.rows[0].user_id) resolvedApresentadorId = apRow.rows[0].user_id
        }

        let resolvedClienteId = d.cliente_id
        if (d.marca_id !== undefined) {
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

        if (d.cabine_id    !== undefined) addField('cabine_id',    d.cabine_id)
        if (resolvedClienteId !== undefined) addField('cliente_id', resolvedClienteId)
        if (resolvedApresentadorId !== undefined) addField('apresentador_id', resolvedApresentadorId)
        if (d.gestor_id    !== undefined) addField('gestor_id',          d.gestor_id)
        if (d.tipo         !== undefined) addField('tipo',               d.tipo)
        if (d.status_publicacao !== undefined) addField('status_publicacao', d.status_publicacao)
        if (d.fat_gerado      !== undefined) { addField('fat_gerado', d.fat_gerado); addField('comissao_calculada', comissao) }
        if (d.qtd_pedidos     !== undefined) addField('final_orders_count', d.qtd_pedidos)
        if (d.resumo          !== undefined) addField('resumo',             d.resumo)
        if (d.manual_views    !== undefined) addField('manual_views',    d.manual_views)
        if (d.manual_likes    !== undefined) addField('manual_likes',    d.manual_likes)
        if (d.manual_comments !== undefined) addField('manual_comments', d.manual_comments)
        if (d.manual_shares   !== undefined) addField('manual_shares',   d.manual_shares)
        if (d.manual_diamonds !== undefined) addField('manual_diamonds', d.manual_diamonds)
        if (d.manual_orders   !== undefined) addField('manual_orders',   d.manual_orders)
        if (d.manual_gmv      !== undefined) addField('manual_gmv',      d.manual_gmv)

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

        if (d.marca_id !== undefined) {
          await upsertVendaAtribuida(db, {
            tenantId: tenant_id,
            origem: 'live',
            origemId: request.params.id,
            marcaId: d.marca_id,
            apresentadoraId: d.apresentador_id ?? null,
            data: (d.data ?? new Date(live.iniciado_em).toISOString().slice(0, 10)),
            gmv: d.manual_gmv ?? d.fat_gerado ?? Number(live.manual_gmv ?? live.fat_gerado ?? 0),
            pedidos: d.qtd_pedidos ?? Number(live.final_orders_count ?? 0),
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
          await db.query(`DELETE FROM live_apresentadores WHERE live_id = $1`, [request.params.id])
          if (d.apresentador2_id) {
            const ap2Row = await db.query('SELECT user_id FROM apresentadoras WHERE id = $1', [d.apresentador2_id])
            const ap2UserId = ap2Row.rows[0]?.user_id
            if (ap2UserId) {
              await db.query(
                `INSERT INTO live_apresentadores (tenant_id, live_id, apresentador_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
                [tenant_id, request.params.id, ap2UserId]
              )
            }
          }
        }

        await db.query('COMMIT')

        // Recalcula comissões se fat_gerado ou manual_gmv mudou (fire-and-forget)
        const gmvMudou = d.fat_gerado !== undefined || d.manual_gmv !== undefined
        if (gmvMudou) {
          const gmvAtualizado = d.manual_gmv ?? d.fat_gerado
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
                l.final_orders_count, l.resumo,
                l.manual_views, l.manual_likes, l.manual_comments, l.manual_shares,
                l.manual_diamonds, l.manual_orders, l.manual_gmv,
                c.numero AS cabine_numero, c.contrato_id,
                cl.nome AS cliente_nome,
                va_marca.marca_id AS marca_id,
                va_marca.marca_nome AS marca_nome,
                COALESCE(ap_v2.nome, ap_agenda.nome, ap_user.nome, CASE WHEN u.papel IN ('apresentador', 'apresentadora', 'produtor_live') THEN u.nome END) AS apresentadora_nome,
                COALESCE(ap_v2.nome, ap_agenda.nome, ap_user.nome, CASE WHEN u.papel IN ('apresentador', 'apresentadora', 'produtor_live') THEN u.nome END) AS apresentador_nome,
                COALESCE(ap_v2.apresentadora_id, ae.apresentadora_id, ap_user.id) AS apresentadora_id,
                ae.id AS agenda_evento_id,
                ae.data_inicio AS agenda_data_inicio,
                ae.data_fim AS agenda_data_fim,
                ae.observacoes AS agenda_titulo,
                ls.viewer_count, ls.total_viewers, ls.total_orders,
                ls.gmv AS gmv_atual, ls.likes_count, ls.comments_count,
                ls.gifts_diamonds, ls.shares_count
         FROM lives l
         JOIN cabines c ON c.id = l.cabine_id AND c.tenant_id = l.tenant_id
         LEFT JOIN clientes cl ON cl.id = l.cliente_id AND cl.tenant_id = l.tenant_id
         LEFT JOIN users u ON u.id = l.apresentador_id AND u.tenant_id = l.tenant_id
         LEFT JOIN apresentadoras ap_user ON ap_user.user_id = l.apresentador_id AND ap_user.tenant_id = l.tenant_id
         LEFT JOIN LATERAL (
           SELECT ae2.id, ae2.data_inicio, ae2.data_fim, ae2.observacoes, ae2.apresentadora_id
           FROM agenda_eventos ae2
           WHERE ae2.cabine_id = l.cabine_id
             AND ae2.tenant_id = l.tenant_id
             AND ae2.tipo = 'live'
             AND ae2.data_inicio::date = l.iniciado_em::date
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
           SELECT m.id AS marca_id, m.nome AS marca_nome
           FROM vendas_atribuidas va
           JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
           WHERE va.tenant_id = l.tenant_id
             AND va.origem = 'live'
             AND va.origem_id = l.id
           ORDER BY va.criado_em DESC
           LIMIT 1
         ) va_marca ON true
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
    return app.withTenant(tenant_id, async (db) => {
      const params = [tenant_id]
      let where = 'WHERE l.tenant_id = $1::uuid'
      if (statusFilter && ['em_andamento', 'encerrada', 'faturada'].includes(statusFilter)) {
        params.push(statusFilter)
        where += ` AND l.status = $${params.length}`
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
                l.final_orders_count, l.resumo,
                l.manual_views, l.manual_likes, l.manual_comments, l.manual_shares,
                l.manual_diamonds, l.manual_orders, l.manual_gmv,
                c.numero AS cabine_numero, c.contrato_id,
                cl.nome AS cliente_nome,
                va_marca.marca_id AS marca_id,
                va_marca.marca_nome AS marca_nome,
                COALESCE(ap_v2.nome, ap_agenda.nome, ap_user.nome, CASE WHEN u.papel IN ('apresentador', 'apresentadora', 'produtor_live') THEN u.nome END) AS apresentadora_nome,
                COALESCE(ap_v2.nome, ap_agenda.nome, ap_user.nome, CASE WHEN u.papel IN ('apresentador', 'apresentadora', 'produtor_live') THEN u.nome END) AS apresentador_nome,
                COALESCE(ap_v2.apresentadora_id, ae.apresentadora_id, ap_user.id) AS apresentadora_id,
                ae.id AS agenda_evento_id,
                ae.data_inicio AS agenda_data_inicio,
                ae.data_fim AS agenda_data_fim,
                ae.observacoes AS agenda_titulo
         FROM lives l
         JOIN cabines c ON c.id = l.cabine_id AND c.tenant_id = l.tenant_id
         LEFT JOIN clientes cl ON cl.id = l.cliente_id AND cl.tenant_id = l.tenant_id
         LEFT JOIN users u ON u.id = l.apresentador_id AND u.tenant_id = l.tenant_id
         LEFT JOIN apresentadoras ap_user ON ap_user.user_id = l.apresentador_id AND ap_user.tenant_id = l.tenant_id
         LEFT JOIN LATERAL (
           SELECT ae2.id, ae2.data_inicio, ae2.data_fim, ae2.observacoes, ae2.apresentadora_id
           FROM agenda_eventos ae2
           WHERE ae2.cabine_id = l.cabine_id
             AND ae2.tenant_id = l.tenant_id
             AND ae2.tipo = 'live'
             AND ae2.data_inicio::date = l.iniciado_em::date
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
           SELECT m.id AS marca_id, m.nome AS marca_nome
           FROM vendas_atribuidas va
           JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
           WHERE va.tenant_id = l.tenant_id
             AND va.origem = 'live'
             AND va.origem_id = l.id
           ORDER BY va.criado_em DESC
           LIMIT 1
         ) va_marca ON true
         ${where}
         ORDER BY l.iniciado_em DESC LIMIT 100`,
        params
      )
      return result.rows
    })
  })

  // DELETE /v1/lives/:id
  app.delete('/v1/lives/:id', { preHandler: gestorRoleAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const liveQ = await db.query(`SELECT id, status FROM lives WHERE id = $1`, [request.params.id])
      const live = liveQ.rows[0]
      if (!live) return reply.code(404).send({ error: 'Live não encontrada' })
      if (live.status === 'em_andamento') {
        return reply.code(422).send({ error: 'Não é possível excluir uma live em andamento' })
      }
      await db.query('BEGIN')
      try {
        await db.query(`DELETE FROM vendas_atribuidas WHERE origem = 'live' AND origem_id = $1 AND tenant_id = $2::uuid`, [request.params.id, tenant_id])
        await db.query('DELETE FROM live_apresentadoras_v2 WHERE live_id = $1 AND tenant_id = $2::uuid', [request.params.id, tenant_id])
        await db.query('DELETE FROM live_apresentadores WHERE live_id = $1', [request.params.id])
        await db.query('DELETE FROM live_snapshots WHERE live_id = $1', [request.params.id])
        await db.query('DELETE FROM lives WHERE id = $1', [request.params.id])
        await db.query('COMMIT')
        return reply.code(204).send()
      } catch (e) {
        await db.query('ROLLBACK')
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
          `SELECT id, cabine_id, cliente_id, apresentador_id, status, iniciado_em
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
               fat_gerado = $1, comissao_calculada = $2,
               final_orders_count = COALESCE($3, final_orders_count),
               resumo = COALESCE($4, resumo),
               manual_likes       = COALESCE($6, manual_likes),
               manual_views       = COALESCE($7, manual_views),
               manual_orders      = COALESCE($8, manual_orders),
               manual_gmv         = COALESCE($9, manual_gmv),
               status_publicacao  = $10,
               origem_dados       = $11
           WHERE id = $5`,
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
          ]
        )

        const marcaQ = await db.query(
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
                 AND ae.cabine_id = $4
                 AND ae.tipo = 'live'
                 AND ae.data_inicio::date = $5::date
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
            [tenant_id, live.id, live.apresentador_id, live.cabine_id, live.iniciado_em],
          )
          await upsertVendaAtribuida(db, {
            tenantId: tenant_id,
            origem: 'live',
            origemId: live.id,
            marcaId: marcaQ.rows[0].id,
            apresentadoraId: apresentadoraQ.rows[0]?.id ?? null,
            data: new Date().toISOString().slice(0, 10),
            gmv: parsed.data.fat_gerado,
            pedidos: parsed.data.qtd_pedidos ?? 0,
            comissaoApresentadora: comissao,
          })
        }

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

        // ── Encerra evento de agenda vinculado (soft — nunca bloqueia) ─────────
        // agenda_eventos não tem coluna live_id; identificamos pelo cabine_id + status ao_vivo
        // e data_inicio no mesmo dia da live, para evitar encerrar eventos de outras lives.
        try {
          await db.query(
            `UPDATE agenda_eventos
             SET status = 'concluido', atualizado_em = NOW()
             WHERE tenant_id = $1
               AND cabine_id = $2
               AND status = 'ao_vivo'
               AND data_inicio::date = $3::date`,
            [tenant_id, live.cabine_id, live.iniciado_em]
          )
        } catch (agendaEncErr) {
          app.log.warn({ err: agendaEncErr, liveId: live.id }, 'agenda: falha ao encerrar evento vinculado (soft)')
        }
        // ── fim encerramento agenda ──────────────────────────────────────────

        // Migration 081 removeu status 'ativa' das cabines — cabine sempre volta para 'disponivel'
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

        // Motor de comissões — recalcula com regra MAX(fixo, variável) (fire-and-forget)
        const gmvFinal = parsed.data.manual_gmv ?? parsed.data.fat_gerado
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
        `SELECT id, status_publicacao FROM lives WHERE id = $1`,
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
