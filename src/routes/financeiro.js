import { z } from 'zod'
import { READ_FINANCEIRO, WRITE_FINANCEIRO } from '../config/role_groups.js'
import {
  ALIQUOTA_IMPOSTO_DEFAULT,
  GRUPOS_CUSTO,
  GRUPOS_FIXOS,
  addMeses,
  calcularDREPeriodo,
  calcularFluxoMes,
  calcularSerieAnual,
  mesValido,
  mesesEntre,
  montarItensMes,
  planejarGeracaoCustos,
  planejarGeracaoReceitas,
  primeiroDia,
  r2,
  resolverPeriodo,
  statusReceita,
  toNum,
  ultimoDia,
  vencimentoNoMes,
} from '../services/financeiro_calc.js'

// ─── Validação ──────────────────────────────────────────────────────────────

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RE_COMPETENCIA = /^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/

const TIPOS_CUSTO = [
  'aluguel', 'salario', 'energia', 'internet', 'outros',
  'fixo', 'variavel', 'imposto', 'aporte', 'servicos', 'ferramentas', 'produtos',
]
const GRUPO_POR_TIPO_LEGADO = {
  aluguel: 'estrutural', energia: 'estrutural', internet: 'estrutural',
  salario: 'operacional', aporte: 'aporte',
}

const dia = z.number().int().min(1).max(31).nullable()
const competencia = z.string().regex(RE_COMPETENCIA, 'Formato: YYYY-MM ou YYYY-MM-DD')
const data = z.string().regex(RE_DATA, 'Formato: YYYY-MM-DD')
const dinheiro = z.number().min(0)

const custoSchema = z.object({
  descricao:      z.string().min(1),
  valor:          z.number().positive(),
  tipo:           z.enum(TIPOS_CUSTO).optional(),
  grupo:          z.enum(GRUPOS_CUSTO).optional(),
  competencia,
  status:         z.enum(['previsto', 'pago']).optional(),
  data_pagamento: data.nullable().optional(),
  dia_vencimento: dia.optional(),
  cartao:         z.boolean().optional(),
  observacao:     z.string().nullable().optional(),
})
const custoPatchSchema = custoSchema.partial()

const pagarSchema = z.object({
  data_pagamento: data.optional(),
  valor:          z.number().positive().optional(),
}).strict()

const recorrenteSchema = z.object({
  nome:           z.string().min(1),
  descricao:      z.string().nullable().optional(),
  grupo:          z.enum(GRUPOS_CUSTO).default('estrutural'),
  valor:          dinheiro,
  dia_vencimento: dia.optional(),
  cartao:         z.boolean().optional(),
  inicio:         competencia,
  fim:            competencia.nullable().optional(),
  ativo:          z.boolean().optional(),
})
// Sem .default(): em zod 4 o default sobrevive ao .partial() e sobrescreveria o grupo no PATCH
const recorrentePatchSchema = recorrenteSchema.extend({ grupo: z.enum(GRUPOS_CUSTO) }).partial()

const receitaSchema = z.object({
  contrato_id:       z.string().regex(RE_UUID).nullable().optional(),
  cliente_id:        z.string().regex(RE_UUID).nullable().optional(),
  descricao:         z.string().nullable().optional(),
  competencia,
  fixo_previsto:     dinheiro.default(0),
  comissao_prevista: dinheiro.default(0),
  dia_vencimento:    dia.optional(),
  observacao:        z.string().nullable().optional(),
})
const receitaPatchSchema = z.object({
  descricao:         z.string().nullable().optional(),
  fixo_previsto:     dinheiro.optional(),
  comissao_prevista: dinheiro.optional(),
  fixo_recebido:     dinheiro.optional(),
  comissao_recebida: dinheiro.optional(),
  dia_vencimento:    dia.optional(),
  data_recebimento:  data.nullable().optional(),
  observacao:        z.string().nullable().optional(),
}).strict()
const receberSchema = z.object({
  fixo_recebido:     dinheiro.optional(),
  comissao_recebida: dinheiro.optional(),
  data_recebimento:  data.optional(),
}).strict()

const configSchema = z.object({
  aliquota_imposto_pct: z.number().min(0).max(100),
}).strict()

const vencimentoSchema = z.object({ dia_vencimento: dia }).strict()

const hojeISO = () => new Date().toISOString().slice(0, 10)
const normCompetencia = (s) => (s.length === 7 ? `${s}-01` : s)
const competenciaMes = (s) => `${s.slice(0, 7)}-01`
const erro400 = (reply, parsed) => reply.code(400).send({ error: parsed.error.issues[0].message })

function tipoParaGrupo(grupo) {
  if (grupo === 'aporte') return 'aporte'
  return GRUPOS_FIXOS.includes(grupo) ? 'fixo' : 'variavel'
}

function auditar(app, request, action, entity_type, entity_id, metadata) {
  app.audit?.log?.(request, { action, entity_type, entity_id, metadata })
    ?.catch?.((err) => app.log.error({ err }, 'audit log failed'))
}

// ─── SQL ────────────────────────────────────────────────────────────────────

const CUSTO_COLS = `
  id, descricao, valor, tipo, grupo, status,
  to_char(competencia, 'YYYY-MM-DD')    AS competencia,
  to_char(data_pagamento, 'YYYY-MM-DD') AS data_pagamento,
  dia_vencimento, cartao, recorrente_id, observacao`

