import { countWeekdaysInMonth, countWeekdaysUpTo } from './dias_uteis.js'
import { saoPauloDateInput, saoPauloTimeInput, isWeekendInSaoPaulo } from './timezone.js'

export const roundGoal = (n) => Math.round(Number(n) * 100) / 100
export function assertCurrentGoalMonth(month, now = new Date()) {
  if (month !== saoPauloDateInput(now).slice(0, 7)) {
    throw Object.assign(new Error('Somente as metas do mês atual podem ser editadas.'), { statusCode: 409 })
  }
}
export const timeMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))

export function validateOperationalConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false
  if (!Number.isFinite(config.horas_por_apresentador) || config.horas_por_apresentador <= 0 || config.horas_por_apresentador > 24) return false
  if (!Number.isInteger(config.cabines_consideradas) || config.cabines_consideradas < 1 || config.cabines_consideradas > 100) return false
  if (!Array.isArray(config.turnos) || config.turnos.length < 1 || config.turnos.length > 8) return false
  let end = -1
  for (const shift of config.turnos) {
    if (!shift || !/^([01]\d|2[0-3]):[0-5]\d$/.test(shift.inicio) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(shift.fim)) return false
    const start = timeMinutes(shift.inicio), finish = timeMinutes(shift.fim)
    if (start < end || finish <= start) return false
    end = finish
  }
  return true
}

export function shiftProgress(config, day, now = new Date()) {
  if (!config || isWeekendInSaoPaulo(day)) return { fracao: 0, horas_operacao: 0, encerrado: false }
  const today = saoPauloDateInput(now)
  const minute = day < today ? 1440 : day > today ? 0 : timeMinutes(saoPauloTimeInput(now))
  const total = config.turnos.reduce((sum, s) => sum + timeMinutes(s.fim) - timeMinutes(s.inicio), 0)
  const elapsed = config.turnos.reduce((sum, s) => sum + Math.max(0, Math.min(minute, timeMinutes(s.fim)) - timeMinutes(s.inicio)), 0)
  return { fracao: total > 0 ? elapsed / total : 0, horas_operacao: total / 60, encerrado: minute >= timeMinutes(config.turnos.at(-1).fim) }
}

// Um dado ausente ou ainda sujeito a revisão nunca recebe alerta definitivo.
export function goalStatus(actual, target, { pending = false, started = true, closed = false } = {}) {
  if (pending) return 'dados_pendentes'
  if (!started) return 'nao_iniciado'
  if (target == null) return 'sem_meta'
  if (actual == null) return 'sem_dados'
  if (actual >= target) return 'dentro_da_meta'
  return closed ? 'abaixo_da_meta' : 'abaixo_do_ritmo'
}

