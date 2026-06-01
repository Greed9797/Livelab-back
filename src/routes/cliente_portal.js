import { z } from 'zod'
import { parseMoneyToDecimal } from '../lib/money.js'
import { tiktokUsernameField } from '../lib/tiktok-username.js'

export async function clientePortalRoutes(app) {
  // Helper: resolve cliente_id from authenticated user_id (FK) scoped by JWT tenant.
  async function getClienteId(db, userId, tenantId) {
    const res = await db.query(
      `SELECT id
       FROM clientes
       WHERE user_id = $1
         AND tenant_id = $2::uuid
       LIMIT 1`,
      [userId, tenantId]
    )
    return res.rows[0]?.id ?? null
  }

  async function resolveClienteContext(user) {
    const tenantId = user.tenant_id
    const sysDb = await app.db.pool.connect()
    try {
      const res = await sysDb.query(
        `SELECT c.id AS cliente_id
         FROM clientes c
         WHERE c.user_id = $1
           AND c.tenant_id = $2::uuid
         LIMIT 1`,
        [user.sub, tenantId]
      )
      return res.rows[0] ? { clienteId: res.rows[0].cliente_id, tenantId } : null
    } finally {
      sysDb.release()
    }
  }

  function isValidTime(value) {
    return /^\d{2}:\d{2}(:\d{2})?$/.test(String(value ?? ''))
  }

  function normalizeTime(value) {
    return String(value).slice(0, 5)
  }

  function spTodayISO() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
  }

  async function clienteFeatureBlocked(_request, reply) {
    return reply.code(403).send({ error: 'Recurso temporariamente indisponível para cliente parceiro.' })
  }

  async function clienteMetaWriteBlocked(_request, reply) {
    return reply.code(403).send({ error: 'A meta do cliente está disponível apenas para visualização.' })
  }

  // Helper: build date range in America/Sao_Paulo timezone
  function buildDateRange(periodo) {
    const now = new Date()
    // Current time in São Paulo
    const spNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
    const year = spNow.getFullYear()
    const month = spNow.getMonth() // 0-indexed
    const day = spNow.getDate()

    let start, end
    if (periodo === 'hoje') {
      start = new Date(year, month, day)
      end = new Date(year, month, day + 1)
    } else if (periodo === '7dias') {
      end = new Date(year, month, day + 1)
      start = new Date(year, month, day - 6)
    } else if (periodo === '30dias') {
      end = new Date(year, month, day + 1)
      start = new Date(year, month, day - 29)
    } else {
      // mes_atual (default)
      start = new Date(year, month, 1)
      end = new Date(year, month + 1, 1)
    }

    // Convert local dates back to ISO strings for PG (they represent SP midnight)
    return {
      start: start.toISOString(),
      end: end.toISOString(),
      year,
      month: month + 1, // 1-indexed
      day,
      daysInMonth: new Date(year, month + 1, 0).getDate(),
    }
  }

  // GET /v1/cliente/historico-mensal?meses=12&ano=YYYY&mes=MM
  // Retorna até N meses anteriores ao período base (default 12).
  // Lê tabela cliente_metricas_mensais (snapshots persistentes).
  app.get('/v1/cliente/historico-mensal', {
    preHandler: [app.authenticate, app.requirePapel(['cliente_parceiro']), clienteFeatureBlocked],
  }, async (request, reply) => {
    const meses = Math.min(Math.max(parseInt(request.query.meses) || 12, 1), 36)
    const ano = parseInt(request.query.ano) || new Date().getFullYear()
    const mes = parseInt(request.query.mes) || (new Date().getMonth() + 1)
    if (mes < 1 || mes > 12) return reply.code(400).send({ error: 'mes inválido' })

    return app.withTenant(request.user.tenant_id, async (db) => {
      const clienteId = await getClienteId(db, request.user.sub, request.user.tenant_id)
      if (!clienteId) return reply.code(404).send({ error: 'Cliente não encontrado' })

      const r = await db.query(
        `WITH base AS (
           SELECT make_date($2::int, $3::int, 1) AS anchor
         ),
         meses AS (
           SELECT
             EXTRACT(YEAR  FROM (anchor - (offset_n || ' months')::interval))::int AS ano,
             EXTRACT(MONTH FROM (anchor - (offset_n || ' months')::interval))::int AS mes,
             (anchor - (offset_n || ' months')::interval)::date AS sort_date
           FROM base, generate_series($4::int - 1, 0, -1) AS offset_n
         )
         SELECT
           m.ano,
           m.mes,
           COALESCE(s.gmv_total, 0)             AS gmv_total,
           COALESCE(s.total_pedidos, 0)         AS total_pedidos,
           COALESCE(s.itens_vendidos, 0)        AS itens_vendidos,
           COALESCE(s.ticket_medio, 0)          AS ticket_medio,
           COALESCE(s.total_lives, 0)           AS total_lives,
           COALESCE(s.horas_live, 0)            AS horas_live,
           COALESCE(s.viewers_total, 0)         AS viewers_total,
           COALESCE(s.comentarios_total, 0)     AS comentarios_total,
           COALESCE(s.likes_total, 0)           AS likes_total,
           COALESCE(s.shares_total, 0)          AS shares_total,
           COALESCE(s.valor_investido_lives, 0) AS valor_investido_lives,
           COALESCE(s.roas, 0)                  AS roas,
           s.fechado_em
         FROM meses m
         LEFT JOIN cliente_metricas_mensais s
           ON s.cliente_id = $1 AND s.ano = m.ano AND s.mes = m.mes
         ORDER BY m.sort_date`,
        [clienteId, ano, mes, meses],
      )
      return r.rows
    })
  })

  // GET /v1/cliente/perfil — perfil do cliente vinculado ao user logado
  app.get('/v1/cliente/perfil', {
    preHandler: [app.authenticate, app.requirePapel(['cliente_parceiro'])],
  }, async (request, reply) => {
    return app.withTenant(request.user.tenant_id, async (db) => {
      const r = await db.query(
        `SELECT id, nome, email, celular, cnpj, razao_social,
                site, logo_url, status, fat_anual, nicho, cidade, estado, tiktok_username
         FROM clientes
         WHERE user_id = $1
           AND tenant_id = $2::uuid
         LIMIT 1`,
        [request.user.sub, request.user.tenant_id]
      )
      if (r.rows.length === 0) {
        return reply.code(404).send({ error: 'Cliente não encontrado para este usuário.' })
      }
      return r.rows[0]
    })
  })

  // POST /v1/cliente/perfil/tiktok — atualiza @TikTok do PRÓPRIO cliente_parceiro
  // Importante: filtra por user_id (sub do JWT) — cliente só edita o próprio.
  app.post('/v1/cliente/perfil/tiktok', {
    preHandler: [app.authenticate, app.requirePapel(['cliente_parceiro']), clienteFeatureBlocked],
  }, async (request, reply) => {
    const parsed = z.object({ tiktok_username: tiktokUsernameField }).safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const username = parsed.data.tiktok_username ?? null

    return app.withTenant(request.user.tenant_id, async (db) => {
      const upd = await db.query(
        `UPDATE clientes
         SET tiktok_username = $1, atualizado_em = NOW()
         WHERE user_id = $2 AND tenant_id = $3::uuid
         RETURNING id, tiktok_username`,
        [username, request.user.sub, request.user.tenant_id]
      )
      if (!upd.rows[0]) {
        return reply.code(404).send({
          error: 'Conta de cliente não vinculada — peça pro admin associar seu usuário a um cliente.',
        })
      }
      return reply.send(upd.rows[0])
    })
  })

  // GET /v1/cliente/meta
  app.get('/v1/cliente/meta', {
    preHandler: [app.authenticate, app.requirePapel(['cliente_parceiro'])],
  }, async (request, reply) => {
    const ano = parseInt(request.query.ano)
    const mes = parseInt(request.query.mes)

    if (!ano || !mes || mes < 1 || mes > 12) {
      return reply.code(400).send({ error: 'Parâmetros ano e mes são obrigatórios (mes: 1-12)' })
    }

    return app.withTenant(request.user.tenant_id, async (db) => {
      const clienteId = await getClienteId(db, request.user.sub, request.user.tenant_id)
      if (!clienteId) return reply.code(404).send({ error: 'Cliente não encontrado' })

      const res = await db.query(
        'SELECT meta_gmv FROM cliente_metas WHERE cliente_id = $1 AND ano = $2 AND mes = $3',
        [clienteId, ano, mes]
      )

      const meta_gmv = res.rows[0] ? parseFloat(res.rows[0].meta_gmv) : 0
      return reply.send({ ano, mes, meta_gmv })
    })
  })

  // PATCH /v1/cliente/meta
  app.patch('/v1/cliente/meta', {
    preHandler: [app.authenticate, app.requirePapel(['cliente_parceiro']), clienteMetaWriteBlocked],
  }, async (request, reply) => {
    const { ano, mes, meta_gmv } = request.body ?? {}

    if (!ano || !mes || mes < 1 || mes > 12 || meta_gmv == null || !Number.isFinite(parseMoneyToDecimal(meta_gmv))) {
      return reply.code(400).send({ error: 'Campos obrigatórios: ano, mes (1-12), meta_gmv' })
    }

    return app.withTenant(request.user.tenant_id, async (db) => {
      const clienteId = await getClienteId(db, request.user.sub, request.user.tenant_id)
      if (!clienteId) return reply.code(404).send({ error: 'Cliente não encontrado' })

      const res = await db.query(
        `INSERT INTO cliente_metas (tenant_id, cliente_id, ano, mes, meta_gmv)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (cliente_id, ano, mes)
         DO UPDATE SET meta_gmv = EXCLUDED.meta_gmv, atualizado_em = NOW()
         RETURNING ano, mes, meta_gmv`,
        [request.user.tenant_id, clienteId, ano, mes, parseMoneyToDecimal(meta_gmv)]
      )

      const row = res.rows[0]
      return reply.send({ ano: row.ano, mes: row.mes, meta_gmv: parseFloat(row.meta_gmv) })
    })
  })

  // GET /v1/cliente/agenda
  app.get('/v1/cliente/agenda', {
    preHandler: [app.authenticate, app.requirePapel(['cliente_parceiro']), clienteFeatureBlocked],
  }, async (request, reply) => {
    // Parse and default date range to current week Mon–Sun
    let { data_inicio, data_fim } = request.query

    if (!data_inicio || !data_fim) {
      const now = new Date()
      const spNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
      const day = spNow.getDay() // 0=Sun
      const diffToMon = (day === 0 ? -6 : 1 - day)
      const mon = new Date(spNow)
      mon.setDate(spNow.getDate() + diffToMon)
      const sun = new Date(mon)
      sun.setDate(mon.getDate() + 6)
      const fmt = (d) => d.toISOString().slice(0, 10)
      data_inicio = data_inicio ?? fmt(mon)
      data_fim = data_fim ?? fmt(sun)
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(data_inicio) || !/^\d{4}-\d{2}-\d{2}$/.test(data_fim)) {
      return reply.code(400).send({ error: 'data_inicio e data_fim devem ser YYYY-MM-DD' })
    }

    const clienteContext = await resolveClienteContext(request.user)
    if (!clienteContext) return reply.code(404).send({ error: 'Cliente não encontrado' })
    const { clienteId, tenantId } = clienteContext

    return app.withTenant(tenantId, async (db) => {
      // All active cabines for this tenant
      const cabinesRes = await db.query(
        `SELECT id, numero FROM cabines
         WHERE tenant_id = $1::uuid
           AND ativo IS NOT FALSE
         ORDER BY numero`,
        [tenantId]
      )

      // Todos eventos de live no período (exceto cancelado), via agenda_eventos
      // cliente_id é resolvido via marcas.cliente_id
      const slotsRes = await db.query(
        `SELECT ae.id,
                ae.cabine_id,
                (ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::date       AS data_solicitada,
                (ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::time::text AS hora_inicio,
                (ae.data_fim    AT TIME ZONE 'America/Sao_Paulo')::time::text AS hora_fim,
                ae.status,
                mar.cliente_id,
                (mar.cliente_id = $1) AS is_mine
         FROM agenda_eventos ae
         JOIN marcas mar ON mar.id = ae.marca_id AND mar.tenant_id = ae.tenant_id
         WHERE ae.tenant_id = $4::uuid
           AND ae.tipo = 'live'
           AND ae.status != 'cancelado'
           AND (ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::date >= $2::date
           AND (ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::date <= $3::date
         ORDER BY ae.data_inicio`,
        [clienteId, data_inicio, data_fim, tenantId]
      )

      const slots = slotsRes.rows.map((r) => {
        const isMine = r.is_mine
        const data = r.data_solicitada instanceof Date
          ? r.data_solicitada.toISOString().slice(0, 10)
          : String(r.data_solicitada).slice(0, 10)
        const horaInicio = String(r.hora_inicio).slice(0, 5)
        const horaFim = String(r.hora_fim).slice(0, 5)

        if (isMine) {
          // planejado → pendente, confirmado → confirmada, ao_vivo → confirmada
          const statusMap = { planejado: 'pendente', confirmado: 'confirmada', ao_vivo: 'confirmada' }
          const mappedStatus = statusMap[r.status] ?? r.status
          return {
            cabine_id: r.cabine_id,
            data,
            hora_inicio: horaInicio,
            hora_fim: horaFim,
            status: mappedStatus,
            is_mine: true,
            solicitacao_id: r.id,
          }
        } else {
          return {
            cabine_id: r.cabine_id,
            data,
            hora_inicio: horaInicio,
            hora_fim: horaFim,
            status: 'ocupado',
            is_mine: false,
          }
        }
      })

      return reply.send({
        cabines: cabinesRes.rows,
        slots,
      })
    })
  })

  // GET /v1/cliente/reservas — solicitações de live do cliente (agenda pessoal)
  app.get('/v1/cliente/reservas', {
    preHandler: [app.authenticate, app.requirePapel(['cliente_parceiro']), clienteFeatureBlocked],
  }, async (request, reply) => {
    const clienteContext = await resolveClienteContext(request.user)
    if (!clienteContext) return reply.code(404).send({ error: 'Cliente não encontrado' })
    const { clienteId, tenantId } = clienteContext

    return app.withTenant(tenantId, async (db) => {
      const result = await db.query(`
        SELECT ae.id, ae.cabine_id,
               (ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::date       AS data_solicitada,
               (ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::time::text AS hora_inicio,
               (ae.data_fim    AT TIME ZONE 'America/Sao_Paulo')::time::text AS hora_fim,
               ae.status, ae.observacoes AS observacao,
               cab.numero AS cabine_numero
        FROM agenda_eventos ae
        JOIN marcas mar ON mar.id = ae.marca_id AND mar.tenant_id = ae.tenant_id
        JOIN cabines cab ON cab.id = ae.cabine_id AND cab.tenant_id = ae.tenant_id
        WHERE mar.cliente_id = $1
          AND ae.tipo = 'live'
          AND ae.status != 'cancelado'
        ORDER BY ae.data_inicio ASC
      `, [clienteId])

      return result.rows.map((r) => ({
        id: r.id,
        cabine_id: r.cabine_id,
        cabine_numero: r.cabine_numero,
        data: r.data_solicitada instanceof Date
          ? r.data_solicitada.toISOString().slice(0, 10)
          : String(r.data_solicitada).slice(0, 10),
        hora_inicio: String(r.hora_inicio).slice(0, 5),
        hora_fim: String(r.hora_fim).slice(0, 5),
        // planejado → pendente, confirmado/ao_vivo → confirmada
        status: r.status === 'confirmado' || r.status === 'ao_vivo' ? 'confirmada' : r.status === 'planejado' ? 'pendente' : r.status,
        observacoes: r.observacao ?? null,
      }))
    })
  })

  // POST /v1/cliente/solicitacao
  app.post('/v1/cliente/solicitacao', {
    preHandler: [app.authenticate, app.requirePapel(['cliente_parceiro']), clienteFeatureBlocked],
  }, async (request, reply) => {
    const { cabine_id, data_solicitada, hora_inicio, hora_fim, observacoes } = request.body ?? {}

    if (!cabine_id || !data_solicitada || !hora_inicio || !hora_fim) {
      return reply.code(400).send({ error: 'Campos obrigatórios: cabine_id, data_solicitada, hora_inicio, hora_fim' })
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(data_solicitada)) {
      return reply.code(400).send({ error: 'data_solicitada deve ser YYYY-MM-DD' })
    }

    if (!isValidTime(hora_inicio) || !isValidTime(hora_fim)) {
      return reply.code(400).send({ error: 'hora_inicio e hora_fim devem estar no formato HH:MM' })
    }

    const startTime = normalizeTime(hora_inicio)
    const endTime = normalizeTime(hora_fim)
    if (endTime <= startTime) {
      return reply.code(400).send({ error: 'hora_fim deve ser maior que hora_inicio' })
    }

    if (data_solicitada < spTodayISO()) {
      return reply.code(400).send({ error: 'data_solicitada não pode ser no passado' })
    }

    const clienteContext = await resolveClienteContext(request.user)
    if (!clienteContext) return reply.code(404).send({ error: 'Cliente não encontrado' })
    const { clienteId, tenantId } = clienteContext

    return app.withTenant(tenantId, async (db) => {
      // Resolve marca ativa do cliente para criar o evento
      const marcaQ = await db.query(
        `SELECT id FROM marcas WHERE cliente_id = $1 AND tenant_id = $2 AND status = 'ativa' ORDER BY criado_em ASC LIMIT 1`,
        [clienteId, tenantId]
      )
      const marcaId = marcaQ.rows[0]?.id ?? null
      if (!marcaId) {
        return reply.code(422).send({ error: 'Sua conta não possui marca ativa. Entre em contato com a unidade.' })
      }

      const cabineQ = await db.query(
        `SELECT id
         FROM cabines
         WHERE id = $1
           AND tenant_id = $2::uuid
           AND ativo IS NOT FALSE
         LIMIT 1`,
        [cabine_id, tenantId]
      )
      if (!cabineQ.rows[0]) {
        return reply.code(404).send({ error: 'Cabine não encontrada ou inativa.' })
      }

      // Check for time overlap conflict em agenda_eventos (exceto cancelado)
      const conflictRes = await db.query(
        `SELECT id FROM agenda_eventos
         WHERE cabine_id = $1
           AND tenant_id = $5::uuid
           AND tipo = 'live'
           AND status != 'cancelado'
           AND data_inicio < ($2::date + $4::time) AT TIME ZONE 'America/Sao_Paulo'
           AND data_fim    > ($2::date + $3::time) AT TIME ZONE 'America/Sao_Paulo'
         LIMIT 1`,
        [cabine_id, data_solicitada, startTime, endTime, tenantId]
      )

      if (conflictRes.rows.length > 0) {
        return reply.code(409).send({ error: 'Horário indisponível. Escolha outro horário ou cabine.' })
      }

      // Insert em agenda_eventos com status='planejado' (equivalente a 'pendente')
      const obs = observacoes ?? null
      const insertRes = await db.query(
        `INSERT INTO agenda_eventos
           (tenant_id, cabine_id, marca_id, criado_por,
            data_inicio, data_fim, tipo, status, observacoes)
         VALUES ($1, $2, $3, $4,
                 ($5::date + $6::time) AT TIME ZONE 'America/Sao_Paulo',
                 ($5::date + $7::time) AT TIME ZONE 'America/Sao_Paulo',
                 'live', 'planejado', $8)
         RETURNING id, status`,
        [tenantId, cabine_id, marcaId, request.user.sub, data_solicitada, startTime, endTime, obs]
      )

      const row = insertRes.rows[0]
      return reply.code(201).send({
        id: row.id,
        // Retorna 'pendente' para compatibilidade com o frontend
        status: 'pendente',
        message: 'Solicitação enviada! A unidade irá confirmar em breve.',
      })
    })
  })

  // GET /v1/contratos/meu — contrato do cliente_parceiro autenticado
  app.get('/v1/contratos/meu', {
    preHandler: [app.authenticate, app.requirePapel(['cliente_parceiro']), clienteFeatureBlocked],
  }, async (request, reply) => {
    const clienteContext = await resolveClienteContext(request.user)
    if (!clienteContext) return reply.code(404).send({ error: 'Cliente não encontrado' })
    const { clienteId, tenantId } = clienteContext

    return app.withTenant(tenantId, async (db) => {
      const result = await db.query(`
        SELECT c.id, c.status, c.valor_fixo, c.comissao_pct,
               c.horas_contratadas, c.horas_consumidas,
               (c.horas_contratadas - c.horas_consumidas) AS horas_restantes,
               c.assinado_em, c.ativado_em, c.criado_em,
               p.nome AS pacote_nome
        FROM contratos c
        LEFT JOIN pacotes p ON p.id = c.pacote_id
        WHERE c.cliente_id = $1
        ORDER BY c.criado_em DESC
        LIMIT 1
      `, [clienteId])

      // Sem contrato ativo é estado válido (cliente novo). Retorna null em vez
      // de 404 pra evitar ruído no console + simplificar handling no frontend.
      if (!result.rows[0]) return reply.send(null)
      return result.rows[0]
    })
  })
}