const RECEITA_COLS = `
  rp.id, rp.contrato_id, rp.cliente_id, cl.nome AS cliente_nome, rp.descricao,
  to_char(rp.competencia, 'YYYY-MM-DD')      AS competencia,
  rp.fixo_previsto, rp.comissao_prevista, rp.gmv_base,
  rp.fixo_recebido, rp.comissao_recebida, rp.dia_vencimento,
  to_char(rp.data_recebimento, 'YYYY-MM-DD') AS data_recebimento,
  rp.status, rp.ajuste_manual, rp.observacao`

const RECORRENTE_COLS = `
  id, nome, descricao, grupo, valor, dia_vencimento, cartao,
  to_char(inicio, 'YYYY-MM-DD') AS inicio,
  to_char(fim, 'YYYY-MM-DD')    AS fim,
  ativo`

const TZ = 'America/Sao_Paulo'

function fmtCusto(r) {
  return { ...r, valor: toNum(r.valor) }
}

function fmtReceita(r, hoje = hojeISO()) {
  const out = {
    ...r,
    fixo_previsto: toNum(r.fixo_previsto),
    comissao_prevista: toNum(r.comissao_prevista),
    gmv_base: toNum(r.gmv_base),
    fixo_recebido: toNum(r.fixo_recebido),
    comissao_recebida: toNum(r.comissao_recebida),
  }
  out.total_previsto = r2(out.fixo_previsto + out.comissao_prevista)
  out.total_recebido = r2(out.fixo_recebido + out.comissao_recebida)
  out.vencimento = vencimentoNoMes(out.competencia.slice(0, 7), out.dia_vencimento)
  out.status = statusReceita(out, hoje)
  return out
}

function fmtRecorrente(r) {
  return { ...r, valor: toNum(r.valor) }
}

async function carregarContratos(db, tenantId, ateData) {
  const res = await db.query(`
    SELECT c.id, c.cliente_id, cl.nome AS cliente_nome, c.status, c.valor_fixo, c.dia_vencimento,
           to_char((c.ativado_em AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS ativado_em,
           to_char((COALESCE(c.cancelado_em, c.cancelado_automaticamente_em, c.arquivado_em)
                    AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD')              AS fim_em
      FROM contratos c
      LEFT JOIN clientes cl ON cl.id = c.cliente_id AND cl.tenant_id = c.tenant_id
     WHERE c.tenant_id = $1::uuid
       AND c.ativado_em IS NOT NULL
       AND (c.ativado_em AT TIME ZONE '${TZ}')::date <= $2::date`,
    [tenantId, ateData])
  return res.rows.map((r) => ({ ...r, valor_fixo: toNum(r.valor_fixo) }))
}

async function carregarVendas(db, tenantId, deData, ateData) {
  // Snapshot do commission-engine; reprovadas ficam fora do previsto.
  const res = await db.query(`
    SELECT m.cliente_id,
           to_char(date_trunc('month', va.data), 'YYYY-MM') AS mes,
           COALESCE(SUM(va.comissao_franquia), 0)      AS comissao_franquia,
           COALESCE(SUM(va.gmv), 0)                    AS gmv,
           COALESCE(SUM(va.comissao_apresentadora), 0) AS comissao_apresentadora
      FROM vendas_atribuidas va
      LEFT JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
     WHERE va.tenant_id = $1::uuid
       AND va.data >= $2::date
       AND va.data <= $3::date
       AND va.status_aprovacao <> 'reprovada'
     GROUP BY 1, 2`,
    [tenantId, deData, ateData])
  return res.rows
}

/**
 * Carrega tudo que o cálculo precisa para os meses [inicio, fim].
 * Vendas começam 1 mês antes (comissão de M vem do GMV de M-1).
 */
async function carregarDados(db, tenantId, inicio, fim) {
  const de = primeiroDia(inicio)
  const ate = ultimoDia(fim)

  const tenant = await db.query(
    'SELECT aliquota_imposto_pct FROM tenants WHERE id = $1::uuid', [tenantId])
  const contratos = await carregarContratos(db, tenantId, ate)
  const vendas = await carregarVendas(db, tenantId, primeiroDia(addMeses(inicio, -1)), ate)
  const receitas = await db.query(`
    SELECT ${RECEITA_COLS}
      FROM receitas_previstas rp
      LEFT JOIN clientes cl ON cl.id = rp.cliente_id AND cl.tenant_id = rp.tenant_id
     WHERE rp.tenant_id = $1::uuid AND rp.competencia >= $2::date AND rp.competencia <= $3::date`,
    [tenantId, de, ate])
  const custos = await db.query(`
    SELECT ${CUSTO_COLS}
      FROM custos
     WHERE tenant_id = $1::uuid AND competencia >= $2::date AND competencia <= $3::date`,
    [tenantId, de, ate])
  const recorrentes = await db.query(`
    SELECT ${RECORRENTE_COLS}
      FROM custos_recorrentes
     WHERE tenant_id = $1::uuid AND ativo = true
       AND inicio <= $3::date AND (fim IS NULL OR fim >= $2::date)`,
    [tenantId, de, ate])

  const aliquotaRaw = tenant.rows[0]?.aliquota_imposto_pct
  return {
    aliquota: aliquotaRaw == null ? ALIQUOTA_IMPOSTO_DEFAULT : toNum(aliquotaRaw),
    contratos,
    vendas,
    receitas: receitas.rows,
    custos: custos.rows,
    recorrentes: recorrentes.rows,
  }
}

