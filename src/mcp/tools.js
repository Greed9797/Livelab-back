import { previstoEfetivo } from '../services/financeiro-agregador.js'
import { z } from 'zod'
import { aggregateFacts, evolution, compareMetrics, loadFacts } from '../services/mcp-indicadores.js'
import { authorizeMcpUser } from './oauth.js'
import { READ_CABINES, READ_MARCAS, READ_APRESENTADORAS, READ_COMISSOES } from '../config/role_groups.js'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(`${v}T00:00:00Z`)
  return Number(v.slice(0, 4)) >= 100 && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}, 'Data inexistente')
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).refine(v => Number(v.slice(0, 4)) >= 100, 'Ano deve ter pelo menos três algarismos')
const periodFields = { inicio: date, fim: date, marca_id: z.string().uuid().optional(), cabine_id: z.string().uuid().optional(),
  apresentadora_id: z.string().uuid().optional(), origem: z.enum(['live', 'video', 'ambos']).default('ambos'),
  status: z.enum(['encerrada', 'em_andamento']).default('encerrada') }
const validRange = v => v.fim >= v.inicio && Date.parse(v.fim) - Date.parse(v.inicio) <= 365 * 86400000
export const periodSchema = z.object(periodFields).strict().refine(validRange, 'Período invertido ou maior que 366 dias')
const monthFields = { inicio: month, fim: month }
const financialSchema = z.object(monthFields).strict().refine(v => v.fim >= v.inicio &&
  (Number(v.fim.slice(0, 4)) - Number(v.inicio.slice(0, 4))) * 12 + Number(v.fim.slice(5)) - Number(v.inicio.slice(5)) <= 11, 'Use até 12 meses consecutivos')
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const definition = (name, domain, description, schema) => ({ name, domain, description, schema, annotations })
export const toolDefinitions = [
  definition('buscar_entidades', 'analytics', 'Localiza nomes e IDs sem resolver ambiguidades automaticamente; dados operacionais, sem contatos ou remuneração.', z.object({ tipo: z.enum(['apresentadora', 'marca', 'cabine']), nome: z.string().trim().min(1).max(100), limite: z.number().int().min(1).max(50).default(20) }).strict()),
  definition('consultar_resumo', 'analytics', 'GMV, pedidos, lives, vídeos e horas. GMV não é receita da unidade nem dinheiro recebido.', periodSchema),
  definition('consultar_evolucao', 'analytics', 'Série diária/mensal com acumulado iniciado na data solicitada, incluindo dias sem atividade.', z.object({ ...periodFields, granularidade: z.enum(['dia', 'mes']).default('dia') }).strict().refine(validRange)),
  definition('consultar_apresentadores', 'analytics', 'GMV atribuído e horas de presença/produtividade por pessoa, incluindo venda zero. Não contém salários ou comissões.', periodSchema),
  definition('consultar_marcas', 'analytics', 'Desempenho por marca, participação no GMV, pedidos, lives e horas; sem receitas contratuais.', periodSchema),
  definition('consultar_cabines', 'analytics', 'GMV e horas por cabine; vídeos não são atribuídos a cabines.', z.object({ ...periodFields, origem: z.literal('live').default('live') }).strict().refine(validRange)),
  definition('consultar_metas', 'analytics', 'Meta da unidade ou apresentadores e realizado na régua vigente; ausência de meta não significa meta zero.', z.object({ mes: month, tipo: z.enum(['unidade', 'apresentadora']), apresentadora_id: z.string().uuid().optional() }).strict()),
  definition('comparar_periodos', 'analytics', 'Compara dois períodos explícitos. Indicadores financeiros exigem consentimento financeiro adicional e meses inteiros.', z.object({ atual: periodSchema, anterior: periodSchema, financeiro: z.boolean().default(false) }).strict()),
  definition('consultar_lives', 'analytics', 'Lista paginada de transmissões que compõem os resultados; parciais são identificados.', z.object({ ...periodFields, origem: z.literal('live').default('live'), pagina: z.number().int().min(0).max(999).default(0), limite: z.number().int().min(1).max(100).default(30) }).strict().refine(validRange)),
  definition('detalhar_live', 'analytics', 'Detalha transmissão e rateio individual, sem dados financeiros privados.', z.object({ live_id: z.string().uuid() }).strict()),
  definition('consultar_funil_audiencia', 'analytics', 'Audiência e conversões das lives encerradas; inclui cobertura e indisponibilidade da fonte.', periodSchema),
  definition('consultar_resultado_operacional', 'finance', 'Receita calculada, custos fixos/variáveis e resultado operacional, inclusive prejuízo. Não é saldo bancário.', financialSchema),
  definition('consultar_receitas_marcas', 'finance', 'Receita calculada por marca, fixo/comissão e critério contratual fixo+comissão ou maior entre ambos.', financialSchema),
  definition('consultar_custos', 'finance', 'Custos registrados por competência, categoria e descrição, com totais; não comprova pagamento.', z.object({ ...monthFields, categoria: z.string().max(80).optional(), pagina: z.number().int().min(0).max(999).default(0), limite: z.number().int().min(1).max(100).default(30) }).strict().refine(v => financialSchema.safeParse({ inicio: v.inicio, fim: v.fim }).success)),
  definition('consultar_comissoes', 'finance', 'Comissões calculadas de apresentadores, franquia e franqueadora, separadas por régua. Não confirma pagamento.', periodSchema),
  definition('consultar_fechamento_apresentadores', 'finance', 'Fechamento mensal com fixo, comissão, adicionais e total; permite filtrar uma pessoa.', z.object({ mes: month, apresentadora_id: z.string().uuid().optional() }).strict()),
  definition('consultar_memoria_financeira', 'finance', 'Memória de entradas/saídas operacionais ou fechamento mensal individual, incluindo registros e faixas disponíveis.', z.object({ mes: month, tipo: z.enum(['operacional', 'apresentadora']), apresentadora_id: z.string().uuid().optional() }).strict().refine(v => v.tipo !== 'apresentadora' || Boolean(v.apresentadora_id), 'Informe apresentadora_id')),
]