export function buildOperationalGoals({ day, goals = {}, config = null, presenters = [], brands = [], lives = [], credits = [], videos = [], pending = [], now = new Date() }) {
  const month = day.slice(0, 7), [year, monthNumber] = month.split('-').map(Number)
  const days = countWeekdaysInMonth(year, monthNumber)
  const today = saoPauloDateInput(now)
  const future = day > today
  const usableConfig = validateOperationalConfig(config) ? config : null
  // Para meses antigos, não inferir a equipe a partir do cadastro atual.
  // A meta configurada captura a equipe do mês; mudanças cadastrais posteriores
  // não devem alterar retroativamente a capacidade diária já definida.
  const roster = usableConfig?.equipe_referencia?.length ? usableConfig.equipe_referencia : presenters.filter(p => p.ativo).map(p => p.id)
  const activeCount = roster.length
  const hoursTarget = usableConfig ? activeCount * usableConfig.horas_por_apresentador : null
  const monthlyGmv = Number(goals.meta_gmv) > 0 ? Number(goals.meta_gmv) : null
  const dailyGmv = monthlyGmv == null ? null : monthlyGmv / days
  const progress = shiftProgress(usableConfig, day, now)
  const weekday = !isWeekendInSaoPaulo(day)
  const monthRows = lives.filter(l => l.dia <= day)
  const dayRows = monthRows.filter(l => l.dia === day)
  const countedRows = dayRows.filter(l => l.status === 'encerrada' || l.status === 'em_andamento')
  const dayPending = pending.filter(p => p.dia === day)
  // Lives abertas fazem parte do ritmo intradiário; viram pendência após o fim dos turnos.
  const unsettled = dayPending.length > 0 || dayRows.some(l => (l.status !== 'encerrada' && progress.encerrado) || (l.status === 'encerrada' && (l.tempo_incompleto || l.gmv_incompleto)))
  const closed = Array.isArray(usableConfig?.dias_consolidados) && usableConfig.dias_consolidados.includes(day)
  const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] ?? 0), 0)
  const liveGmv = sum(countedRows, 'gmv'), cabinHours = sum(countedRows, 'horas')
  const countedIds = new Set(countedRows.map(l => l.id))
  const dayCredits = credits.filter(c => countedIds.has(c.live_id))
  const peopleHours = sum(dayCredits, 'horas_presenca')
  const approvedVideos = videos.filter(v => ['aprovada','fechada','faturada'].includes(v.status_aprovacao))
  const videoGmv = sum(approvedVideos.filter(v => v.dia === day), 'gmv')
  const dailyTotal = liveGmv + videoGmv
  const passed = countWeekdaysUpTo(year, monthNumber, Number(day.slice(-2)))
  const before = passed - (weekday ? 1 : 0)
  const elapsed = Math.min(days, before + (weekday ? progress.fracao : 0))
  const remainingDays = Math.max(0, days - elapsed)
  const monthGmv = sum(monthRows.filter(l => l.status === 'encerrada' || l.status === 'em_andamento'), 'gmv') + sum(approvedVideos.filter(v => v.dia <= day), 'gmv')
  const floor = goals.meta_gmv_hora == null ? null : Number(goals.meta_gmv_hora)
  const warningOptions = { pending: unsettled || !usableConfig, started: !future && weekday && progress.fracao > 0, closed }
  const detailLive = (l, c) => ({ id: l.id, dia: l.dia, marca_id: l.marca_id, marca_nome: l.marca_nome, cabine_nome: l.cabine_nome, status: l.status, gmv: Number(c?.gmv ?? l.gmv), horas: Number(c?.horas_presenca ?? l.horas), tempo_incompleto: Boolean(l.tempo_incompleto) })
  function entity(entity, kind) {
    const rows = kind === 'apresentadora' ? dayCredits.filter(c => c.apresentadora_id === entity.id) : countedRows.filter(l => l.marca_id === entity.id)
    const hours = sum(rows, kind === 'apresentadora' ? 'horas_presenca' : 'horas')
    const gmv = sum(rows, 'gmv')
    const specific = entity.meta_gmv_hora == null ? null : Number(entity.meta_gmv_hora)
    const target = specific ?? floor
    const rate = hours > 0 ? gmv / hours : null
    const entityPending = dayPending.some(p => p[`${kind}_id`] === entity.id) || dayRows.some(l => (kind === 'marca' ? l.marca_id === entity.id : credits.some(c => c.live_id === l.id && c.apresentadora_id === entity.id)) && ((l.status !== 'encerrada' && progress.encerrado) || (l.status === 'encerrada' && (l.tempo_incompleto || l.gmv_incompleto))))
    const ownCredits = credits.filter(c => c.apresentadora_id === entity.id)
    const ownLiveIds = new Set(ownCredits.map(c => c.live_id))
    const allRows = monthRows.filter(l => kind === 'marca' ? l.marca_id === entity.id : ownLiveIds.has(l.id))
    return { id: entity.id, nome: entity.nome, horas: roundGoal(hours), gmv: roundGoal(gmv), gmv_hora: rate == null ? null : roundGoal(rate), meta_horas: kind === 'apresentadora' && entity.ativo && weekday ? usableConfig?.horas_por_apresentador ?? null : null,
      piso: target, piso_origem: specific == null ? 'unidade' : 'especifico', desvio: rate == null || target == null ? null : roundGoal(rate - target),
      status: goalStatus(rate, target, { pending: entityPending || !usableConfig, started: !future && weekday && progress.fracao > 0, closed }),
      status_horas: kind === 'apresentadora' ? goalStatus(hours, entity.ativo && usableConfig && weekday ? usableConfig.horas_por_apresentador * progress.fracao : null, { ...warningOptions, pending: entityPending || !usableConfig || hours === 0 }) : null,
      lives: allRows.map(l => detailLive(l, kind === 'apresentadora' ? ownCredits.find(c => c.live_id === l.id) : null)) }
  }
  const attentionSort = (a,b) => (a.desvio ?? Infinity) - (b.desvio ?? Infinity) || a.nome.localeCompare(b.nome)
  const presenterEntities = presenters.filter(p => p.ativo || credits.some(c => c.apresentadora_id === p.id)).map(p => entity(p, 'apresentadora')).sort(attentionSort)
  const brandEntities = brands.filter(b => b.status === 'ativa' || monthRows.some(l => l.marca_id === b.id)).map(b => entity(b, 'marca')).sort(attentionSort)
  let accumulated = 0
  const series = Array.from({ length: Number(day.slice(-2)) }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2,'0')}`
    accumulated += sum(lives.filter(l => l.dia === date && (l.status === 'encerrada' || l.status === 'em_andamento')), 'gmv') + sum(approvedVideos.filter(v => v.dia === date), 'gmv')
    const expectedDays = countWeekdaysUpTo(year, monthNumber, i + 1)
    return { dia: date, realizado: roundGoal(accumulated), esperado: dailyGmv == null ? null : roundGoal(dailyGmv * expectedDays) }
  })
  return { data: day, ano_mes: month, editavel: month === today.slice(0,7), configurado: Boolean(usableConfig), configuracao: usableConfig, equipe_ativa: activeCount, dias_uteis: days,
    estado: future ? 'nao_iniciado' : !weekday ? 'nao_util' : unsettled ? 'dados_pendentes' : closed ? 'consolidado' : 'em_andamento',
    pendencias: { submissoes: dayPending.filter(p=>p.tipo !== 'video').length, videos: dayPending.filter(p=>p.tipo === 'video').length, lives_abertas: dayRows.filter(l=>l.status !== 'encerrada').length, tempos_incompletos: dayRows.filter(l=>l.tempo_incompleto).length },
    horas: { realizado: roundGoal(peopleHours), meta: hoursTarget == null || !weekday ? null : roundGoal(hoursTarget), esperado_agora: hoursTarget == null || !weekday ? null : roundGoal(hoursTarget * progress.fracao), faltante: hoursTarget == null || !weekday ? null : roundGoal(Math.max(0,hoursTarget-peopleHours)), status: goalStatus(peopleHours, weekday && hoursTarget != null ? hoursTarget * progress.fracao : null, warningOptions) },
    gmv: { realizado: roundGoal(dailyTotal), lives: roundGoal(liveGmv), videos: roundGoal(videoGmv), meta_diaria: weekday ? dailyGmv == null ? null : roundGoal(dailyGmv) : null, meta_mensal: monthlyGmv, esperado_agora: weekday && dailyGmv != null ? roundGoal(dailyGmv * progress.fracao) : null, faltante_dia: weekday && dailyGmv != null ? roundGoal(Math.max(0,dailyGmv-dailyTotal)) : null, realizado_mes: roundGoal(monthGmv), esperado_mes: dailyGmv == null ? null : roundGoal(dailyGmv*elapsed), faltante_mes: monthlyGmv == null ? null : roundGoal(Math.max(0,monthlyGmv-monthGmv)), necessario_dia: monthlyGmv != null && remainingDays > 0 ? roundGoal(Math.max(0,monthlyGmv-monthGmv)/remainingDays) : null, dias_restantes_equivalentes: roundGoal(remainingDays), status: goalStatus(dailyTotal, weekday && dailyGmv != null ? dailyGmv * progress.fracao : null, warningOptions) },
    produtividade: { realizado: peopleHours > 0 ? roundGoal(liveGmv/peopleHours) : null, piso: floor, necessario: dailyGmv != null && hoursTarget > 0 ? roundGoal(dailyGmv/hoursTarget) : null, potencial_mensal_piso: floor != null && hoursTarget != null ? roundGoal(floor*hoursTarget*days) : null, piso_sustenta_meta: monthlyGmv != null && floor != null && hoursTarget != null ? floor*hoursTarget*days >= monthlyGmv : null },
    capacidade: { horas_apresentadores: hoursTarget == null ? null : roundGoal(hoursTarget), horas_operacao: roundGoal(progress.horas_operacao), horas_cabines: usableConfig ? roundGoal(usableConfig.cabines_consideradas*progress.horas_operacao) : null, horas_cabines_realizadas: roundGoal(cabinHours), gmv_hora_operacao_necessario: dailyGmv != null && progress.horas_operacao > 0 ? roundGoal(dailyGmv/progress.horas_operacao) : null },
    serie: series, apresentadoras: presenterEntities, marcas: brandEntities }
}

// Interval results deliberately have no inferred target or negative classification.
// Monthly goals remain an unfiltered context with their own competence and cutoff.
export function buildOperationalRange({ from, to, marcaId = null, apresentadoraId = null, goals = {}, config = null, competencies = [], presenters = [], brands = [], lives = [], credits = [], videos = [], pending = [], canManage = false, now = new Date() }) {
  const inRange = row => row.dia >= from && row.dia <= to
  const matches = row => (!marcaId || row.marca_id === marcaId) && (!apresentadoraId || row.apresentadora_id === apresentadoraId)
  const finite = value => value != null && Number.isFinite(Number(value))
  const sum = (rows, key) => rows.some(row => !finite(row[key])) ? null : rows.reduce((n, row) => n + Number(row[key]), 0)
  const round = value => value == null ? null : roundGoal(value)
  const add = (a,b) => a == null || b == null ? null : a+b
  const liveById = new Map(lives.filter(l => inRange(l) && ['encerrada','em_andamento'].includes(l.status) && (!marcaId || l.marca_id === marcaId)).map(l => [l.id,l]))
  const selectedCredits = credits.filter(c => liveById.has(c.live_id) && (!apresentadoraId || c.apresentadora_id === apresentadoraId))
  const creditedIds = new Set(selectedCredits.map(c => c.live_id))
  const selectedLives = [...liveById.values()].filter(l => !apresentadoraId || creditedIds.has(l.id))
  const approved = videos.filter(v => inRange(v) && matches(v) && ['aprovada','fechada','faturada'].includes(v.status_aprovacao))
  const selectedPending = pending.filter(p => inRange(p) && matches(p))
  const pendingFlags = rows => ({gmv:rows.length > 0,horas:rows.some(p=>p.tipo!=='video')})
  const detail = (l,c,ownPending) => ({ id:l.id,dia:l.dia,marca_id:l.marca_id,marca_nome:l.marca_nome,cabine_nome:l.cabine_nome,status:l.status,
    gmv:l.gmv_incompleto ? null : finite(c ? c.gmv : l.gmv) ? round(c ? c.gmv : l.gmv) : null,
    horas:l.tempo_incompleto ? null : finite(c ? c.horas_presenca : l.horas) ? round(c ? c.horas_presenca : l.horas) : null,
    tempo_incompleto:Boolean(l.tempo_incompleto),gmv_incompleto:Boolean(l.gmv_incompleto),
    dados_incompletos:{
      gmv:Boolean(l.gmv_incompleto) || !finite(c ? c.gmv : l.gmv) || l.status==='em_andamento' || ownPending.some(p=>p.live_oficial_id===l.id),
      horas:Boolean(l.tempo_incompleto) || !finite(c ? c.horas_presenca : l.horas) || l.status==='em_andamento' || ownPending.some(p=>p.tipo!=='video' && p.live_oficial_id===l.id),
    } })
  function totals(rows, ownCredits, ownVideos, ownPending) {
    const pendingData = pendingFlags(ownPending)
    const active = rows.some(l=>l.status==='em_andamento')
    const missingGmv = rows.some(l => l.gmv_incompleto)
    const missingHours = rows.length === 0 || rows.some(l => l.tempo_incompleto || !ownCredits.some(c => c.live_id === l.id))
    const liveGmv = missingGmv ? null : sum(apresentadoraId ? ownCredits : rows,'gmv')
    const videoGmv = sum(ownVideos,'gmv')
    const hours = missingHours ? null : sum(ownCredits,'horas_presenca')
    const cabin = rows.some(l => l.tempo_incompleto) ? null : sum(rows,'horas')
    return { gmv:round(add(liveGmv,videoGmv)),gmv_lives:round(liveGmv),gmv_videos:round(videoGmv),horas_apresentadoras:round(hours),horas_cabines:round(cabin),
      gmv_hora:liveGmv != null && hours > 0 ? round(liveGmv/hours) : null,lives:rows.length,status:'indisponivel',
      dados_incompletos:{gmv:liveGmv == null || videoGmv == null || pendingData.gmv || active,horas:hours == null || cabin == null || pendingData.horas || active},
    }
  }
  const resumo = totals(selectedLives,selectedCredits,approved,selectedPending)
  const entities = (catalog,kind) => catalog.filter(entity => kind === 'apresentadora' ? (!apresentadoraId || entity.id === apresentadoraId) && (entity.ativo || selectedCredits.some(c=>c.apresentadora_id===entity.id)) : (!marcaId || entity.id === marcaId) && (entity.status === 'ativa' || selectedLives.some(l=>l.marca_id===entity.id))).map(entity => {
    const ownCredits = selectedCredits.filter(c => kind === 'apresentadora' ? c.apresentadora_id === entity.id : liveById.get(c.live_id)?.marca_id === entity.id)
    const ownIds = new Set(ownCredits.map(c=>c.live_id))
    const rows = selectedLives.filter(l => kind === 'apresentadora' ? ownIds.has(l.id) : l.marca_id === entity.id)
    const ownPending = selectedPending.filter(p=>p[`${kind}_id`]===entity.id)
    const pendingData = pendingFlags(ownPending)
    const useCredits = kind === 'apresentadora' || Boolean(apresentadoraId)
    const gmv = rows.some(l=>l.gmv_incompleto) ? null : sum(useCredits ? ownCredits : rows,'gmv')
    const hours = rows.length === 0 || rows.some(l=>l.tempo_incompleto) || (useCredits && rows.some(l => !ownCredits.some(c => c.live_id === l.id))) ? null : sum(useCredits ? ownCredits : rows,useCredits ? 'horas_presenca' : 'horas')
    return { id:entity.id,nome:entity.nome,gmv:round(gmv),horas:round(hours),gmv_hora:gmv != null && hours > 0 ? round(gmv/hours) : null,status:'indisponivel',
      dados_incompletos:{gmv:gmv == null || pendingData.gmv || rows.some(l=>l.status==='em_andamento'),horas:hours == null || pendingData.horas || rows.some(l=>l.status==='em_andamento')},
      lives:rows.map(l=>detail(l,useCredits ? ownCredits.find(c=>c.live_id===l.id) : null,ownPending)) }
  })
  const dates = []
  for (let date = new Date(from+'T12:00:00Z'); date.toISOString().slice(0,10) <= to; date.setUTCDate(date.getUTCDate()+1)) dates.push(date.toISOString().slice(0,10))
  const serie = dates.map(dia => {
    const rows = selectedLives.filter(l=>l.dia===dia), ids = new Set(rows.map(l=>l.id))
    return {dia,...totals(rows,selectedCredits.filter(c=>ids.has(c.live_id)),approved.filter(v=>v.dia===dia),selectedPending.filter(p=>p.dia===dia))}
  })
  const month = to.slice(0,7), monthLives = lives.filter(l=>l.dia?.slice(0,7)===month && l.dia<=to), monthIds = new Set(monthLives.map(l=>l.id))
  const context = buildOperationalGoals({day:to,goals,config,presenters,brands,lives:monthLives,credits:credits.filter(c=>monthIds.has(c.live_id)),videos:videos.filter(v=>v.dia?.slice(0,7)===month && v.dia<=to),pending:pending.filter(p=>p.dia?.slice(0,7)===month && p.dia<=to),now})
  context.pode_editar = canManage
  if (!canManage) {
    context.editavel=false
    context.configuracao=null
    for (const key of ['meta','esperado_agora','faltante','status']) context.horas[key]=key==='status'?'sem_permissao':null
    for (const key of ['meta_diaria','meta_mensal','esperado_agora','faltante_dia','esperado_mes','faltante_mes','necessario_dia','status']) context.gmv[key]=key==='status'?'sem_permissao':null
    for (const key of ['piso','necessario','potencial_mensal_piso','piso_sustenta_meta']) context.produtividade[key]=null
    context.capacidade.gmv_hora_operacao_necessario=null
    for (const entity of [...context.apresentadoras,...context.marcas]) {
      entity.meta_horas=null; entity.piso=null; entity.desvio=null; entity.status='sem_permissao'
      entity.status_horas=entity.status_horas == null ? null : 'sem_permissao'
    }
  }
  const months = [...new Set(dates.map(d=>d.slice(0,7)))].map(ano_mes=>({ ano_mes,from:dates.find(d=>d.startsWith(ano_mes)),to:dates.findLast(d=>d.startsWith(ano_mes)),configurado:validateOperationalConfig(competencies.find(c=>c.ano_mes===ano_mes)?.configuracao_operacional) }))
  return {tipo:'intervalo',from,to,filtros:{marca_id:marcaId,apresentadora_id:apresentadoraId},resumo,
    pendencias:{submissoes:selectedPending.filter(p=>p.tipo!=='video').length,videos:selectedPending.filter(p=>p.tipo==='video').length,lives_abertas:selectedLives.filter(l=>l.status==='em_andamento').length,tempos_incompletos:selectedLives.filter(l=>l.tempo_incompleto).length,gmv_incompletos:selectedLives.filter(l=>l.gmv_incompleto).length},
    serie,apresentadoras:entities(presenters,'apresentadora'),marcas:entities(brands,'marca'),competencias:months,
    contexto_mensal:{ano_mes:month,corte:to,escopo:'unidade',dados:context},pode_editar:canManage,editavel:false,consolidavel:false,
  }
}