function montarUpdate(campos, valoresIniciais) {
  const sets = []
  const values = [...valoresIniciais]
  for (const [col, val] of Object.entries(campos)) {
    if (val === undefined) continue
    values.push(val)
    sets.push(`${col} = $${values.length}`)
  }
  return { sets, values }
}

// ─── Rotas ──────────────────────────────────────────────────────────────────

export async function financeiroRoutes(app) {
  const read = { preHandler: app.requirePapel(READ_FINANCEIRO) }
  const write = { preHandler: app.requirePapel(WRITE_FINANCEIRO) }

  const checarId = (request, reply) => {
    if (!RE_UUID.test(String(request.params.id))) {
      reply.code(400).send({ error: 'ID inválido' })
      return false
    }
    return true
  }

  // GET /v1/financeiro/resumo?inicio=YYYY-MM&fim=YYYY-MM  (ou mes=YYYY-MM | mes=&ano=)
  // DRE previsto x realizado, mês a mês + total do período.
  app.get('/v1/financeiro/resumo', read, async (request, reply) => {
    const { tenant_id } = request.user
    const periodo = resolverPeriodo(request.query)
    if (periodo.error) return reply.code(400).send({ error: periodo.error })
    const { inicio, fim } = periodo
    const meses = mesesEntre(inicio, fim)

    return app.withTenant(tenant_id, async (db) => {
      const dados = await carregarDados(db, tenant_id, inicio, fim)
      const dre = calcularDREPeriodo(dados, meses)
      const prev = dre.total.previsto
      const totalCustos = r2(prev.custos_fixos.total + prev.custos_variaveis.total)
      return {
        inicio: primeiroDia(inicio),
        fim: ultimoDia(fim),
        periodo: primeiroDia(inicio),
        aliquota_imposto_pct: dados.aliquota,
        previsto: dre.total.previsto,
        realizado: dre.total.realizado,
        meses: dre.meses,
        // Campos legados (tela atual do Flutter)
        fat_bruto: prev.receita.total,
        total_custos: totalCustos,
        fat_liquido: r2(prev.receita.total - totalCustos - prev.imposto),
      }
    })
  })

  // GET /v1/financeiro/fluxo-caixa?mes=YYYY-MM[&saldo_inicial=0]
  // Linhas por dia de vencimento (5,10,15,20,25,30,cartao) + série anual com acumulado.
  app.get('/v1/financeiro/fluxo-caixa', read, async (request, reply) => {
    const { tenant_id } = request.user
    const periodo = resolverPeriodo(request.query)
    if (periodo.error) return reply.code(400).send({ error: periodo.error })
    const mes = periodo.inicio
    const ano = mes.slice(0, 4)
    const saldoInicialAno = toNum(request.query.saldo_inicial)
    const mesesAno = mesesEntre(`${ano}-01`, `${ano}-12`)

    return app.withTenant(tenant_id, async (db) => {
      const dados = await carregarDados(db, tenant_id, `${ano}-01`, `${ano}-12`)
      const serie = calcularSerieAnual(dados, mesesAno, { previsto: saldoInicialAno, realizado: saldoInicialAno })
      const doMes = serie.find((s) => s.mes === mes)
      const itens = montarItensMes(dados, mes)
      const linhas = calcularFluxoMes(itens, {
        previsto: doMes.saldo_inicial_previsto,
        realizado: doMes.saldo_inicial_realizado,
      })

      // Formato legado: listas {dia: YYYY-MM-DD, valor} (previsto)
      const diaLegado = (b) => (b === 'cartao' ? ultimoDia(mes) : vencimentoNoMes(mes, Number(b)))
      return {
        mes,
        inicio: primeiroDia(mes),
        fim: ultimoDia(mes),
        periodo: primeiroDia(mes),
        saldo_inicial: { previsto: doMes.saldo_inicial_previsto, realizado: doMes.saldo_inicial_realizado },
        linhas,
        totais: {
          entradas_previstas: doMes.entradas_previstas,
          saidas_previstas: doMes.saidas_previstas,
          saldo_previsto: doMes.saldo_previsto,
          acumulado_previsto: doMes.acumulado_previsto,
          entradas_realizadas: doMes.entradas_realizadas,
          saidas_realizadas: doMes.saidas_realizadas,
          saldo_realizado: doMes.saldo_realizado,
          acumulado_realizado: doMes.acumulado_realizado,
        },
        serie_anual: serie,
        itens,
        entradas: linhas.filter((l) => l.entradas_previstas > 0)
          .map((l) => ({ dia: diaLegado(l.dia), valor: l.entradas_previstas })),
        saidas: linhas.filter((l) => l.saidas_previstas > 0)
          .map((l) => ({ dia: diaLegado(l.dia), valor: l.saidas_previstas })),
      }
    })
  })

  // GET /v1/financeiro/faturamento?periodo=YYYY-MM  OR  ?inicio=YYYY-MM&fim=YYYY-MM  (compat)
  app.get('/v1/financeiro/faturamento', read, async (request, reply) => {
    const { tenant_id } = request.user
    const periodo = resolverPeriodo(request.query)
    if (periodo.error) return reply.code(400).send({ error: periodo.error })
    const de = primeiroDia(periodo.inicio)
    const ate = ultimoDia(periodo.fim)

    return app.withTenant(tenant_id, async (db) => {
      const porCliente = await db.query(`
        SELECT cl.nome, cl.nicho, COALESCE(SUM(COALESCE(l.manual_gmv, l.fat_gerado)), 0) AS total
        FROM clientes cl
        LEFT JOIN lives l ON l.cliente_id = cl.id AND l.tenant_id = cl.tenant_id
          AND l.encerrado_em >= $2::date
          AND l.encerrado_em <  ($3::date + interval '1 day')
        WHERE cl.tenant_id = $1::uuid
          AND cl.status = 'ativo'
        GROUP BY cl.id, cl.nome, cl.nicho
        ORDER BY total DESC
      `, [tenant_id, de, ate])

      return {
        periodo: de,
        inicio: de,
        fim: ate,
        por_cliente: porCliente.rows.map((r) => ({ ...r, total: toNum(r.total) })),
      }
    })
  })

  // ─── Configuração ─────────────────────────────────────────────────────────

  // GET /v1/financeiro/config
  app.get('/v1/financeiro/config', read, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const res = await db.query('SELECT aliquota_imposto_pct FROM tenants WHERE id = $1::uuid', [tenant_id])
      const v = res.rows[0]?.aliquota_imposto_pct
      return { aliquota_imposto_pct: v == null ? ALIQUOTA_IMPOSTO_DEFAULT : toNum(v) }
    })
  })

  // PATCH /v1/financeiro/config { aliquota_imposto_pct }
  app.patch('/v1/financeiro/config', write, async (request, reply) => {
    const parsed = configSchema.safeParse(request.body ?? {})
    if (!parsed.success) return erro400(reply, parsed)
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const res = await db.query(
        'UPDATE tenants SET aliquota_imposto_pct = $2 WHERE id = $1::uuid RETURNING aliquota_imposto_pct',
        [tenant_id, parsed.data.aliquota_imposto_pct])
      if (!res.rows[0]) return reply.code(404).send({ error: 'Tenant não encontrado' })
      auditar(app, request, 'financeiro.config_update', 'tenant', tenant_id, parsed.data)
      return { aliquota_imposto_pct: toNum(res.rows[0].aliquota_imposto_pct) }
    })
  })

  // PATCH /v1/financeiro/contratos/:id/vencimento { dia_vencimento }
  app.patch('/v1/financeiro/contratos/:id/vencimento', write, async (request, reply) => {
    if (!checarId(request, reply)) return
    const parsed = vencimentoSchema.safeParse(request.body ?? {})
    if (!parsed.success) return erro400(reply, parsed)
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const res = await db.query(
        `UPDATE contratos SET dia_vencimento = $3
          WHERE id = $1::uuid AND tenant_id = $2::uuid
          RETURNING id, dia_vencimento`,
        [request.params.id, tenant_id, parsed.data.dia_vencimento])
      if (!res.rows[0]) return reply.code(404).send({ error: 'Contrato não encontrado' })
      auditar(app, request, 'financeiro.contrato_vencimento', 'contrato', request.params.id, parsed.data)
      return res.rows[0]
    })
  })

  // ─── Receitas previstas ───────────────────────────────────────────────────

  // GET /v1/financeiro/receitas?mes=YYYY-MM | inicio&fim [&status=&contrato_id=]
  app.get('/v1/financeiro/receitas', read, async (request, reply) => {
    const { tenant_id } = request.user
    const periodo = resolverPeriodo(request.query)
    if (periodo.error) return reply.code(400).send({ error: periodo.error })
    const values = [tenant_id, primeiroDia(periodo.inicio), ultimoDia(periodo.fim)]
    let extra = ''
    if (request.query.contrato_id) {
      if (!RE_UUID.test(String(request.query.contrato_id))) return reply.code(400).send({ error: 'contrato_id inválido' })
      values.push(request.query.contrato_id)
      extra += ` AND rp.contrato_id = $${values.length}::uuid`
    }
    return app.withTenant(tenant_id, async (db) => {
      const res = await db.query(`
        SELECT ${RECEITA_COLS}
          FROM receitas_previstas rp
          LEFT JOIN clientes cl ON cl.id = rp.cliente_id AND cl.tenant_id = rp.tenant_id
         WHERE rp.tenant_id = $1::uuid
           AND rp.competencia >= $2::date AND rp.competencia <= $3::date${extra}
         ORDER BY rp.competencia, rp.dia_vencimento NULLS LAST, cl.nome`,
        values)
      const hoje = hojeISO()
      let rows = res.rows.map((r) => fmtReceita(r, hoje))
      if (request.query.status) rows = rows.filter((r) => r.status === request.query.status)
      return rows
    })
  })

  // POST /v1/financeiro/receitas — lançamento manual
  app.post('/v1/financeiro/receitas', write, async (request, reply) => {
    const parsed = receitaSchema.safeParse(request.body ?? {})
    if (!parsed.success) return erro400(reply, parsed)
    const d = parsed.data
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      let clienteId = d.cliente_id ?? null
      let diaVenc = d.dia_vencimento ?? null
      if (d.contrato_id) {
        const c = await db.query(
          'SELECT cliente_id, dia_vencimento FROM contratos WHERE id = $1::uuid AND tenant_id = $2::uuid',
          [d.contrato_id, tenant_id])
        if (!c.rows[0]) return reply.code(404).send({ error: 'Contrato não encontrado' })
        clienteId = clienteId ?? c.rows[0].cliente_id
        diaVenc = d.dia_vencimento === undefined ? c.rows[0].dia_vencimento : diaVenc
      }
      const res = await db.query(`
        INSERT INTO receitas_previstas
          (tenant_id, contrato_id, cliente_id, descricao, competencia, fixo_previsto, comissao_prevista,
           dia_vencimento, observacao, ajuste_manual)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
        ON CONFLICT (contrato_id, competencia) DO NOTHING
        RETURNING id`,
        [tenant_id, d.contrato_id ?? null, clienteId, d.descricao ?? null, competenciaMes(d.competencia),
         d.fixo_previsto, d.comissao_prevista, diaVenc, d.observacao ?? null])
      if (!res.rows[0]) return reply.code(409).send({ error: 'Já existe receita para este contrato nesta competência' })
      auditar(app, request, 'financeiro.receita_create', 'receita_prevista', res.rows[0].id, d)
      return reply.code(201).send({ id: res.rows[0].id })
    })
  })

  // POST /v1/financeiro/receitas/gerar?mes=YYYY-MM — idempotente
  app.post('/v1/financeiro/receitas/gerar', write, async (request, reply) => {
    const mes = String(request.query.mes ?? request.body?.mes ?? '')
    if (!mesValido(mes)) return reply.code(400).send({ error: 'mes obrigatório no formato YYYY-MM' })
    const { tenant_id } = request.user

    return app.withTenant(tenant_id, async (db) => {
      const contratos = await carregarContratos(db, tenant_id, ultimoDia(mes))
      const vendas = await carregarVendas(db, tenant_id, primeiroDia(addMeses(mes, -1)), ultimoDia(addMeses(mes, -1)))
      const existentes = await db.query(`
        SELECT id, contrato_id, fixo_previsto, comissao_prevista, gmv_base, fixo_recebido,
               comissao_recebida, dia_vencimento, status, ajuste_manual
          FROM receitas_previstas
         WHERE tenant_id = $1::uuid AND competencia = $2::date`,
        [tenant_id, primeiroDia(mes)])
      const plano = planejarGeracaoReceitas({ mes, contratos, vendas, existentes: existentes.rows })

      let inseridas = 0
      let atualizadas = 0
      await db.query('BEGIN')
      try {
        for (const r of plano.inserir) {
          const ins = await db.query(`
            INSERT INTO receitas_previstas
              (tenant_id, contrato_id, cliente_id, competencia, fixo_previsto, comissao_prevista, gmv_base, dia_vencimento)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (contrato_id, competencia) DO NOTHING
            RETURNING id`,
            [tenant_id, r.contrato_id, r.cliente_id, r.competencia, r.fixo_previsto,
             r.comissao_prevista, r.gmv_base, r.dia_vencimento])
          inseridas += ins.rows.length
        }
        for (const r of plano.atualizar) {
          const upd = await db.query(`
            UPDATE receitas_previstas
               SET fixo_previsto = $3, comissao_prevista = $4, gmv_base = $5, dia_vencimento = $6,
                   atualizado_em = NOW()
             WHERE id = $1::uuid AND tenant_id = $2::uuid
               AND status = 'previsto' AND ajuste_manual = false
               AND fixo_recebido = 0 AND comissao_recebida = 0
             RETURNING id`,
            [r.id, tenant_id, r.fixo_previsto, r.comissao_prevista, r.gmv_base, r.dia_vencimento])
          atualizadas += upd.rows.length
        }
        await db.query('COMMIT')
      } catch (err) {
        await db.query('ROLLBACK')
        throw err
      }
      auditar(app, request, 'financeiro.receitas_gerar', 'receita_prevista', null, { mes, inseridas, atualizadas })
      return { mes, inseridas, atualizadas, inalteradas: plano.inalteradas.length }
    })
  })

  // PATCH /v1/financeiro/receitas/:id
  app.patch('/v1/financeiro/receitas/:id', write, async (request, reply) => {
    if (!checarId(request, reply)) return
    const parsed = receitaPatchSchema.safeParse(request.body ?? {})
    if (!parsed.success) return erro400(reply, parsed)
    const d = parsed.data
    const { tenant_id } = request.user
    const campos = { ...d }
    if (d.fixo_previsto !== undefined || d.comissao_prevista !== undefined) campos.ajuste_manual = true
    const { sets, values } = montarUpdate(campos, [request.params.id, tenant_id])
    if (sets.length === 0) return reply.code(400).send({ error: 'Nada para atualizar' })

    return app.withTenant(tenant_id, async (db) => {
      const res = await db.query(`
        UPDATE receitas_previstas SET ${sets.join(', ')}, atualizado_em = NOW()
         WHERE id = $1::uuid AND tenant_id = $2::uuid
         RETURNING id, fixo_previsto, comissao_prevista, fixo_recebido, comissao_recebida,
                   dia_vencimento, to_char(competencia, 'YYYY-MM-DD') AS competencia`,
        values)
      const row = res.rows[0]
      if (!row) return reply.code(404).send({ error: 'Receita não encontrada' })
      const status = statusReceita(row, hojeISO())
      await db.query('UPDATE receitas_previstas SET status = $3 WHERE id = $1::uuid AND tenant_id = $2::uuid',
        [row.id, tenant_id, status])
      auditar(app, request, 'financeiro.receita_update', 'receita_prevista', row.id, { changed_fields: Object.keys(d) })
      return { id: row.id, status }
    })
  })

  // PATCH /v1/financeiro/receitas/:id/receber { fixo_recebido?, comissao_recebida?, data_recebimento? }
  // Sem valores no body = recebe o previsto integral.
  app.patch('/v1/financeiro/receitas/:id/receber', write, async (request, reply) => {
    if (!checarId(request, reply)) return
    const parsed = receberSchema.safeParse(request.body ?? {})
    if (!parsed.success) return erro400(reply, parsed)
    const d = parsed.data
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const cur = await db.query(`
        SELECT id, fixo_previsto, comissao_prevista, dia_vencimento, to_char(competencia, 'YYYY-MM-DD') AS competencia
          FROM receitas_previstas WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [request.params.id, tenant_id])
      const row = cur.rows[0]
      if (!row) return reply.code(404).send({ error: 'Receita não encontrada' })
      const integral = d.fixo_recebido === undefined && d.comissao_recebida === undefined
      const fixoRec = integral ? toNum(row.fixo_previsto) : (d.fixo_recebido ?? null)
      const comRec = integral ? toNum(row.comissao_prevista) : (d.comissao_recebida ?? null)
      const upd = await db.query(`
        UPDATE receitas_previstas
           SET fixo_recebido     = COALESCE($3, fixo_recebido),
               comissao_recebida = COALESCE($4, comissao_recebida),
               data_recebimento  = $5::date,
               atualizado_em     = NOW()
         WHERE id = $1::uuid AND tenant_id = $2::uuid
         RETURNING fixo_previsto, comissao_prevista, fixo_recebido, comissao_recebida, dia_vencimento,
                   to_char(competencia, 'YYYY-MM-DD') AS competencia`,
        [row.id, tenant_id, fixoRec, comRec, d.data_recebimento ?? hojeISO()])
      const status = statusReceita(upd.rows[0], hojeISO())
      await db.query('UPDATE receitas_previstas SET status = $3 WHERE id = $1::uuid AND tenant_id = $2::uuid',
        [row.id, tenant_id, status])
      auditar(app, request, 'financeiro.receita_receber', 'receita_prevista', row.id,
        { fixo_recebido: fixoRec, comissao_recebida: comRec })
      return {
        id: row.id,
        status,
        fixo_recebido: toNum(upd.rows[0].fixo_recebido),
        comissao_recebida: toNum(upd.rows[0].comissao_recebida),
      }
    })
  })

  // DELETE /v1/financeiro/receitas/:id
  app.delete('/v1/financeiro/receitas/:id', write, async (request, reply) => {
    if (!checarId(request, reply)) return
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const res = await db.query(
        'DELETE FROM receitas_previstas WHERE id = $1::uuid AND tenant_id = $2::uuid RETURNING id',
        [request.params.id, tenant_id])
      if (!res.rows[0]) return reply.code(404).send({ error: 'Receita não encontrada' })
      auditar(app, request, 'financeiro.receita_delete', 'receita_prevista', request.params.id)
      return { ok: true }
    })
  })

  // ─── Custos ───────────────────────────────────────────────────────────────

  // POST /v1/financeiro/custos
  app.post('/v1/financeiro/custos', write, async (request, reply) => {
    const parsed = custoSchema.safeParse(request.body ?? {})
    if (!parsed.success) return erro400(reply, parsed)
    const { tenant_id } = request.user
    const d = parsed.data
    const grupo = d.grupo ?? GRUPO_POR_TIPO_LEGADO[d.tipo] ?? 'diversos'
    const tipo = d.tipo ?? tipoParaGrupo(grupo)
    const status = d.status ?? 'previsto'
    const dataPagamento = status === 'pago' ? (d.data_pagamento ?? hojeISO()) : null

    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `INSERT INTO custos (tenant_id, descricao, valor, tipo, competencia, grupo, status, data_pagamento,
                             dia_vencimento, cartao, observacao)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING ${CUSTO_COLS}`,
        [tenant_id, d.descricao, d.valor, tipo, normCompetencia(d.competencia), grupo, status, dataPagamento,
         d.dia_vencimento ?? null, d.cartao ?? false, d.observacao ?? null]
      )
      const row = result.rows[0]
      auditar(app, request, 'financeiro.custo_create', 'custo', row.id, { descricao: d.descricao, tipo, grupo, valor: d.valor })
      return reply.code(201).send(fmtCusto(row))
    })
  })

  // GET /v1/financeiro/custos?mes=YYYY-MM | inicio&fim [&grupo=&status=]
  app.get('/v1/financeiro/custos', read, async (request, reply) => {
    const { tenant_id } = request.user
    const periodo = resolverPeriodo(request.query)
    if (periodo.error) return reply.code(400).send({ error: periodo.error })
    const values = [tenant_id, primeiroDia(periodo.inicio), ultimoDia(periodo.fim)]
    let extra = ''
    if (request.query.grupo) {
      values.push(String(request.query.grupo))
      extra += ` AND grupo = $${values.length}`
    }
    if (request.query.status) {
      values.push(String(request.query.status))
      extra += ` AND status = $${values.length}`
    }
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT ${CUSTO_COLS}
           FROM custos
          WHERE tenant_id = $1::uuid
            AND competencia >= $2::date AND competencia <= $3::date${extra}
          ORDER BY competencia DESC, dia_vencimento NULLS LAST, descricao`,
        values
      )
      return result.rows.map(fmtCusto)
    })
  })

  // PATCH /v1/financeiro/custos/:id
  app.patch('/v1/financeiro/custos/:id', write, async (request, reply) => {
    if (!checarId(request, reply)) return
    const parsed = custoPatchSchema.safeParse(request.body ?? {})
    if (!parsed.success) return erro400(reply, parsed)
    const d = parsed.data
    const campos = {
      ...d,
      competencia: d.competencia ? normCompetencia(d.competencia) : undefined,
    }
    if (d.status === 'previsto') campos.data_pagamento = null
    if (d.status === 'pago' && d.data_pagamento === undefined) campos.data_pagamento = hojeISO()
    const { tenant_id } = request.user
    const { sets, values } = montarUpdate(campos, [request.params.id, tenant_id])
    if (sets.length === 0) return reply.code(400).send({ error: 'Nada para atualizar' })
    return app.withTenant(tenant_id, async (db) => {
      const res = await db.query(
        `UPDATE custos SET ${sets.join(', ')}, atualizado_em = NOW()
          WHERE id = $1::uuid AND tenant_id = $2::uuid
          RETURNING ${CUSTO_COLS}`,
        values)
      if (!res.rows[0]) return reply.code(404).send({ error: 'Custo não encontrado' })
      auditar(app, request, 'financeiro.custo_update', 'custo', request.params.id, { changed_fields: Object.keys(d) })
      return fmtCusto(res.rows[0])
    })
  })

  // PATCH /v1/financeiro/custos/:id/pagar { data_pagamento?, valor? }
  app.patch('/v1/financeiro/custos/:id/pagar', write, async (request, reply) => {
    if (!checarId(request, reply)) return
    const parsed = pagarSchema.safeParse(request.body ?? {})
    if (!parsed.success) return erro400(reply, parsed)
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const res = await db.query(
        `UPDATE custos
            SET status = 'pago', data_pagamento = $3::date, valor = COALESCE($4, valor), atualizado_em = NOW()
          WHERE id = $1::uuid AND tenant_id = $2::uuid
          RETURNING ${CUSTO_COLS}`,
        [request.params.id, tenant_id, parsed.data.data_pagamento ?? hojeISO(), parsed.data.valor ?? null])
      if (!res.rows[0]) return reply.code(404).send({ error: 'Custo não encontrado' })
      auditar(app, request, 'financeiro.custo_pagar', 'custo', request.params.id, parsed.data)
      return fmtCusto(res.rows[0])
    })
  })

  // DELETE /v1/financeiro/custos/:id
  app.delete('/v1/financeiro/custos/:id', write, async (request, reply) => {
    if (!checarId(request, reply)) return
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `DELETE FROM custos WHERE id = $1::uuid AND tenant_id = $2::uuid RETURNING id`,
        [request.params.id, tenant_id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Custo não encontrado' })
      auditar(app, request, 'financeiro.custo_delete', 'custo', request.params.id)
      return { ok: true }
    })
  })

  // POST /v1/financeiro/custos/gerar?mes=YYYY-MM — materializa custos_recorrentes (idempotente)
  app.post('/v1/financeiro/custos/gerar', write, async (request, reply) => {
    const mes = String(request.query.mes ?? request.body?.mes ?? '')
    if (!mesValido(mes)) return reply.code(400).send({ error: 'mes obrigatório no formato YYYY-MM' })
    const { tenant_id } = request.user
    const de = primeiroDia(mes)
    const ate = ultimoDia(mes)

    return app.withTenant(tenant_id, async (db) => {
      const recorrentes = await db.query(
        `SELECT ${RECORRENTE_COLS}
           FROM custos_recorrentes
          WHERE tenant_id = $1::uuid AND ativo = true
            AND inicio <= $3::date AND (fim IS NULL OR fim >= $2::date)`,
        [tenant_id, de, ate])
      const existentes = await db.query(
        `SELECT recorrente_id, to_char(competencia, 'YYYY-MM-DD') AS competencia
           FROM custos
          WHERE tenant_id = $1::uuid AND recorrente_id IS NOT NULL
            AND competencia >= $2::date AND competencia <= $3::date`,
        [tenant_id, de, ate])
      const plano = planejarGeracaoCustos({ mes, recorrentes: recorrentes.rows, existentes: existentes.rows })

      let inseridos = 0
      await db.query('BEGIN')
      try {
        for (const c of plano.inserir) {
          const ins = await db.query(
            `INSERT INTO custos (tenant_id, descricao, valor, tipo, grupo, competencia, status,
                                 dia_vencimento, cartao, recorrente_id, observacao)
             VALUES ($1, $2, $3, $4, $5, $6, 'previsto', $7, $8, $9, $10)
             ON CONFLICT (recorrente_id, competencia) DO NOTHING
             RETURNING id`,
            [tenant_id, c.descricao, c.valor, tipoParaGrupo(c.grupo), c.grupo, c.competencia,
             c.dia_vencimento, c.cartao, c.recorrente_id, c.observacao])
          inseridos += ins.rows.length
        }
        await db.query('COMMIT')
      } catch (err) {
        await db.query('ROLLBACK')
        throw err
      }
      auditar(app, request, 'financeiro.custos_gerar', 'custo', null, { mes, inseridos })
      return { mes, inseridos, ja_existentes: existentes.rows.length }
    })
  })

  // ─── Custos recorrentes ───────────────────────────────────────────────────

  // GET /v1/financeiro/custos-recorrentes[?ativo=true|false]
  app.get('/v1/financeiro/custos-recorrentes', read, async (request) => {
    const { tenant_id } = request.user
    const values = [tenant_id]
    let extra = ''
    if (request.query.ativo === 'true' || request.query.ativo === 'false') {
      values.push(request.query.ativo === 'true')
      extra = ` AND ativo = $2`
    }
    return app.withTenant(tenant_id, async (db) => {
      const res = await db.query(
        `SELECT ${RECORRENTE_COLS} FROM custos_recorrentes
          WHERE tenant_id = $1::uuid${extra}
          ORDER BY grupo, nome`,
        values)
      return res.rows.map(fmtRecorrente)
    })
  })

  // POST /v1/financeiro/custos-recorrentes
  app.post('/v1/financeiro/custos-recorrentes', write, async (request, reply) => {
    const parsed = recorrenteSchema.safeParse(request.body ?? {})
    if (!parsed.success) return erro400(reply, parsed)
    const d = parsed.data
    const inicio = competenciaMes(d.inicio)
    const fim = d.fim ? ultimoDia(d.fim.slice(0, 7)) : null
    if (fim && fim < inicio) return reply.code(400).send({ error: 'fim deve ser maior ou igual a inicio' })
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const res = await db.query(
        `INSERT INTO custos_recorrentes (tenant_id, nome, descricao, grupo, valor, dia_vencimento, cartao, inicio, fim, ativo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${RECORRENTE_COLS}`,
        [tenant_id, d.nome, d.descricao ?? null, d.grupo, d.valor, d.dia_vencimento ?? null,
         d.cartao ?? false, inicio, fim, d.ativo ?? true])
      auditar(app, request, 'financeiro.recorrente_create', 'custo_recorrente', res.rows[0].id, { nome: d.nome, valor: d.valor })
      return reply.code(201).send(fmtRecorrente(res.rows[0]))
    })
  })

  // PATCH /v1/financeiro/custos-recorrentes/:id — não altera lançamentos já gerados
  app.patch('/v1/financeiro/custos-recorrentes/:id', write, async (request, reply) => {
    if (!checarId(request, reply)) return
    const parsed = recorrentePatchSchema.safeParse(request.body ?? {})
    if (!parsed.success) return erro400(reply, parsed)
    const d = parsed.data
    const campos = {
      ...d,
      inicio: d.inicio ? competenciaMes(d.inicio) : undefined,
      fim: d.fim === undefined ? undefined : (d.fim ? ultimoDia(d.fim.slice(0, 7)) : null),
    }
    const { tenant_id } = request.user
    const { sets, values } = montarUpdate(campos, [request.params.id, tenant_id])
    if (sets.length === 0) return reply.code(400).send({ error: 'Nada para atualizar' })
    return app.withTenant(tenant_id, async (db) => {
      const res = await db.query(
        `UPDATE custos_recorrentes SET ${sets.join(', ')}, atualizado_em = NOW()
          WHERE id = $1::uuid AND tenant_id = $2::uuid
          RETURNING ${RECORRENTE_COLS}`,
        values)
      if (!res.rows[0]) return reply.code(404).send({ error: 'Custo recorrente não encontrado' })
      auditar(app, request, 'financeiro.recorrente_update', 'custo_recorrente', request.params.id, { changed_fields: Object.keys(d) })
      return fmtRecorrente(res.rows[0])
    })
  })

  // DELETE /v1/financeiro/custos-recorrentes/:id — lançamentos gerados ficam (recorrente_id → NULL)
  app.delete('/v1/financeiro/custos-recorrentes/:id', write, async (request, reply) => {
    if (!checarId(request, reply)) return
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const res = await db.query(
        'DELETE FROM custos_recorrentes WHERE id = $1::uuid AND tenant_id = $2::uuid RETURNING id',
        [request.params.id, tenant_id])
      if (!res.rows[0]) return reply.code(404).send({ error: 'Custo recorrente não encontrado' })
      auditar(app, request, 'financeiro.recorrente_delete', 'custo_recorrente', request.params.id)
      return { ok: true }
    })
  })
}