export function canUseTool(identity, def) {
  if (!authorizeMcpUser(identity.user, identity.scope, def.domain, identity.tokenVersion)) return false
  const roles = def.name === 'consultar_metas' ? ['franqueado', 'gerente']
    : ['consultar_lives', 'detalhar_live'].includes(def.name) ? READ_CABINES
      : def.name === 'consultar_comissoes' ? READ_COMISSOES : null
  return !roles || roles.includes(identity.user.papel)
}

const pick = (obj, keys) => Object.fromEntries(keys.filter(k => obj?.[k] !== undefined).map(k => [k, obj[k]]))
const page = (rows, args) => ({ items: rows.slice((args.pagina || 0) * (args.limite || 30), ((args.pagina || 0) + 1) * (args.limite || 30)),
  total: rows.length, pagina: args.pagina || 0, limite: args.limite || 30 })
const monthRange = mes => ({ inicio: `${mes}-01`, fim: new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5)), 0)).toISOString().slice(0, 10) })
const financialNote = 'Valores calculados/registrados por competência; pagamento, recebimento e saldo bancário não são comprovados por esta consulta.'

// Dispatch in-process (nenhuma chamada de rede): conserva validação, guards e cálculos
// das rotas existentes sem extrair milhares de linhas nem criar uma segunda fórmula financeira.
export async function sharedRead(app, user, pathname, params = {}) {
  const allowed = /^\/v1\/(financeiro\/(operacional|custos|fechamento-apresentadoras(?:\/[a-f0-9-]{36}\/detalhes)?)|comissoes\/resumo|analytics\/funil|metas\/apresentadoras|meta-unidade)$/
  if (!allowed.test(pathname)) throw new Error('Serviço de leitura não permitido')
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null))
  const response = await app.inject({ method: 'GET', url: `${pathname}?${query}`, headers: {
    authorization: `Bearer ${app.jwt.sign({ sub: user.id, tenant_id: user.tenant_id, papel: user.papel, token_version: user.token_version ?? 1 }, { expiresIn: '30s' })}`,
  } })
  if (response.statusCode !== 200) throw Object.assign(new Error(response.statusCode === 403 ? 'Seu papel não permite esta consulta' : 'Não foi possível consultar a fonte'), { statusCode: response.statusCode })
  if (Buffer.byteLength(response.payload) > 2_000_000) throw Object.assign(new Error('Fonte retornou mais de 2 MB; reduza o período'), { statusCode: 422 })
  return response.json()
}

