import { z } from 'zod'
import { READ_ANALYTICS } from '../config/role_groups.js'
import { apresentadoraHorasPresencaSql, liveGmvSql } from '../lib/metric-sql.js'
import { presenterFanoutSql, presenterGmvShareSql, notArchivedSql } from '../lib/live-count-sql.js'
import { activeLiveSql } from '../lib/live-merge-sql.js'
import { countWeekdaysInMonth } from '../lib/dias_uteis.js'
import { saoPauloDateInput } from '../lib/timezone.js'
import { assertCurrentGoalMonth, buildOperationalGoals, shiftProgress, validateOperationalConfig } from '../lib/operational-goals.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const money = z.number().finite().min(0).max(9999999999999.99).refine(v => /^\d{1,13}(?:\.\d{1,2})?$/.test(String(v)))
const nullableMoney = z.union([money,z.null()])
const configSchema = z.object({
  horas_por_apresentador: z.number().finite().positive().max(24),
  cabines_consideradas: z.number().int().min(1).max(100),
  turnos: z.array(z.object({ inicio: z.string(), fim: z.string() }).strict()).min(1).max(8),
}).strict()

export async function analyticsOperacionalRoutes(app) {
  app.get('/v1/analytics/operacao', {
    preHandler: app.requirePapel(READ_ANALYTICS),
    schema: { querystring: { type: 'object', required: ['data'], properties: { data: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }, additionalProperties: false } },
  }, async (request, reply) => {
    const day = request.query.data
    if (!DATE_RE.test(day) || new Date(day + 'T12:00:00Z').toISOString().slice(0, 10) !== day) return reply.code(400).send({ error: 'data deve ser uma data válida no formato YYYY-MM-DD.' })
    const today = saoPauloDateInput(new Date())
    if (day > today) return reply.code(400).send({ error: 'O painel operacional não consulta datas futuras.' })
    const month = day.slice(0, 7), tenantId = request.user.tenant_id
    const start = month + '-01'
    return app.withTenant(tenantId, async db => {
      const result = await db.query(
        'SELECT meta_gmv,meta_horas_live,meta_gmv_hora,configuracao_operacional FROM meta_unidade WHERE tenant_id=$1 AND ano_mes=$2 LIMIT 1',
        [tenantId, month],
      )
      const fallback = await db.query('SELECT meta_diaria_gmv FROM tenants WHERE id=$1 LIMIT 1', [tenantId])
      const presenters = await db.query(
        'SELECT a.id,a.nome,a.ativo,ma.meta_gmv_hora FROM apresentadoras a LEFT JOIN metas_apresentadora ma ON ma.tenant_id=a.tenant_id AND ma.apresentadora_id=a.id AND ma.mes_referencia=$2::date WHERE a.tenant_id=$1 AND a.arquivada=false ORDER BY a.nome',
        [tenantId, start],
      )
      const brands = await db.query(
        'SELECT m.id,m.nome,m.status,mmh.meta_gmv_hora FROM marcas m LEFT JOIN marca_metas_hora mmh ON mmh.tenant_id=m.tenant_id AND mmh.marca_id=m.id AND mmh.ano_mes=$2 WHERE m.tenant_id=$1 ORDER BY m.nome',
        [tenantId, month],
      )
      const lives = await db.query(
        'SELECT l.id,l.status,l.marca_id,m.nome AS marca_nome,c.numero::text AS cabine_nome,(l.iniciado_em AT TIME ZONE \'America/Sao_Paulo\')::date::text AS dia,' +
        liveGmvSql('l') + ' AS gmv,(l.ads_gmv IS NULL AND l.manual_gmv IS NULL AND l.fat_gerado IS NULL) AS gmv_incompleto,' +
        "CASE WHEN COALESCE(l.encerrado_em,CASE WHEN l.status='em_andamento' THEN NOW() ELSE l.previsto_fim END)>l.iniciado_em THEN LEAST(GREATEST(EXTRACT(EPOCH FROM (COALESCE(l.encerrado_em,CASE WHEN l.status='em_andamento' THEN NOW() ELSE l.previsto_fim END)-l.iniciado_em))/3600.0,0),24) ELSE 0 END AS horas," +
        "(l.status='encerrada' AND (l.encerrado_em IS NULL OR l.encerrado_em<=l.iniciado_em)) AS tempo_incompleto FROM lives l " +
        'LEFT JOIN marcas m ON m.id=l.marca_id AND m.tenant_id=l.tenant_id LEFT JOIN cabines c ON c.id=l.cabine_id AND c.tenant_id=l.tenant_id ' +
        'WHERE l.tenant_id=current_setting(\'app.tenant_id\',true)::uuid AND ' + activeLiveSql('l') + ' AND ' + notArchivedSql('l') +
        " AND l.status IN ('encerrada','em_andamento') AND l.iniciado_em>=($1::timestamp AT TIME ZONE 'America/Sao_Paulo') AND l.iniciado_em<(($2::timestamp+INTERVAL '1 day') AT TIME ZONE 'America/Sao_Paulo') ORDER BY dia,l.iniciado_em",
        [start, day],
      )
      const credits = await db.query(
        'SELECT l.id AS live_id,ap_v2.apresentadora_id,a.nome AS apresentadora_nome,' +
        apresentadoraHorasPresencaSql({ end:"CASE WHEN l.status='em_andamento' THEN NOW() ELSE COALESCE(l.encerrado_em,l.previsto_fim) END" }) + ' AS horas_presenca,' + presenterGmvShareSql('l','ap_v2') + ' AS gmv ' +
        'FROM lives l ' + presenterFanoutSql({ live:'l', rateio:'ap_v2' }) +
        ' JOIN apresentadoras a ON a.id=ap_v2.apresentadora_id AND a.tenant_id=l.tenant_id ' +
        'LEFT JOIN LATERAL (SELECT SUM(EXTRACT(EPOCH FROM (aea.data_fim-aea.data_inicio))/3600.0) AS horas_turno FROM agenda_evento_apresentadoras aea WHERE aea.agenda_evento_id=l.agenda_evento_id AND aea.tenant_id=l.tenant_id AND aea.apresentadora_id=ap_v2.apresentadora_id) turno ON true ' +
        'WHERE l.tenant_id=current_setting(\'app.tenant_id\',true)::uuid AND ' + activeLiveSql('l') + ' AND ' + notArchivedSql('l') +
        " AND l.status IN ('encerrada','em_andamento') AND l.iniciado_em>=($1::timestamp AT TIME ZONE 'America/Sao_Paulo') AND l.iniciado_em<(($2::timestamp+INTERVAL '1 day') AT TIME ZONE 'America/Sao_Paulo') ORDER BY l.iniciado_em,a.nome",
        [start, day],
      )
      const videos = await db.query(
        "SELECT va.data::text AS dia,COALESCE(SUM(va.gmv),0) AS gmv,va.status_aprovacao FROM vendas_atribuidas va WHERE va.tenant_id=current_setting('app.tenant_id',true)::uuid AND va.origem='video' AND va.status_aprovacao IN ('aprovada','fechada','faturada') AND va.data >= $1::date AND va.data < ($2::date+INTERVAL '1 day') GROUP BY va.data,va.status_aprovacao ORDER BY va.data",
        [start, day],
      )
      const pendingVideos = await db.query(
        "SELECT va.data::text AS dia,va.marca_id,va.apresentadora_id FROM vendas_atribuidas va WHERE va.tenant_id=current_setting('app.tenant_id',true)::uuid AND va.origem='video' AND COALESCE(va.status_aprovacao,'pendente_aprovacao')='pendente_aprovacao' AND va.data >= $1::date AND va.data <= $2::date",
        [start, day],
      )
      const pending = await db.query(
        "SELECT s.id,s.apresentadora_id,s.marca_id,s.gmv_declarado,(s.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia FROM apresentadora_live_submissoes s WHERE s.tenant_id=current_setting('app.tenant_id',true)::uuid AND s.status='pendente' AND s.iniciado_em >= ($1::timestamp AT TIME ZONE 'America/Sao_Paulo') AND s.iniciado_em < (($2::timestamp+INTERVAL '1 day') AT TIME ZONE 'America/Sao_Paulo')",
        [start, day],
      )
      const cabins = await db.query("SELECT COUNT(*)::int AS total FROM cabines WHERE tenant_id=current_setting('app.tenant_id',true)::uuid AND status<>'manutencao'")
      const raw = result.rows[0] ?? {}
      const businessDays = countWeekdaysInMonth(Number(month.slice(0,4)), Number(month.slice(5,7)))
      const legacyDaily = Number(fallback.rows[0]?.meta_diaria_gmv ?? 0)
      const goals = {
        meta_gmv: Number(raw.meta_gmv) > 0 ? Number(raw.meta_gmv) : legacyDaily > 0 ? legacyDaily * businessDays : null,
        meta_horas_live: raw.meta_horas_live == null ? null : Number(raw.meta_horas_live),
        meta_gmv_hora: raw.meta_gmv_hora == null ? null : Number(raw.meta_gmv_hora),
      }
      const asNumber = rows => rows.map(row => Object.fromEntries(Object.entries(row).map(([k,v]) => [k, ['gmv','horas','horas_presenca'].includes(k) ? Number(v ?? 0) : v])))
      const canManage = ['franqueador_master','franqueado','gerente'].includes(request.user.papel)
      const payload = buildOperationalGoals({
        day, goals, config:raw.configuracao_operacional ?? null, presenters:presenters.rows, brands:brands.rows,
        lives:asNumber(lives.rows), credits:asNumber(credits.rows), videos:asNumber(videos.rows), pending:[...pending.rows,...pendingVideos.rows.map(v=>({...v,tipo:'video'}))],
      })
      payload.capacidade.cabines_ativas = Number(cabins.rows[0]?.total ?? 0)
      payload.pode_editar = canManage
      if (!canManage) {
        payload.editavel = false
        payload.configuracao = null
        for (const key of ['meta','esperado_agora','faltante','status']) payload.horas[key] = key==='status' ? 'sem_permissao' : null
        for (const key of ['meta_diaria','meta_mensal','esperado_agora','faltante_dia','esperado_mes','faltante_mes','necessario_dia','status']) payload.gmv[key] = key==='status' ? 'sem_permissao' : null
        for (const key of ['piso','necessario','potencial_mensal_piso','piso_sustenta_meta']) payload.produtividade[key] = null
        payload.capacidade.gmv_hora_operacao_necessario = null
        for (const entity of [...payload.apresentadoras,...payload.marcas]) {
          entity.meta_horas = null
          entity.piso = null
          entity.desvio = null
          entity.status = 'sem_permissao'
          entity.status_horas = entity.status_horas == null ? null : 'sem_permissao'
        }
      }
      return payload
    })
  })

  app.put('/v1/analytics/metas-operacionais', { preHandler: app.requirePapel(['franqueador_master','franqueado','gerente']) }, async (request, reply) => {
    const body = request.body ?? {}
    const overridesValid = rows => rows === undefined || (Array.isArray(rows) && rows.length <= 300 && rows.every(row => UUID_RE.test(row.id) && nullableMoney.safeParse(row.meta_gmv_hora).success))
    if (!MONTH_RE.test(body.ano_mes ?? '') || !money.safeParse(body.meta_gmv).success || !money.safeParse(body.meta_gmv_hora).success ||
        !configSchema.safeParse(body.configuracao).success || !overridesValid(body.pisos_apresentadoras ?? []) || !overridesValid(body.pisos_marcas ?? [])) {
      return reply.code(400).send({ error: 'Metas, competência, configuração e exceções inválidas.' })
    }
    if (!validateOperationalConfig(body.configuracao)) return reply.code(400).send({ error: 'Turnos inválidos ou sobrepostos.' })
    try { assertCurrentGoalMonth(body.ano_mes) } catch (error) { return reply.code(error.statusCode ?? 409).send({ error:error.message }) }
    const tenantId=request.user.tenant_id, userId=request.user.sub
    const people=body.pisos_apresentadoras, brands=body.pisos_marcas
    const saved=await app.withTenant(tenantId,async db=>{
      await db.query('BEGIN')
      try {
        const currentMonth=saoPauloDateInput(new Date()).slice(0,7)
        if(body.ano_mes!==currentMonth) throw Object.assign(new Error('Somente as metas do mês atual podem ser editadas.'),{statusCode:409})
        const previous=await db.query('SELECT configuracao_operacional FROM meta_unidade WHERE tenant_id=$1 AND ano_mes=$2 FOR UPDATE',[tenantId,body.ano_mes])
        const p=await db.query('SELECT id FROM apresentadoras WHERE tenant_id=$1 AND ativo=true AND arquivada=false',[tenantId])
        const b=await db.query("SELECT id FROM marcas WHERE tenant_id=$1 AND status='ativa'",[tenantId])
        const pSet=new Set(p.rows.map(r=>r.id)), bSet=new Set(b.rows.map(r=>r.id))
        if((people ?? []).some(r=>!pSet.has(r.id))||(brands ?? []).some(r=>!bSet.has(r.id))) throw Object.assign(new Error('Exceção aponta para cadastro inativo ou de outra unidade.'),{statusCode:400})
        const config={...body.configuracao,equipe_referencia:p.rows.map(r=>r.id),dias_consolidados:previous.rows[0]?.configuracao_operacional?.dias_consolidados ?? []}
        await db.query('INSERT INTO meta_unidade (tenant_id,ano_mes,meta_gmv,meta_horas_live,meta_gmv_hora,configuracao_operacional) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (tenant_id,ano_mes) DO UPDATE SET meta_gmv=EXCLUDED.meta_gmv,meta_horas_live=EXCLUDED.meta_horas_live,meta_gmv_hora=EXCLUDED.meta_gmv_hora,configuracao_operacional=EXCLUDED.configuracao_operacional,atualizado_em=NOW()',
          [tenantId,body.ano_mes,body.meta_gmv,body.configuracao.horas_por_apresentador*p.rows.length*countWeekdaysInMonth(Number(body.ano_mes.slice(0,4)),Number(body.ano_mes.slice(5,7))),body.meta_gmv_hora,JSON.stringify(config)])
        // Quando o grupo vem no payload, ele substitui integralmente as exceções do mês.
        if(brands !== undefined) await db.query('DELETE FROM marca_metas_hora WHERE tenant_id=$1 AND ano_mes=$2',[tenantId,body.ano_mes])
        if(people !== undefined) await db.query('UPDATE metas_apresentadora SET meta_gmv_hora=NULL,atualizado_em=NOW() WHERE tenant_id=$1 AND mes_referencia=$2::date AND meta_gmv_hora IS NOT NULL',[tenantId,body.ano_mes+'-01'])
        for(const row of brands ?? []) if(row.meta_gmv_hora !== null) await db.query('INSERT INTO marca_metas_hora (tenant_id,marca_id,ano_mes,meta_gmv_hora,criado_por) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,marca_id,ano_mes) DO UPDATE SET meta_gmv_hora=EXCLUDED.meta_gmv_hora,atualizado_em=NOW()',[tenantId,row.id,body.ano_mes,row.meta_gmv_hora,userId])
        for(const row of people ?? []) if(row.meta_gmv_hora !== null) await db.query('INSERT INTO metas_apresentadora (tenant_id,apresentadora_id,mes_referencia,meta_gmv_hora,criado_por) VALUES ($1,$2,$3::date,$4,$5) ON CONFLICT (tenant_id,apresentadora_id,mes_referencia) DO UPDATE SET meta_gmv_hora=EXCLUDED.meta_gmv_hora,atualizado_em=NOW()',[tenantId,row.id,body.ano_mes+'-01',row.meta_gmv_hora,userId])
        await db.query('COMMIT')
        return {ano_mes:body.ano_mes,equipe_referencia:p.rows.length}
      } catch(error) { await db.query('ROLLBACK'); throw error }
    })
    await app.audit.log(request,{action:'metas.analytics_operacional.update',entity_type:'tenant',entity_id:tenantId,metadata:{ano_mes:body.ano_mes,equipe_referencia:saved.equipe_referencia,excecoes_apresentadoras:(people ?? []).filter(r=>r.meta_gmv_hora!==null).length,excecoes_marcas:(brands ?? []).filter(r=>r.meta_gmv_hora!==null).length}})
    return {...saved,meta_gmv:body.meta_gmv,meta_gmv_hora:body.meta_gmv_hora,configuracao:body.configuracao}
  })

  app.post('/v1/analytics/operacao/consolidar-dia', { preHandler: app.requirePapel(['franqueador_master','franqueado','gerente']) }, async (request, reply) => {
    const { data } = request.body ?? {}
    if (typeof data !== 'string' || !DATE_RE.test(data) || new Date(data+'T12:00:00Z').toISOString().slice(0,10)!==data) return reply.code(400).send({error:'Informe uma data válida.'})
    const tenantId=request.user.tenant_id, month=data.slice(0,7), now=new Date()
    if (month!==saoPauloDateInput(now).slice(0,7) || data>saoPauloDateInput(now)) return reply.code(409).send({error:'Somente um dia já transcorrido do mês atual pode ser consolidado.'})
    const result=await app.withTenant(tenantId,async db=>{
      await db.query('BEGIN')
      try {
        const meta=await db.query('SELECT configuracao_operacional FROM meta_unidade WHERE tenant_id=$1 AND ano_mes=$2 FOR UPDATE',[tenantId,month])
        const config=meta.rows[0]?.configuracao_operacional
        if(!validateOperationalConfig(config)) throw Object.assign(new Error('Configure os turnos antes de consolidar o dia.'),{statusCode:409})
        if(!shiftProgress(config,data,now).encerrado) throw Object.assign(new Error('O período configurado de operação ainda não terminou.'),{statusCode:409})
        const pending=await db.query("SELECT COUNT(*)::int AS total FROM apresentadora_live_submissoes WHERE tenant_id=current_setting('app.tenant_id',true)::uuid AND status='pendente' AND iniciado_em >= ($1::timestamp AT TIME ZONE 'America/Sao_Paulo') AND iniciado_em < (($2::timestamp+INTERVAL '1 day') AT TIME ZONE 'America/Sao_Paulo')",[data,data])
        const pendingVideos=await db.query("SELECT COUNT(*)::int AS total FROM vendas_atribuidas WHERE tenant_id=current_setting('app.tenant_id',true)::uuid AND origem='video' AND COALESCE(status_aprovacao,'pendente_aprovacao')='pendente_aprovacao' AND data=$1::date",[data])
        const active=await db.query("SELECT COUNT(*)::int AS total FROM lives WHERE tenant_id=current_setting('app.tenant_id',true)::uuid AND uniao_destino_id IS NULL AND uniao_desfeita_em IS NULL AND arquivada_em IS NULL AND status='em_andamento' AND iniciado_em >= ($1::timestamp AT TIME ZONE 'America/Sao_Paulo') AND iniciado_em < (($2::timestamp+INTERVAL '1 day') AT TIME ZONE 'America/Sao_Paulo')",[data,data])
        const incomplete=await db.query("SELECT COUNT(*)::int AS total FROM lives WHERE tenant_id=current_setting('app.tenant_id',true)::uuid AND uniao_destino_id IS NULL AND uniao_desfeita_em IS NULL AND arquivada_em IS NULL AND status='encerrada' AND (encerrado_em IS NULL OR encerrado_em<=iniciado_em OR (ads_gmv IS NULL AND manual_gmv IS NULL AND fat_gerado IS NULL)) AND iniciado_em >= ($1::timestamp AT TIME ZONE 'America/Sao_Paulo') AND iniciado_em < (($2::timestamp+INTERVAL '1 day') AT TIME ZONE 'America/Sao_Paulo')",[data,data])
        const blockers=Number(pending.rows[0]?.total??0)+Number(pendingVideos.rows[0]?.total??0)+Number(active.rows[0]?.total??0)+Number(incomplete.rows[0]?.total??0)
        if(blockers) throw Object.assign(new Error('Há lives abertas, dados incompletos ou declarações pendentes. Revise antes de consolidar.'),{statusCode:409})
        const dates=Array.isArray(config.dias_consolidados)?config.dias_consolidados:[]
        const updated=[...new Set([...dates,data])].sort()
        const saved=await db.query("UPDATE meta_unidade SET configuracao_operacional=jsonb_set(configuracao_operacional,'{dias_consolidados}',$3::jsonb,true),atualizado_em=NOW() WHERE tenant_id=$1 AND ano_mes=$2 RETURNING configuracao_operacional",[tenantId,month,JSON.stringify(updated)])
        await db.query('COMMIT')
        return {data,estado:'consolidado',configuracao:saved.rows[0].configuracao_operacional}
      } catch(error) { await db.query('ROLLBACK'); throw error }
    })
    await app.audit.log(request,{action:'analytics.operacao.consolidar_dia',entity_type:'tenant',entity_id:tenantId,metadata:{data}})
    return result
  })
}
