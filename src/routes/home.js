export async function homeRoutes(app) {
  // GET /v1/home/dashboard
  app.get('/v1/home/dashboard', {
    preHandler: app.requirePapel(['franqueado', 'gerente']),
  }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      try {
      const round2 = (value) => parseFloat(Number(value ?? 0).toFixed(2))
      const growthPct = (current, previous) => {
        const actual = Number(current ?? 0)
        const prior = Number(previous ?? 0)
        if (prior <= 0) return actual > 0 ? 100 : 0
        return parseFloat((((actual - prior) / prior) * 100).toFixed(1))
      }

      // ── Grupo 1: queries financeiras + cabines ──
      // Defesa em profundidade: tenant_id explícito em cada query
      // (role Postgres atual tem BYPASSRLS — RLS sozinha não filtra).
      const [fixoQ, varQ, custosQ, cabinesQ] = await Promise.all([
        db.query(`SELECT COALESCE(SUM(valor_fixo), 0) AS valor FROM contratos
                  WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
                    AND status = 'ativo'`),
        db.query(`
        SELECT COALESCE(SUM(l.fat_gerado * (COALESCE(c.comissao_pct, 0) / 100.0)), 0) AS valor
        FROM lives l
        JOIN contratos c ON c.cliente_id = l.cliente_id AND c.status = 'ativo' AND c.tenant_id = l.tenant_id
        WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
          AND l.status = 'encerrada'
          AND date_trunc('month', l.iniciado_em) = date_trunc('month', NOW())
      `),
        db.query(`
        SELECT COALESCE(SUM(valor), 0) AS valor
        FROM custos
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND date_trunc('month', competencia) = date_trunc('month', NOW())
      `),
        db.query(`
        SELECT
            c.numero,
            CASE WHEN l.id IS NOT NULL THEN 'ao_vivo'
                 WHEN c.status = 'ao_vivo' THEN 'disponivel'
                 ELSE c.status
            END AS status,
            l.id AS live_atual_id,
            l.iniciado_em,
            cl.nome AS cliente_nome,
            u.nome AS apresentador,
            COALESCE(ls.total_orders, 0) AS total_orders,
            COALESCE(ls.viewer_count, 0) AS viewer_count,
            COALESCE(ls.gmv, 0) AS gmv_atual,
            COALESCE(ct.horas_contratadas, 0) AS horas_contratadas,
            COALESCE(enc.horas_realizadas_hoje, 0) AS horas_realizadas_hoje,
            (SELECT JSON_AGG(u2.nome ORDER BY la.criado_em)
             FROM live_apresentadores la
             JOIN users u2 ON u2.id = la.apresentador_id
             WHERE la.live_id = l.id) AS apresentadores_extra
        FROM cabines c
        LEFT JOIN LATERAL (
            SELECT l.*
            FROM lives l
            WHERE l.cabine_id = c.id
              AND l.tenant_id = c.tenant_id
              AND l.status = 'em_andamento'
            ORDER BY (l.id = c.live_atual_id) DESC, l.iniciado_em DESC
            LIMIT 1
        ) l ON true
        LEFT JOIN clientes cl ON cl.id = l.cliente_id AND cl.tenant_id = c.tenant_id
        LEFT JOIN users u ON u.id = l.apresentador_id
        LEFT JOIN contratos ct ON ct.id = c.contrato_id AND ct.tenant_id = c.tenant_id
        LEFT JOIN LATERAL (
            SELECT viewer_count, total_orders, gmv
            FROM live_snapshots
            WHERE live_id = l.id
              AND tenant_id = c.tenant_id
            ORDER BY captured_at DESC LIMIT 1
        ) ls ON true
        LEFT JOIN LATERAL (
            SELECT COALESCE(SUM(LEAST(EXTRACT(EPOCH FROM (encerrado_em - iniciado_em)) / 3600.0, 24.0)), 0) AS horas_realizadas_hoje
            FROM lives
            WHERE cabine_id = c.id
              AND tenant_id = c.tenant_id
              AND status = 'encerrada'
              AND encerrado_em IS NOT NULL
              AND date_trunc('day', iniciado_em) = date_trunc('day', NOW())
        ) enc ON true
        WHERE c.tenant_id = current_setting('app.tenant_id', true)::uuid
          AND c.ativo IS NOT FALSE
        ORDER BY c.numero
      `),
      ])

      const fatFixo = Number(fixoQ.rows[0].valor)
      const fatComissao = Number(varQ.rows[0].valor)
      const totalCustos = Number(custosQ.rows[0].valor)
      const fatBruto = fatFixo + fatComissao
      const fatLiquido = fatBruto - totalCustos

      const cabinesFormatadas = cabinesQ.rows.map(c => {
        let duracaoMin = 0;
        if (c.status === 'ao_vivo' && c.iniciado_em) {
          const start = new Date(c.iniciado_em);
          const now = new Date();
          duracaoMin = Math.floor((now - start) / 1000 / 60);
        }
        return {
          numero: c.numero,
          status: c.status,
          live_atual_id: c.live_atual_id,
          viewer_count: Number(c.viewer_count),
          total_orders: Number(c.total_orders),
          gmv_atual: parseFloat(Number(c.gmv_atual).toFixed(2)),
          cliente_nome: c.cliente_nome,
          apresentador: c.apresentador,
          duracao_min: duracaoMin,
          horas_contratadas: parseFloat(Number(c.horas_contratadas).toFixed(2)),
          horas_realizadas_hoje: parseFloat(Number(c.horas_realizadas_hoje).toFixed(2)),
          apresentadores_extra: c.apresentadores_extra || []
        }
      });

      // ── Grupo 2: métricas, pipeline, alertas, ocupação, ranking (independentes) ──
      const [
        clientesQ,
        novosClientesQ,
        livesMesQ,
        gmvOperacionalQ,
        livesHojeQ,
        mediaViewersQ,
        pipelineQ,
        taxaConversaoQ,
        alertasOpsQ,
        ocupacaoQ,
          rankingMarcasQ,
      ] = await Promise.all([
        db.query(`SELECT COUNT(*) AS total FROM clientes
                  WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
                    AND status = 'ativo'`),
        db.query(`
        SELECT COUNT(*) AS total FROM clientes
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND date_trunc('month', criado_em AT TIME ZONE 'America/Sao_Paulo')
              = date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')
          AND status = 'ativo'
      `),
        db.query(`
        SELECT COUNT(id) AS lives_mes
        FROM lives
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND status = 'encerrada'
          AND date_trunc('month', iniciado_em AT TIME ZONE 'America/Sao_Paulo')
              = date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')
      `),
        db.query(`
        WITH home_gmv_operacional AS (
          SELECT
              COALESCE(SUM(va.gmv) FILTER (
                WHERE date_trunc('month', va.data::timestamp AT TIME ZONE 'America/Sao_Paulo')
                      = date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')
              ), 0) AS gmv_total_mes,
              COALESCE(SUM(va.gmv) FILTER (
                WHERE date_trunc('month', va.data::timestamp AT TIME ZONE 'America/Sao_Paulo')
                      = date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')
              ), 0) AS gmv_mes,
              COALESCE(SUM(va.gmv) FILTER (
                WHERE va.origem = 'live'
                AND date_trunc('month', va.data::timestamp AT TIME ZONE 'America/Sao_Paulo')
                    = date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')
            ), 0) AS gmv_lives_mes,
            COALESCE(SUM(va.gmv) FILTER (
              WHERE va.origem = 'video'
                AND date_trunc('month', va.data::timestamp AT TIME ZONE 'America/Sao_Paulo')
                    = date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')
            ), 0) AS gmv_videos_mes,
              COALESCE(SUM(va.gmv) FILTER (
                WHERE date_trunc('month', va.data::timestamp AT TIME ZONE 'America/Sao_Paulo')
                      = date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo') - INTERVAL '1 month')
              ), 0) AS gmv_mes_anterior,
              (
                SELECT COUNT(*)::int
                FROM video_registros vr
                WHERE vr.tenant_id = current_setting('app.tenant_id', true)::uuid
                  AND date_trunc('month', vr.data::timestamp AT TIME ZONE 'America/Sao_Paulo')
                      = date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')
              ) AS videos_mes
            FROM vendas_atribuidas va
          WHERE va.tenant_id = current_setting('app.tenant_id', true)::uuid
        )
        SELECT * FROM home_gmv_operacional
      `),
        db.query(`
        SELECT COUNT(id) AS lives_hoje
        FROM lives
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND date_trunc('day', iniciado_em AT TIME ZONE 'America/Sao_Paulo')
              = date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo')
      `),
        db.query(`
        SELECT COALESCE(AVG(viewer_count), 0) AS media
        FROM live_snapshots
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND date_trunc('month', captured_at) = date_trunc('month', NOW())
      `),
        db.query(`
        SELECT COUNT(*) AS pipeline_aberto, COALESCE(SUM(valor_oportunidade), 0) AS valor_pipeline
        FROM leads
        WHERE franqueadora_id = $1
          AND crm_etapa NOT IN ('ganho','perdido')
          AND status != 'expirado'
      `, [tenant_id]),
        db.query(`
        SELECT
          COUNT(*) FILTER (WHERE crm_etapa = 'ganho') AS ganhos,
          COUNT(*) FILTER (WHERE crm_etapa IN ('ganho','perdido')) AS total_fechados
        FROM leads
        WHERE franqueadora_id = $1
      `, [tenant_id]),
        db.query(`
        SELECT
          (SELECT COUNT(*) FROM clientes
           WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
             AND status = 'inadimplente') AS inadimplentes,
          (SELECT COUNT(*) FROM contratos
           WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
             AND status IN ('rascunho','em_analise')) AS contratos_aguardando_assinatura,
          (SELECT COUNT(*) FROM agenda_eventos ae
           WHERE ae.tenant_id = current_setting('app.tenant_id', true)::uuid
             AND ae.tipo = 'live'
             AND (ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::date >= DATE_TRUNC('week', CURRENT_DATE)::date
             AND (ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::date < (DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '7 days')::date
             AND ae.status IN ('planejado','confirmado','ao_vivo')) AS agendamentos_semana,
          (SELECT COUNT(*) FROM leads
           WHERE franqueadora_id = $1
             AND crm_etapa NOT IN ('ganho','perdido')
             AND status != 'expirado'
             AND COALESCE(atualizado_em, criado_em) < NOW() - INTERVAL '7 days') AS leads_parados,
          (SELECT COUNT(*) FROM (
            SELECT ae1.id
            FROM agenda_eventos ae1
            JOIN agenda_eventos ae2
              ON ae1.cabine_id = ae2.cabine_id
             AND ae1.id < ae2.id
             AND ae1.data_inicio < ae2.data_fim
             AND ae1.data_fim > ae2.data_inicio
             AND ae1.status IN ('planejado','confirmado','ao_vivo')
             AND ae2.status IN ('planejado','confirmado','ao_vivo')
             AND ae1.tenant_id = current_setting('app.tenant_id', true)::uuid
             AND ae2.tenant_id = current_setting('app.tenant_id', true)::uuid
          ) t) AS conflitos_agenda,
          (SELECT COUNT(*) FROM contratos
           WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
             AND status = 'em_analise') AS contratos_analise,
          (SELECT COUNT(*) FROM boletos
           WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
             AND (status = 'vencido'
              OR (status = 'pendente' AND vencimento < NOW()))) AS boletos_vencidos,
          (SELECT COUNT(*) FROM leads
           WHERE franqueadora_id = $1
             AND pego_por IS NULL
             AND status = 'disponivel') AS leads_disponiveis,
          (SELECT COUNT(*) FROM cabines
           WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
             AND ativo IS NOT FALSE
             AND status = 'manutencao') AS cabines_manutencao,
          (SELECT COUNT(*) FROM lives
           WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
             AND status = 'em_andamento'
             AND apresentador_id IS NULL) AS lives_sem_apresentador,
          (SELECT COUNT(*) FROM lives
           WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
             AND status = 'em_andamento'
             AND iniciado_em < NOW() - INTERVAL '4 hours') AS lives_abertas_mais_4h,
          (SELECT COUNT(*)
           FROM lives l
           LEFT JOIN LATERAL (
             SELECT captured_at
             FROM live_snapshots ls
             WHERE ls.live_id = l.id
               AND ls.tenant_id = l.tenant_id
             ORDER BY captured_at DESC
             LIMIT 1
           ) snap ON true
           WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
             AND l.status = 'em_andamento'
             AND (snap.captured_at IS NULL OR snap.captured_at < NOW() - INTERVAL '5 minutes')) AS lives_sem_snapshot_recente
      `, [tenant_id]),
        db.query(`
        SELECT
          COUNT(*) FILTER (WHERE l.status = 'em_andamento') AS ao_vivo,
          COUNT(*) FILTER (WHERE c.ativo IS NOT FALSE) AS operacionais
        FROM cabines c
        LEFT JOIN LATERAL (
          SELECT l.*
          FROM lives l
          WHERE l.cabine_id = c.id
            AND l.tenant_id = c.tenant_id
            AND l.status = 'em_andamento'
          ORDER BY (l.id = c.live_atual_id) DESC, l.iniciado_em DESC
          LIMIT 1
        ) l ON true
        WHERE c.tenant_id = current_setting('app.tenant_id', true)::uuid
      `),
        db.query(`
          WITH ranking_marcas_mes AS (
            SELECT
              va.marca_id,
              m.nome,
              COALESCE(SUM(va.gmv), 0) AS gmv,
              COUNT(DISTINCT va.origem_id) FILTER (WHERE va.origem = 'live')::int AS lives
            FROM vendas_atribuidas va
            JOIN marcas m ON m.id = va.marca_id
             AND m.tenant_id = va.tenant_id
            WHERE va.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND va.marca_id IS NOT NULL
              AND va.origem IN ('live', 'video')
              AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
              AND date_trunc('month', va.data::timestamp AT TIME ZONE 'America/Sao_Paulo')
                  = date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')
            GROUP BY va.marca_id, m.nome
          )
          SELECT marca_id, nome, gmv, lives
          FROM ranking_marcas_mes
          ORDER BY gmv DESC, nome ASC
          LIMIT 10
        `),
      ])

      const ganhos = Number(taxaConversaoQ.rows[0].ganhos)
      const totalFechados = Number(taxaConversaoQ.rows[0].total_fechados)
      const taxaConversao = totalFechados > 0
        ? parseFloat(((ganhos / totalFechados) * 100).toFixed(1))
        : 0

      const alertas = alertasOpsQ.rows[0]
      const ocupacao = {
        ao_vivo: Number(ocupacaoQ.rows[0].ao_vivo),
        operacionais: Number(ocupacaoQ.rows[0].operacionais)
      }

      // 8. Próximas lives do dia (agenda operacional)
      let proximasLives = []
      try {
        const proximasQ = await db.query(`
          WITH proximas_lives_operacionais AS (
            SELECT ae.id,
                   (ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::date AS data_solicitada,
                   (ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::time AS hora_inicio,
                   (ae.data_fim AT TIME ZONE 'America/Sao_Paulo')::time AS hora_fim,
                   c.numero AS cabine_numero,
                   COALESCE(cl.nome, m.nome) AS cliente_nome
            FROM agenda_eventos ae
            JOIN marcas m ON m.id = ae.marca_id
             AND m.tenant_id = ae.tenant_id
            LEFT JOIN clientes cl ON cl.id = m.cliente_id
             AND cl.tenant_id = ae.tenant_id
            LEFT JOIN cabines c ON c.id = ae.cabine_id
             AND c.tenant_id = ae.tenant_id
            WHERE ae.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND ae.tipo = 'live'
              AND (ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::date = CURRENT_DATE
              AND ae.data_inicio > NOW()
              AND ae.status IN ('planejado','confirmado')
          )
          SELECT *
          FROM proximas_lives_operacionais
          ORDER BY hora_inicio
          LIMIT 5
        `)
        proximasLives = proximasQ.rows.map(r => ({
          id: r.id,
          data_solicitada: r.data_solicitada,
          hora_inicio: r.hora_inicio,
          hora_fim: r.hora_fim,
          cabine_numero: Number(r.cabine_numero),
          cliente_nome: r.cliente_nome
        }))
      } catch (error) {
        request.log?.warn?.({ err: error }, 'home/dashboard: próximas lives (agenda_eventos) indisponível')
        proximasLives = []
      }

      let agendaHoje = []
      try {
        const agendaQ = await db.query(`
          SELECT ae.id, ae.tipo, ae.status, ae.data_inicio, ae.data_fim,
                 c.numero AS cabine_numero,
                 c.nome AS cabine_nome,
                 m.nome AS marca_nome,
                 cl.nome AS cliente_nome,
                 COALESCE(a_evento.nome, ap_marca.nome) AS apresentadora_nome
          FROM agenda_eventos ae
          JOIN marcas m ON m.id = ae.marca_id
           AND m.tenant_id = ae.tenant_id
          LEFT JOIN clientes cl ON cl.id = m.cliente_id
           AND cl.tenant_id = ae.tenant_id
          LEFT JOIN cabines c ON c.id = ae.cabine_id
           AND c.tenant_id = ae.tenant_id
          LEFT JOIN apresentadoras a_evento ON a_evento.id = ae.apresentadora_id
           AND a_evento.tenant_id = ae.tenant_id
          LEFT JOIN LATERAL (
            SELECT a.nome
            FROM apresentadora_marcas am
            JOIN apresentadoras a ON a.id = am.apresentadora_id
             AND a.tenant_id = am.tenant_id
            WHERE am.tenant_id = ae.tenant_id
              AND am.marca_id = ae.marca_id
              AND am.ativo IS NOT FALSE
            ORDER BY (am.papel = 'principal') DESC, a.nome ASC
            LIMIT 1
          ) ap_marca ON true
          WHERE ae.tenant_id = current_setting('app.tenant_id', true)::uuid
            AND (ae.data_inicio AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
          ORDER BY ae.data_inicio ASC
          LIMIT 50
        `)
        agendaHoje = agendaQ.rows.map(r => ({
          id: r.id,
          tipo: r.tipo,
          status: r.status,
          data_inicio: r.data_inicio,
          data_fim: r.data_fim,
          cabine_numero: r.cabine_numero == null ? null : Number(r.cabine_numero),
          cabine_nome: r.cabine_nome,
          marca_nome: r.marca_nome,
          cliente_nome: r.cliente_nome,
          apresentadora_nome: r.apresentadora_nome
        }))
      } catch (error) {
        request.log?.warn?.({ err: error }, 'home/dashboard: agenda_eventos indisponível')
      }

      let rankingApresentadorasMes = []
      try {
        const rankingApQ = await db.query(`
          WITH ranking_apresentadoras_mes AS (
            SELECT
              va.apresentadora_id AS id,
              a.nome AS apresentadora_nome,
              COALESCE(a.fixo, 0) AS fixo,
              COALESCE(SUM(va.gmv), 0) AS gmv,
              COUNT(DISTINCT va.origem_id) FILTER (WHERE va.origem = 'live')::int AS lives,
              COALESCE(SUM(va.comissao_apresentadora), 0) AS comissao_variavel
            FROM vendas_atribuidas va
            JOIN apresentadoras a ON a.id = va.apresentadora_id
             AND a.tenant_id = va.tenant_id
            WHERE va.tenant_id = current_setting('app.tenant_id', true)::uuid
              AND va.apresentadora_id IS NOT NULL
              AND va.origem IN ('live', 'video')
              AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
              AND date_trunc('month', va.data::timestamp AT TIME ZONE 'America/Sao_Paulo')
                  = date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')
            GROUP BY va.apresentadora_id, a.nome, a.fixo
          )
          SELECT id, apresentadora_nome, fixo, gmv, lives, comissao_variavel,
                 (fixo + comissao_variavel) AS total_recebido
          FROM ranking_apresentadoras_mes
          ORDER BY total_recebido DESC, gmv DESC, apresentadora_nome ASC
          LIMIT 10
        `)
        rankingApresentadorasMes = rankingApQ.rows.map(r => {
          const lives = Number(r.lives)
          const gmv = round2(r.gmv)
          const fixo = round2(r.fixo)
          const comissaoVariavel = round2(r.comissao_variavel)
          return {
            id: r.id,
            nome: r.apresentadora_nome,
            apresentadora_nome: r.apresentadora_nome,
            gmv,
            lives,
            fixo,
            comissao_variavel: comissaoVariavel,
            total_recebido: round2(r.total_recebido),
            gmv_medio_live: lives > 0 ? round2(gmv / lives) : 0
          }
        })
      } catch (error) {
        request.log?.warn?.({ err: error }, 'home/dashboard: ranking de apresentadoras indisponível')
      }

      const rankingMarcasMes = rankingMarcasQ.rows.map(r => ({
        marca_id: r.marca_id,
        nome: r.nome,
        gmv: parseFloat(Number(r.gmv).toFixed(2)),
        lives: Number(r.lives)
      }))

      const gmvOperacional = gmvOperacionalQ.rows[0] ?? {}
      const gmvMes = round2(gmvOperacional.gmv_total_mes ?? gmvOperacional.gmv_mes)
      const gmvLivesMes = round2(gmvOperacional.gmv_lives_mes)
      const gmvVideosMes = round2(gmvOperacional.gmv_videos_mes)
      const videosMes = Number(gmvOperacional.videos_mes ?? 0)
      const livesMes = Number(livesMesQ.rows[0].lives_mes)
      const gmvMesAnterior = round2(gmvOperacional.gmv_mes_anterior)
      const liveCabinesAtivas = cabinesFormatadas.filter(c => c.status === 'ao_vivo')
      const gmvAoVivoAgora = round2(liveCabinesAtivas.reduce((acc, c) => acc + Number(c.gmv_atual ?? 0), 0))
      const alertasOperacionais = [
        { tipo: 'conflitos_agenda', label: 'Conflitos de agenda', valor: Number(alertas.conflitos_agenda), prioridade: 'alta' },
        { tipo: 'lives_sem_apresentador', label: 'Lives sem apresentadora definida', valor: Number(alertas.lives_sem_apresentador), prioridade: 'media' },
        { tipo: 'lives_sem_snapshot_recente', label: 'Lives sem snapshot recente', valor: Number(alertas.lives_sem_snapshot_recente), prioridade: 'media' },
        { tipo: 'lives_abertas_mais_4h', label: 'Lives abertas há mais de 4 horas', valor: Number(alertas.lives_abertas_mais_4h), prioridade: 'media' },
        { tipo: 'cabines_manutencao', label: 'Cabines em manutenção', valor: Number(alertas.cabines_manutencao), prioridade: 'baixa' },
      ]

      return {
        // Financeiro
        gmv_total_mes: gmvMes,
        gmv_mes:     gmvMes,
        fat_total:   parseFloat(fatBruto.toFixed(2)),
        fat_bruto:   parseFloat(fatBruto.toFixed(2)),
        fat_liquido: parseFloat(fatLiquido.toFixed(2)),

        // Cabines
        cabines: cabinesFormatadas,

        // Ocupação e próximas lives
        ocupacao_cabines_hoje: ocupacao,
        proximas_lives_dia: proximasLives,

        // Pipeline CRM
        pipeline_aberto:  Number(pipelineQ.rows[0].pipeline_aberto),
        valor_pipeline:   parseFloat(Number(pipelineQ.rows[0].valor_pipeline).toFixed(2)),
        taxa_conversao:   taxaConversao,

        // Resumo do mês
        clientes_ativos:  Number(clientesQ.rows[0].total),
        novos_clientes:   Number(novosClientesQ.rows[0].total),
        lives_mes:        livesMes,
        videos_mes:       videosMes,
        gmv_lives_mes:    gmvLivesMes,
        gmv_videos_mes:   gmvVideosMes,
        media_viewers:    Math.round(Number(mediaViewersQ.rows[0].media)),

        // Operação live commerce
        gmv_ao_vivo_agora: gmvAoVivoAgora,
        lives_ativas_agora: liveCabinesAtivas.length,
        lives_hoje: Number(livesHojeQ.rows[0].lives_hoje),
        ticket_medio_live_mes: livesMes > 0 ? round2(gmvLivesMes / livesMes) : 0,
        variacao_gmv_mes_anterior_pct: growthPct(gmvMes, gmvMesAnterior),
        gmv_lives_mes_anterior: gmvMesAnterior,
        alertas_operacionais: alertasOperacionais,
        ranking_apresentadoras_mes: rankingApresentadorasMes,
        ranking_apresentadoras_hoje: rankingApresentadorasMes,
        agenda_hoje: agendaHoje,

        // Alertas operacionais
        inadimplentes:                   Number(alertas.inadimplentes),
        contratos_aguardando_assinatura: Number(alertas.contratos_aguardando_assinatura),
        agendamentos_semana:             Number(alertas.agendamentos_semana),
        leads_parados:                   Number(alertas.leads_parados),
        conflitos_agenda:                Number(alertas.conflitos_agenda),
        cabines_manutencao:              Number(alertas.cabines_manutencao),
        lives_sem_apresentador:          Number(alertas.lives_sem_apresentador),
        lives_sem_snapshot_recente:      Number(alertas.lives_sem_snapshot_recente),
        lives_abertas_mais_4h:           Number(alertas.lives_abertas_mais_4h),

        // Alertas legado
        contratos_analise: Number(alertas.contratos_analise),
        boletos_vencidos:  Number(alertas.boletos_vencidos),
        leads_disponiveis: Number(alertas.leads_disponiveis),

        // Ranking comercial mensal
        ranking_marcas_mes: rankingMarcasMes
      }
      } catch (error) {
        app.log.error({ err: error }, 'ERRO NA ROTA /v1/home/dashboard')
        throw error
      }
    })
  })
}