async function operational(app, user, args) {
  return sharedRead(app, user, '/v1/financeiro/operacional', { inicio: args.inicio, fim: args.fim })
}
function assertNoFilters(args, allowed) {
  const unsupported = ['marca_id', 'cabine_id', 'apresentadora_id'].filter(key => args[key] && !allowed.includes(key))
  if (unsupported.length || (args.origem && args.origem !== 'ambos') || (args.status && args.status !== 'encerrada')) {
    throw Object.assign(new Error('Esta fonte não suporta os filtros solicitados; remova-os para evitar uma resposta de outra régua'), { statusCode: 400 })
  }
}

export async function executeTool(app, identity, name, rawArgs) {
  const def = toolDefinitions.find(t => t.name === name)
  if (!def) throw Object.assign(new Error('Ferramenta não encontrada'), { statusCode: 404 })
  if (!canUseTool(identity, def)) throw Object.assign(new Error('Escopo ou papel não autorizado'), { statusCode: 403 })
  const parsed = def.schema.safeParse(rawArgs)
  if (!parsed.success) throw Object.assign(new Error(parsed.error.issues.map(i => i.message).join('; ')), { statusCode: 400 })
  const args = parsed.data, user = identity.user
  const avisos = def.domain === 'finance' ? [financialNote] : []
  let dados, resolvedPeriod, origem = 'lives + vendas_atribuidas; expressões metric-sql'
  if (name === 'buscar_entidades') {
    if (!({ apresentadora: READ_APRESENTADORAS, marca: READ_MARCAS, cabine: READ_CABINES }[args.tipo]).includes(user.papel)) throw Object.assign(new Error('Seu papel não permite consultar estas entidades'), { statusCode: 403 })
    const table = { apresentadora: 'apresentadoras', marca: 'marcas', cabine: 'cabines' }[args.tipo]
    const column = args.tipo === 'cabine' ? 'numero::text' : 'nome'
    const rows = await app.withTenant(user.tenant_id, db => db.query(`SELECT id, ${column} AS nome FROM ${table}
      WHERE tenant_id = $1::uuid AND ${column} ILIKE $2 ESCAPE '\\' ORDER BY ${column} LIMIT $3`,
    [user.tenant_id, `%${args.nome.replace(/[\\%_]/g, '\\$&')}%`, args.limite + 1]))
    dados = { candidatos: rows.rows.slice(0, args.limite), ambiguo: rows.rows.length > 1, mais_resultados: rows.rows.length > args.limite }
    origem = table
  } else if (name === 'consultar_metas') {
    if (args.tipo === 'apresentadora') {
      const rows = await sharedRead(app, user, '/v1/metas/apresentadoras', { mes: args.mes })
      dados = rows.filter(r => !args.apresentadora_id || r.id === args.apresentadora_id || r.apresentadora_id === args.apresentadora_id).map(r => ({ ...r,
        percentual_atingido: Number(r.meta_gmv) > 0 ? Number(r.gmv_realizado) / Number(r.meta_gmv) * 100 : null,
        diferenca_para_meta: Number(r.meta_gmv) > 0 ? Number(r.meta_gmv) - Number(r.gmv_realizado) : null }))
      avisos.push('Realizado segue a régua vigente de metas/vendas_atribuidas; não equivale automaticamente ao ranking de desempenho. Meta zero no endpoint pode representar ausência de cadastro.')
    } else {
      if (args.apresentadora_id) throw Object.assign(new Error('Meta da unidade não aceita filtro de apresentador'), { statusCode: 400 })
      const meta = await sharedRead(app, user, '/v1/meta-unidade', { ano_mes: args.mes })
      const resumo = aggregateFacts(await loadFacts(app, user, monthRange(args.mes)))
      dados = { meta, realizado: resumo, indicadores: Object.fromEntries([['gmv', meta.meta_gmv, resumo.gmv_total], ['horas', meta.meta_horas_live, resumo.horas_transmissao], ['gmv_hora', meta.meta_gmv_hora, resumo.gmv_por_hora]].map(([key, value, actual]) => [key,
        { meta: value ?? null, realizado: actual, percentual_atingido: value > 0 && actual !== null ? actual / value * 100 : null, diferenca_para_meta: value > 0 && actual !== null ? value - actual : null }])) }
    }
    origem = 'metas existentes + indicadores; granularidade mensal'
  } else if (name === 'consultar_resultado_operacional' || name === 'consultar_receitas_marcas') {
    const result = await operational(app, user, args)
    dados = result
    if (name === 'consultar_receitas_marcas') {
      const groups = new Map()
      for (const line of result.entradas || []) {
        const id = line.memoria?.marca_id
        if (!groups.has(id)) groups.set(id, { marca_id: id, marca_nome: line.memoria?.marca_nome, receita_calculada: 0, componentes: [] })
        const row = groups.get(id)
        row.receita_calculada = Math.round((row.receita_calculada + Number(line.valor)) * 100) / 100
        row.componentes.push(line)
      }
      dados = { marcas: [...groups.values()], totais: result.totais, pendencias: result.pendencias }
    }
    origem = 'financeiro/operacional; componentes contratuais já calculados'
  } else if (name === 'consultar_custos') {
    const rows = await sharedRead(app, user, '/v1/financeiro/custos', pick(args, ['inicio', 'fim']))
    const filtered = rows.filter(r => !args.categoria || r.tipo === args.categoria)
    const costCents = r => Math.round(previstoEfetivo(r) * 100)
    dados = { ...page(filtered, args), total_custos: Math.round(filtered.reduce((s, r) => s + costCents(r), 0)) / 100,
      total_previsto_registrado: filtered.reduce((s, r) => s + Math.round(Number(r.valor_previsto || 0) * 100), 0) / 100,
      total_pago_registrado: filtered.reduce((s, r) => s + Math.round(Number(r.valor_pago || 0) * 100), 0) / 100,
      por_categoria: Object.fromEntries([...new Set(filtered.map(r => r.tipo))].map(tipo => [tipo, filtered.filter(r => r.tipo === tipo).reduce((s, r) => s + costCents(r), 0) / 100])) }
    origem = 'custos; competência registrada'
  } else if (name === 'consultar_comissoes') {
    assertNoFilters({ ...args, origem: 'ambos' }, ['marca_id', 'apresentadora_id'])
    dados = await sharedRead(app, user, '/v1/comissoes/resumo', { data_inicio: args.inicio, data_fim: args.fim, ...pick(args, ['marca_id', 'apresentadora_id']), origem: args.origem === 'ambos' ? undefined : args.origem })
    origem = 'comissoes/resumo; régua vigente do ranking, com fixos quando aplicáveis'
  } else if (name === 'consultar_fechamento_apresentadores') {
    const result = await sharedRead(app, user, '/v1/financeiro/fechamento-apresentadoras', { mes: args.mes })
    const rows = result.apresentadoras.filter(r => !args.apresentadora_id || r.apresentadora_id === args.apresentadora_id)
    dados = { mes: args.mes, apresentadoras: rows, totais: Object.fromEntries(['fixo', 'comissao', 'adicionais', 'total'].map(key => [key, rows.reduce((s, r) => s + Math.round(Number(r[key]) * 100), 0) / 100])) }
    origem = 'remuneracao-apresentadoras; fechamento mensal'
  } else if (name === 'consultar_memoria_financeira') {
    dados = args.tipo === 'operacional' ? await operational(app, user, { inicio: args.mes, fim: args.mes })
      : await sharedRead(app, user, `/v1/financeiro/fechamento-apresentadoras/${args.apresentadora_id}/detalhes`, { mes: args.mes })
    origem = 'financeiro/operacional ou fechamento individual; memória vigente'
  } else if (name === 'comparar_periodos') {
    if (args.financeiro && !authorizeMcpUser(user, identity.scope, 'finance', identity.tokenVersion)) throw Object.assign(new Error('Comparação financeira requer livelab:finance:read e papel financeiro'), { statusCode: 403 })
    const atual = aggregateFacts(await loadFacts(app, user, args.atual), null, args.atual.apresentadora_id)
    const anterior = aggregateFacts(await loadFacts(app, user, args.anterior), null, args.anterior.apresentadora_id)
    dados = { desempenho: compareMetrics(atual, anterior), cobertura: { atual: atual.cobertura, anterior: anterior.cobertura } }
    if (atual.gmv_total === null || anterior.gmv_total === null) avisos.push('GMV incompleto: não há comparação percentual do total indisponível; apenas subtotais conhecidos.')
    if (args.financeiro) {
      for (const p of [args.atual, args.anterior]) {
        assertNoFilters(p, [])
        const end = monthRange(p.fim.slice(0, 7)).fim
        if (!p.inicio.endsWith('-01') || p.fim !== end) throw Object.assign(new Error('Financeiro exige períodos de meses completos'), { statusCode: 400 })
      }
      const a = await operational(app, user, { inicio: args.atual.inicio.slice(0, 7), fim: args.atual.fim.slice(0, 7) })
      const b = await operational(app, user, { inicio: args.anterior.inicio.slice(0, 7), fim: args.anterior.fim.slice(0, 7) })
      dados.financeiro = compareMetrics(a.totais, b.totais); avisos.push(financialNote)
    }
  } else if (name === 'consultar_funil_audiencia') {
    assertNoFilters(args, ['marca_id', 'apresentadora_id'])
    dados = await sharedRead(app, user, '/v1/analytics/funil', { from: args.inicio, to: args.fim, ...pick(args, ['marca_id', 'apresentadora_id']) })
    origem = 'analytics/funil; lives encerradas com duração mínima de 5 minutos'
    avisos.push('Contagem de valores registrados não comprova cobertura completa: imports antigos podem ter gravado zero para campos ausentes.')
  } else {
    let period = args
    if (name === 'detalhar_live') {
      const { rows } = await app.withTenant(user.tenant_id, db => db.query(`SELECT (iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia, status
        FROM lives WHERE tenant_id = $1::uuid AND id = $2::uuid`, [user.tenant_id, args.live_id]))
      if (!rows[0]) throw Object.assign(new Error('Live não encontrada'), { statusCode: 404 })
      if (!['encerrada', 'em_andamento'].includes(rows[0].status)) throw Object.assign(new Error('Live sem métricas de execução'), { statusCode: 422 })
      period = { inicio: rows[0].dia, fim: rows[0].dia, status: rows[0].status, origem: 'live', live_id: args.live_id }
      resolvedPeriod = { inicio: period.inicio, fim: period.fim }
    }
    const facts = await loadFacts(app, user, period)
    if (period.status === 'em_andamento') avisos.push('Dados parciais registrados, não atualizados instantaneamente do TikTok. Horas podem usar o término previsto.')
    if (period.cabine_id || name === 'consultar_cabines') avisos.push('Vídeos não são atribuídos a cabines; este recorte contém apenas lives.')
    if (name === 'consultar_resumo') dados = aggregateFacts(facts, null, args.apresentadora_id)
    else if (name === 'consultar_evolucao') dados = evolution(facts, args, args.granularidade, args.apresentadora_id)
    else if (name === 'consultar_apresentadores') {
      dados = aggregateFacts(facts, 'apresentadora').filter(r => !args.apresentadora_id || r.id === args.apresentadora_id)
      avisos.push('Presença estimada é identificação de participação, não medição exata nem prova de falta. Horas individuais podem se sobrepor.')
    } else if (name === 'consultar_marcas') dados = aggregateFacts(facts, 'marca', args.apresentadora_id)
    else if (name === 'consultar_cabines') dados = aggregateFacts(facts.filter(f => f.origem === 'live'), 'cabine', args.apresentadora_id)
    else if (name === 'consultar_lives') dados = page(facts.filter(f => f.origem === 'live'), args)
    else {
      dados = facts.find(f => f.id === args.live_id && f.origem === 'live')
      if (!dados) throw Object.assign(new Error('Live não encontrada'), { statusCode: 404 })
    }
    avisos.push('Dia atribuído ao início da live em São Paulo. GMV de vídeos segue vendas atribuídas; outras telas podem usar video_registros.')
    if (facts.some(f => f.gmv_registrado === false)) avisos.push('GMV ausente: totais completos ficam indisponíveis; gmv_conhecido é apenas o subtotal dos valores registrados.')
  }
  return { periodo: resolvedPeriod || pick(args, ['inicio', 'fim', 'mes', 'atual', 'anterior']), filtros: pick(args, ['marca_id', 'cabine_id', 'apresentadora_id', 'origem', 'status']),
    consultado_em: new Date().toISOString(), timezone: 'America/Sao_Paulo', moeda: 'BRL', origem, avisos, dados }
}
