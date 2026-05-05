export async function clientePortalRoutes(app) {
  // Helper: resolve cliente_id from authenticated user_id (FK)
  async function getClienteId(db, userId) {
    const res = await db.query('SELECT id FROM clientes WHERE user_id = $1 LIMIT 1', [userId])
    return res.rows[0]?.id ?? null
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
    preHandler: [app.authenticate, app.requirePapel(['cliente_parceiro'])],
  }, async (request, reply) => {
    const meses = Math.min(Math.max(parseInt(request.query.meses) || 12, 1), 36)
    const ano = parseInt(request.query.ano) || new Date().getFullYear()
    const mes = parseInt(request.query.mes) || (new Date().getMonth() + 1)
    if (mes < 1 || mes > 12) return reply.code(400).send({ error: 'mes inválido' })

    return app.withTenant(request.user.tenant_id, async (db) => {
      const clienteId = await getClienteId(db, request.user.sub)
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
                site, logo_url, status, fat_anual, nicho, cidade, estado
         FROM clientes WHERE user_id = $1 LIMIT 1`,
        [request.user.sub]
      )
      if (r.rows.length === 0) {
        return reply.code(404).send({ error: 'Cliente não encontrado para este usuário.' })
      }
      return r.rows[0]
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
      const clienteId = await getClienteId(db, request.user.sub)
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
    preHandler: [app.authenticate, app.requirePapel(['cliente_parceiro'])],
  }, async (request, reply) => {
    const { ano, mes, meta_gmv } = request.body ?? {}

    if (!ano || !mes || mes < 1 || mes > 12 || meta_gmv == null || isNaN(parseFloat(meta_gmv))) {
      return reply.code(400).send({ error: 'Campos obrigatórios: ano, mes (1-12), meta_gmv' })
    }

    return app.withTenant(request.user.tenant_id, async (db) => {
      const clienteId = await getClienteId(db, request.user.sub)
      if (!clienteId) return reply.code(404).send({ error: 'Cliente não encontrado' })

      const res = await db.query(
        `INSERT INTO cliente_metas (cliente_id, ano, mes, meta_gmv)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cliente_id, ano, mes)
         DO UPDATE SET meta_gmv = EXCLUDED.meta_gmv, atualizado_em = NOW()
         RETURNING ano, mes, meta_gmv`,
        [clienteId, ano, mes, parseFloat(meta_gmv)]
      )

      const row = res.rows[0]
      return reply.send({ ano: row.ano, mes: row.mes, meta_gmv: parseFloat(row.meta_gmv) })
    })
  })

  // GET /v1/cliente/agenda
  app.get('/v1/cliente/agenda', {
    preHandler: [app.authenticate, app.requirePapel(['cliente_parceiro'])],
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

    // Resolve cliente_id from system db (no RLS yet)
    const sysDb = await app.db.pool.connect()
    let clienteId, tenantId
    try {
      const res = await sysDb.query(
        'SELECT c.id AS cliente_id, c.tenant_id FROM clientes c WHERE c.user_id = $1 LIMIT 1',
        [request.user.sub]
      )
      if (!res.rows[0]) return reply.code(404).send({ error: 'Cliente não encontrado' })
      clienteId = res.rows[0].cliente_id
      tenantId = res.rows[0].tenant_id
    } finally {
      sysDb.release()
    }

    return app.withTenant(tenantId, async (db) => {
      // All active cabines for this tenant
      const cabinesRes = await db.query(
        'SELECT id, numero FROM cabines WHERE ativo IS NOT FALSE ORDER BY numero'
      )

      // All live_requests in date range (exclude recusada)
      const slotsRes = await db.query(
        `SELECT lr.id, lr.cabine_id, lr.data_solicitada, lr.hora_inicio, lr.hora_fim,
                lr.status, lr.cliente_id,
                (lr.cliente_id = $1) AS is_mine
         FROM live_requests lr
         WHERE lr.data_solicitada >= $2
           AND lr.data_solicitada <= $3
           AND lr.status != 'recusada'
         ORDER BY lr.data_solicitada, lr.hora_inicio`,
        [clienteId, data_inicio, data_fim]
      )

      const slots = slotsRes.rows.map((r) => {
        const isMine = r.is_mine
        const data = r.data_solicitada instanceof Date
          ? r.data_solicitada.toISOString().slice(0, 10)
          : String(r.data_solicitada).slice(0, 10)
        const horaInicio = String(r.hora_inicio).slice(0, 5)
        const horaFim = String(r.hora_fim).slice(0, 5)

        if (isMine) {
          const mappedStatus = r.status === 'aprovada' ? 'confirmada' : r.status // pendente stays pendente
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
    preHandler: [app.authenticate, app.requirePapel(['cliente_parceiro'])],
  }, async (request, reply) => {
    const sysDb = await app.db.pool.connect()
    let clienteId, tenantId
    try {
      const res = await sysDb.query(
        'SELECT c.id AS cliente_id, c.tenant_id FROM clientes c WHERE c.user_id = $1 LIMIT 1',
        [request.user.sub]
      )
      if (!res.rows[0]) return reply.code(404).send({ error: 'Cliente não encontrado' })
      clienteId = res.rows[0].cliente_id
      tenantId = res.rows[0].tenant_id
    } finally {
      sysDb.release()
    }

    return app.withTenant(tenantId, async (db) => {
      const result = await db.query(`
        SELECT lr.id, lr.cabine_id, lr.data_solicitada, lr.hora_inicio, lr.hora_fim,
               lr.status, lr.observacao,
               cab.numero AS cabine_numero
        FROM live_requests lr
        JOIN cabines cab ON cab.id = lr.cabine_id
        WHERE lr.cliente_id = $1
          AND lr.status != 'recusada'
        ORDER BY lr.data_solicitada ASC, lr.hora_inicio ASC
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
        status: r.status === 'aprovada' ? 'confirmada' : r.status,
        observacoes: r.observacao ?? null,
      }))
    })
  })

  // POST /v1/cliente/solicitacao
  app.post('/v1/cliente/solicitacao', {
    preHandler: [app.authenticate, app.requirePapel(['cliente_parceiro'])],
  }, async (request, reply) => {
    const { cabine_id, data_solicitada, hora_inicio, hora_fim, observacoes } = request.body ?? {}

    if (!cabine_id || !data_solicitada || !hora_inicio || !hora_fim) {
      return reply.code(400).send({ error: 'Campos obrigatórios: cabine_id, data_solicitada, hora_inicio, hora_fim' })
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(data_solicitada)) {
      return reply.code(400).send({ error: 'data_solicitada deve ser YYYY-MM-DD' })
    }

    // Resolve cliente_id + tenant_id from system db
    const sysDb = await app.db.pool.connect()
    let clienteId, tenantId
    try {
      const res = await sysDb.query(
        'SELECT c.id AS cliente_id, c.tenant_id FROM clientes c WHERE c.user_id = $1 LIMIT 1',
        [request.user.sub]
      )
      if (!res.rows[0]) return reply.code(404).send({ error: 'Cliente não encontrado' })
      clienteId = res.rows[0].cliente_id
      tenantId = res.rows[0].tenant_id
    } finally {
      sysDb.release()
    }

    return app.withTenant(tenantId, async (db) => {
      // Check for time overlap conflict
      const conflictRes = await db.query(
        `SELECT id FROM live_requests
         WHERE cabine_id = $1
           AND data_solicitada = $2
           AND status != 'recusada'
           AND hora_inicio < $4
           AND hora_fim > $3
         LIMIT 1`,
        [cabine_id, data_solicitada, hora_inicio, hora_fim]
      )

      if (conflictRes.rows.length > 0) {
        return reply.code(409).send({ error: 'Horário indisponível. Escolha outro horário ou cabine.' })
      }

      // Insert — use observacao (actual column name, no 's')
      const obs = observacoes ?? null
      const insertRes = await db.query(
        `INSERT INTO live_requests (tenant_id, cliente_id, cabine_id, solicitante_id, data_solicitada, hora_inicio, hora_fim, status, observacao)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pendente', $8)
         RETURNING id, status`,
        [tenantId, clienteId, cabine_id, request.user.sub, data_solicitada, hora_inicio, hora_fim, obs]
      )

      const row = insertRes.rows[0]
      return reply.code(201).send({
        id: row.id,
        status: row.status,
        message: 'Solicitação enviada! A unidade irá confirmar em breve.',
      })
    })
  })

  // GET /v1/contratos/meu — contrato do cliente_parceiro autenticado
  app.get('/v1/contratos/meu', {
    preHandler: [app.authenticate, app.requirePapel(['cliente_parceiro'])],
  }, async (request, reply) => {
    const sysDb = await app.db.pool.connect()
    let clienteId, tenantId
    try {
      const res = await sysDb.query(
        'SELECT c.id AS cliente_id, c.tenant_id FROM clientes c WHERE c.user_id = $1 LIMIT 1',
        [request.user.sub]
      )
      if (!res.rows[0]) return reply.code(404).send({ error: 'Cliente não encontrado' })
      clienteId = res.rows[0].cliente_id
      tenantId = res.rows[0].tenant_id
    } finally {
      sysDb.release()
    }

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
