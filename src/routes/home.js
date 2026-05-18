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
            c.numero, c.status, c.live_atual_id,
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
             WHERE la.live_id = c.live_atual_id) AS apresentadores_extra
        FROM cabines c
        LEFT JOIN lives l ON l.id = c.live_atual_id AND l.tenant_id = c.tenant_id
        LEFT JOIN clientes cl ON cl.id = l.cliente_id AND cl.tenant_id = c.tenant_id
        LEFT JOIN users u ON u.id = l.apresentador_id
        LEFT JOIN contratos ct ON ct.id = c.contrato_id AND ct.tenant_id = c.tenant_id
        LEFT JOIN LATERAL (
            SELECT viewer_count, total_orders, gmv
            FROM live_snapshots
            WHERE live_id = c.live_atual_id
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
        livesMesAnteriorQ,
        livesHojeQ,
        mediaViewersQ,
        pipelineQ,
        taxaConversaoQ,
        alertasOpsQ,
        ocupacaoQ,
        rankingResult,
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
        SELECT COUNT(id) AS lives_mes, COALESCE(SUM(fat_gerado), 0) AS gmv_lives_mes
        FROM lives
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND status = 'encerrada'
          AND date_trunc('month', iniciado_em AT TIME ZONE 'America/Sao_Paulo')
              = date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')
      `),
        db.query(`
        SELECT COALESCE(SUM(fat_gerado), 0) AS gmv_lives_mes_anterior
        FROM lives
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
          AND status = 'encerrada'
          AND date_trunc('month', iniciado_em AT TIME ZONE 'America/Sao_Paulo')
              = date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo') - INTERVAL '1 month')
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
          (SELECT COUNT(*) FROM live_requests
           WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
             AND data_solicitada >= DATE_TRUNC('week', CURRENT_DATE)
             AND data_solicitada < DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '7 days'
             AND status IN ('aprovada','pendente')) AS agendamentos_semana,
          (SELECT COUNT(*) FROM leads
           WHERE franqueadora_id = $1
             AND crm_etapa NOT IN ('ganho','perdido')
             AND status != 'expirado'
             AND COALESCE(atualizado_em, criado_em) < NOW() - INTERVAL '7 days') AS leads_parados,
          (SELECT COUNT(*) FROM (
            SELECT lr1.id
            FROM live_requests lr1
            JOIN live_requests lr2
              ON lr1.cabine_id = lr2.cabine_id
             AND lr1.data_solicitada = lr2.data_solicitada
             AND lr1.id < lr2.id
             AND lr1.hora_inicio < lr2.hora_fim
             AND lr1.hora_fim > lr2.hora_inicio
             AND lr1.status = 'aprovada'
             AND lr2.status = 'aprovada'
             AND lr1.tenant_id = current_setting('app.tenant_id', true)::uuid
             AND lr2.tenant_id = current_setting('app.tenant_id', true)::uuid
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
          COUNT(*) FILTER (WHERE status = 'ao_vivo') AS ao_vivo,
          COUNT(*) FILTER (WHERE ativo IS NOT FALSE) AS operacionais
        FROM cabines
        WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
      `),
        db.query(`
        SELECT cl.nome, COALESCE(SUM(l.fat_gerado), 0) AS gmv, COUNT(l.id) AS lives
        FROM lives l
        JOIN clientes cl ON cl.id = l.cliente_id
         AND cl.tenant_id = l.tenant_id
        WHERE l.status = 'encerrada'
          AND l.tenant_id = current_setting('app.tenant_id', true)::uuid
          AND date_trunc('day', l.iniciado_em) = date_trunc('day', NOW())
        GROUP BY cl.id, cl.nome
        ORDER BY gmv DESC
        LIMIT 5
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

      // 8. Próximas lives do dia (agendamentos aprovados com hora futura)
      let proximasLives = []
      try {
        const proximasQ = await db.query(`
          SELECT lr.id, lr.data_solicitada, lr.hora_inicio, lr.hora_fim,
                 c.numero AS cabine_numero, cl.nome AS cliente_nome
          FROM live_requests lr
          JOIN cabines c ON c.id = lr.cabine_id
           AND c.tenant_id = lr.tenant_id
          JOIN clientes cl ON cl.id = lr.cliente_id
           AND cl.tenant_id = lr.tenant_id
          WHERE lr.tenant_id = current_setting('app.tenant_id', true)::uuid
            AND lr.data_solicitada = CURRENT_DATE
            AND lr.hora_inicio > (CURRENT_TIME AT TIME ZONE 'America/Sao_Paulo')::time
            AND lr.status = 'aprovada'
          ORDER BY lr.hora_inicio
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
      } catch (_) {
        // live_requests pode não existir em ambientes sem a migration 025
      }

      let agendaHoje = []
      try {
        const agendaQ = await db.query(`
          SELECT ae.id, ae.tipo, ae.status, ae.data_inicio, ae.data_fim,
                 c.numero AS cabine_numero,
                 c.nome AS cabine_nome,
                 m.nome AS marca_nome,
                 cl.nome AS cliente_nome,
                 ap.nome AS apresentadora_nome
          FROM agenda_eventos ae
          JOIN marcas m ON m.id = ae.marca_id
           AND m.tenant_id = ae.tenant_id
          LEFT JOIN clientes cl ON cl.id = m.cliente_id
           AND cl.tenant_id = ae.tenant_id
          LEFT JOIN cabines c ON c.id = ae.cabine_id
           AND c.tenant_id = ae.tenant_id
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
          ) ap ON true
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

      let rankingApresentadorasHoje = []
      try {
        const rankingApQ = await db.query(`
          SELECT u.id, u.nome AS apresentadora_nome,
                 COALESCE(SUM(l.fat_gerado), 0) AS gmv,
                 COUNT(l.id) AS lives
          FROM lives l
          JOIN users u ON u.id = l.apresentador_id
           AND u.tenant_id = l.tenant_id
          WHERE l.tenant_id = current_setting('app.tenant_id', true)::uuid
            AND l.status = 'encerrada'
            AND date_trunc('day', l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')
                = date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo')
          GROUP BY u.id, u.nome
          ORDER BY gmv DESC, lives DESC, u.nome ASC
          LIMIT 10
        `)
        rankingApresentadorasHoje = rankingApQ.rows.map(r => {
          const lives = Number(r.lives)
          const gmv = round2(r.gmv)
          return {
            id: r.id,
            nome: r.apresentadora_nome,
            apresentadora_nome: r.apresentadora_nome,
            gmv,
            lives,
            gmv_medio_live: lives > 0 ? round2(gmv / lives) : 0
          }
        })
      } catch (error) {
        request.log?.warn?.({ err: error }, 'home/dashboard: ranking de apresentadoras indisponível')
      }

      // 9. Ranking do Dia (já paralelizado no Grupo 2)
      const rankingDia = rankingResult.rows.map(r => ({
        nome: r.nome,
        gmv: parseFloat(Number(r.gmv).toFixed(2)),
        lives: Number(r.lives)
      }))

      const gmvMes = round2(livesMesQ.rows[0].gmv_lives_mes)
      const livesMes = Number(livesMesQ.rows[0].lives_mes)
      const gmvMesAnterior = round2(livesMesAnteriorQ.rows[0].gmv_lives_mes_anterior)
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
        gmv_lives_mes:    gmvMes,
        media_viewers:    Math.round(Number(mediaViewersQ.rows[0].media)),

        // Operação live commerce
        gmv_ao_vivo_agora: gmvAoVivoAgora,
        lives_ativas_agora: liveCabinesAtivas.length,
        lives_hoje: Number(livesHojeQ.rows[0].lives_hoje),
        ticket_medio_live_mes: livesMes > 0 ? round2(gmvMes / livesMes) : 0,
        variacao_gmv_mes_anterior_pct: growthPct(gmvMes, gmvMesAnterior),
        gmv_lives_mes_anterior: gmvMesAnterior,
        alertas_operacionais: alertasOperacionais,
        ranking_apresentadoras_hoje: rankingApresentadorasHoje,
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

        // Ranking do dia
        ranking_dia: rankingDia
      }
      } catch (error) {
        app.log.error({ err: error }, 'ERRO NA ROTA /v1/home/dashboard')
        throw error
      }
    })
  })
}
