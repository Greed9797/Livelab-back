// Custos manuais do financeiro: pontuais, recorrentes e parcelados.
// Permissões: READ_FINANCEIRO (GET) / WRITE_FINANCEIRO (demais). Registrar em src/app.js.
//
//   GET    /v1/financeiro/custos?mes=YYYY-MM | inicio=YYYY-MM&fim=YYYY-MM
//   POST   /v1/financeiro/custos                     (pontual)
//   POST   /v1/financeiro/custos/parcelado           (N parcelas)
//   POST   /v1/financeiro/custos/gerar?mes=YYYY-MM   (materializa recorrentes, idempotente)
//   PATCH  /v1/financeiro/custos/:id                 (aceita id virtual rec:<uuid>:<YYYY-MM>)
//   PATCH  /v1/financeiro/custos/:id/pagar | /desfazer
//   DELETE /v1/financeiro/custos/:id?escopo=um|grupo|futuras
//   GET/POST /v1/financeiro/custos-recorrentes ; PATCH/DELETE .../:id

import { z } from 'zod'
import { READ_FINANCEIRO, WRITE_FINANCEIRO } from '../config/role_groups.js'
import { moneySchema } from '../lib/money.js'
import {
  CUSTO_COLS, GRUPOS_CUSTO, RECORRENTE_COLS, custoParaItem, gerarCustosDoMes,
  listarCustos, materializarVirtual, mesValido, parseIdVirtual, planejarParcelas,
  primeiroDia, r2,
} from '../services/custos-plano.js'

export function hojeSaoPaulo(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now)
}

const dataSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato: YYYY-MM-DD')
const competenciaSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/, 'Formato: YYYY-MM ou YYYY-MM-DD')
const grupoSchema = z.enum(GRUPOS_CUSTO)
const positivo = moneySchema.refine((v) => v > 0, 'Valor deve ser positivo')
const normComp = (c) => primeiroDia(String(c).slice(0, 7))

const custoSchema = z.object({
  descricao: z.string().trim().min(1),
  valor: positivo,
  grupo: grupoSchema.default('diversos'),
  competencia: competenciaSchema.optional(),
  data_vencimento: dataSchema.optional(),
  observacao: z.string().nullish(),
  valor_pago: moneySchema.nullish(),
  data_pagamento: dataSchema.nullish(),
}).refine((d) => d.competencia || d.data_vencimento, { message: 'Informe competencia ou data_vencimento' })

const custoPatchSchema = z.object({
  descricao: z.string().trim().min(1),
  valor: positivo,
  grupo: grupoSchema,
  competencia: competenciaSchema,
  data_vencimento: dataSchema.nullable(),
  observacao: z.string().nullable(),
}).partial().refine((d) => Object.keys(d).length > 0, { message: 'Nada para atualizar' })

const parceladoSchema = z.object({
  descricao: z.string().trim().min(1),
  parcelas: z.number().int().min(1).max(120),
  valor_total: positivo.optional(),
  valor_parcela: positivo.optional(),
  grupo: grupoSchema.default('cartao'),
  competencia: competenciaSchema.optional(),
  data_vencimento: dataSchema.optional(),
  observacao: z.string().nullish(),
}).refine((d) => (d.valor_total != null) !== (d.valor_parcela != null), { message: 'Informe valor_total OU valor_parcela' })
  .refine((d) => d.competencia || d.data_vencimento, { message: 'Informe competencia ou data_vencimento' })

const pagarSchema = z.object({
  valor_pago: moneySchema.refine((v) => v > 0, 'valor_pago deve ser positivo').optional(),
  data_pagamento: dataSchema.optional(),
}).default({})

const recorrenteSchema = z.object({
  nome: z.string().trim().min(1),
  descricao: z.string().nullish(),
  grupo: grupoSchema.default('estrutural'),
  valor: moneySchema,
  dia_vencimento: z.number().int().min(1).max(31).default(5),
  mes_offset: z.number().int().min(0).max(1).default(0),
  inicio: dataSchema,
  fim: dataSchema.nullish(),
  ativo: z.boolean().default(true),
}).refine((d) => !d.fim || d.fim >= d.inicio, { message: 'fim deve ser >= inicio' })

const recorrentePatchSchema = z.object({
  nome: z.string().trim().min(1),
  descricao: z.string().nullable(),
  grupo: grupoSchema,
  valor: moneySchema,
  dia_vencimento: z.number().int().min(1).max(31),
  mes_offset: z.number().int().min(0).max(1),
  inicio: dataSchema,
  fim: dataSchema.nullable(),
  ativo: z.boolean(),
}).partial().refine((d) => Object.keys(d).length > 0, { message: 'Nada para atualizar' })

const UUID = z.string().uuid()

function resolverPeriodoQuery(query, hoje) {
  const inicio = query.inicio ?? query.mes ?? hoje.slice(0, 7)
  const fim = query.fim ?? query.mes ?? inicio
  if (!mesValido(inicio) || !mesValido(fim) || fim < inicio) return { error: 'Período inválido (use YYYY-MM)' }
  return { inicio, fim }
}

function auditar(app, request, action, entity_type, entity_id, metadata) {
  app.audit?.log?.(request, { action, entity_type, entity_id, metadata })
    ?.catch?.((err) => app.log.error({ err }, 'audit log failed'))
}

export async function financeiroCustosRoutes(app) {
  const READ = { preHandler: app.requirePapel(READ_FINANCEIRO) }
  const WRITE = { preHandler: app.requirePapel(WRITE_FINANCEIRO) }

  // Resolve id real (materializa item virtual se necessário).
  async function resolverId(db, tenantId, rawId) {
    const v = parseIdVirtual(rawId)
    if (v) return materializarVirtual(db, { tenantId, recorrente_id: v.recorrente_id, mes: v.mes })
    return UUID.safeParse(rawId).success ? rawId : null
  }

  async function carregar(db, tenantId, id) {
    const r = await db.query(`SELECT ${CUSTO_COLS} FROM custos WHERE id = $1::uuid AND tenant_id = $2::uuid`, [id, tenantId])
    return r.rows[0] ?? null
  }

  app.get('/v1/financeiro/custos', READ, async (request, reply) => {
    const { tenant_id } = request.user
    const hoje = hojeSaoPaulo()
    const p = resolverPeriodoQuery(request.query ?? {}, hoje)
    if (p.error) return reply.code(400).send({ error: p.error })
    return app.withTenant(tenant_id, (db) => listarCustos(db, { tenantId: tenant_id, ...p, hoje }))
  })

  app.post('/v1/financeiro/custos', WRITE, async (request, reply) => {
    const parsed = custoSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const { tenant_id } = request.user
    const d = parsed.data
    const competencia = normComp(d.competencia ?? d.data_vencimento)
    const venc = d.data_vencimento ?? competencia
    const pago = d.valor_pago ?? null
    const dataPag = pago ? (d.data_pagamento ?? hojeSaoPaulo()) : null
    return app.withTenant(tenant_id, async (db) => {
      const r = await db.query(
        `INSERT INTO custos (tenant_id, descricao, valor, tipo, grupo, competencia, data_vencimento,
                             valor_pago, data_pagamento, observacao)
         VALUES ($1::uuid,$2,$3,'outros',$4,$5::date,$6::date,$7,$8::date,$9)
         RETURNING ${CUSTO_COLS}`,
        [tenant_id, d.descricao, r2(d.valor), d.grupo, competencia, venc, pago, dataPag, d.observacao ?? null],
      )
      auditar(app, request, 'financeiro.custo_create', 'custo', r.rows[0].id, { descricao: d.descricao, grupo: d.grupo, valor: d.valor })
      return reply.code(201).send(custoParaItem(r.rows[0], hojeSaoPaulo()))
    })
  })

  app.post('/v1/financeiro/custos/parcelado', WRITE, async (request, reply) => {
    const parsed = parceladoSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const { tenant_id } = request.user
    const d = parsed.data
    const plano = planejarParcelas({
      n: d.parcelas, valor_total: d.valor_total, valor_parcela: d.valor_parcela,
      competencia: d.competencia, data_vencimento: d.data_vencimento,
    })
    return app.withTenant(tenant_id, async (db) => {
      const grupoId = (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id
      const itens = []
      for (const p of plano) {
        const r = await db.query(
          `INSERT INTO custos (tenant_id, descricao, valor, tipo, grupo, competencia, data_vencimento,
                               parcela_grupo_id, parcela_num, parcelas_total, observacao)
           VALUES ($1::uuid,$2,$3,'parcela',$4,$5::date,$6::date,$7::uuid,$8,$9,$10)
           RETURNING ${CUSTO_COLS}`,
          [tenant_id, `${d.descricao} (${p.parcela_num}/${p.parcelas_total})`, p.valor, d.grupo,
            p.competencia, p.data_vencimento, grupoId, p.parcela_num, p.parcelas_total, d.observacao ?? null],
        )
        itens.push(custoParaItem(r.rows[0], hojeSaoPaulo()))
      }
      auditar(app, request, 'financeiro.custo_parcelado', 'custo', grupoId, { descricao: d.descricao, parcelas: d.parcelas })
      return reply.code(201).send({ parcela_grupo_id: grupoId, parcelas: itens })
    })
  })

  app.post('/v1/financeiro/custos/gerar', WRITE, async (request, reply) => {
    const mes = request.query?.mes ?? request.body?.mes
    if (!mesValido(mes)) return reply.code(400).send({ error: 'mes inválido (use YYYY-MM)' })
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const res = await gerarCustosDoMes(db, { tenantId: tenant_id, mes })
      auditar(app, request, 'financeiro.custos_gerar', 'custo', null, res)
      return res
    })
  })

  app.patch('/v1/financeiro/custos/:id', WRITE, async (request, reply) => {
    const parsed = custoPatchSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const { tenant_id } = request.user
    const d = parsed.data
    return app.withTenant(tenant_id, async (db) => {
      const id = await resolverId(db, tenant_id, request.params.id)
      if (!id) return reply.code(404).send({ error: 'Custo não encontrado' })
      const sets = []
      const params = [id, tenant_id]
      const add = (col, val, cast = '') => { params.push(val); sets.push(`${col} = $${params.length}${cast}`) }
      if (d.descricao !== undefined) add('descricao', d.descricao)
      if (d.valor !== undefined) add('valor', r2(d.valor))
      if (d.grupo !== undefined) add('grupo', d.grupo)
      if (d.competencia !== undefined) add('competencia', normComp(d.competencia), '::date')
      if (d.data_vencimento !== undefined) add('data_vencimento', d.data_vencimento, '::date')
      if (d.observacao !== undefined) add('observacao', d.observacao)
      const r = await db.query(
        `UPDATE custos SET ${sets.join(', ')}, atualizado_em = NOW()
          WHERE id = $1::uuid AND tenant_id = $2::uuid RETURNING ${CUSTO_COLS}`,
        params,
      )
      if (!r.rows[0]) return reply.code(404).send({ error: 'Custo não encontrado' })
      auditar(app, request, 'financeiro.custo_update', 'custo', id, d)
      return custoParaItem(r.rows[0], hojeSaoPaulo())
    })
  })

  app.patch('/v1/financeiro/custos/:id/pagar', WRITE, async (request, reply) => {
    const parsed = pagarSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const { tenant_id } = request.user
    const hoje = hojeSaoPaulo()
    return app.withTenant(tenant_id, async (db) => {
      const id = await resolverId(db, tenant_id, request.params.id)
      if (!id) return reply.code(404).send({ error: 'Custo não encontrado' })
      const r = await db.query(
        `UPDATE custos
            SET valor_pago = COALESCE($3::numeric, valor),
                data_pagamento = COALESCE($4::date, $5::date),
                atualizado_em = NOW()
          WHERE id = $1::uuid AND tenant_id = $2::uuid
          RETURNING ${CUSTO_COLS}`,
        [id, tenant_id, parsed.data.valor_pago ?? null, parsed.data.data_pagamento ?? null, hoje],
      )
      if (!r.rows[0]) return reply.code(404).send({ error: 'Custo não encontrado' })
      auditar(app, request, 'financeiro.custo_pagar', 'custo', id, parsed.data)
      return custoParaItem(r.rows[0], hoje)
    })
  })

  app.patch('/v1/financeiro/custos/:id/desfazer', WRITE, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const id = await resolverId(db, tenant_id, request.params.id)
      if (!id) return reply.code(404).send({ error: 'Custo não encontrado' })
      const r = await db.query(
        `UPDATE custos SET valor_pago = NULL, data_pagamento = NULL, atualizado_em = NOW()
          WHERE id = $1::uuid AND tenant_id = $2::uuid RETURNING ${CUSTO_COLS}`,
        [id, tenant_id],
      )
      if (!r.rows[0]) return reply.code(404).send({ error: 'Custo não encontrado' })
      auditar(app, request, 'financeiro.custo_desfazer', 'custo', id)
      return custoParaItem(r.rows[0], hojeSaoPaulo())
    })
  })

  app.delete('/v1/financeiro/custos/:id', WRITE, async (request, reply) => {
    const escopo = request.query?.escopo ?? 'um'
    if (!['um', 'grupo', 'futuras'].includes(escopo)) return reply.code(400).send({ error: 'escopo inválido' })
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      if (parseIdVirtual(request.params.id)) {
        return reply.code(400).send({ error: 'Lançamento recorrente não gerado: altere ou encerre o recorrente' })
      }
      if (!UUID.safeParse(request.params.id).success) return reply.code(404).send({ error: 'Custo não encontrado' })
      const atual = await carregar(db, tenant_id, request.params.id)
      if (!atual) return reply.code(404).send({ error: 'Custo não encontrado' })
      let r
      if (escopo !== 'um' && atual.parcela_grupo_id) {
        r = await db.query(
          `DELETE FROM custos
            WHERE tenant_id = $1::uuid AND parcela_grupo_id = $2::uuid
              AND ($3::text = 'grupo' OR parcela_num >= $4::int)
            RETURNING id`,
          [tenant_id, atual.parcela_grupo_id, escopo, atual.parcela_num],
        )
      } else {
        r = await db.query('DELETE FROM custos WHERE id = $1::uuid AND tenant_id = $2::uuid RETURNING id', [atual.id, tenant_id])
      }
      auditar(app, request, 'financeiro.custo_delete', 'custo', atual.id, { escopo, removidos: r.rows.length })
      return { ok: true, removidos: r.rows.length }
    })
  })

  // ─── Recorrentes ──────────────────────────────────────────────────────────
  const fmtRec = (r) => ({ ...r, valor: r2(r.valor) })

  app.get('/v1/financeiro/custos-recorrentes', READ, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const r = await db.query(
        `SELECT ${RECORRENTE_COLS} FROM custos_recorrentes WHERE tenant_id = $1::uuid ORDER BY ativo DESC, nome`,
        [tenant_id],
      )
      return r.rows.map(fmtRec)
    })
  })

  app.post('/v1/financeiro/custos-recorrentes', WRITE, async (request, reply) => {
    const parsed = recorrenteSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const { tenant_id } = request.user
    const d = parsed.data
    return app.withTenant(tenant_id, async (db) => {
      const r = await db.query(
        `INSERT INTO custos_recorrentes (tenant_id, nome, descricao, grupo, valor, dia_vencimento, mes_offset, inicio, fim, ativo)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10)
         RETURNING ${RECORRENTE_COLS}`,
        [tenant_id, d.nome, d.descricao ?? null, d.grupo, r2(d.valor), d.dia_vencimento, d.mes_offset, d.inicio, d.fim ?? null, d.ativo],
      )
      auditar(app, request, 'financeiro.custo_recorrente_create', 'custo_recorrente', r.rows[0].id, { nome: d.nome })
      return reply.code(201).send(fmtRec(r.rows[0]))
    })
  })

  app.patch('/v1/financeiro/custos-recorrentes/:id', WRITE, async (request, reply) => {
    const parsed = recorrentePatchSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    if (!UUID.safeParse(request.params.id).success) return reply.code(404).send({ error: 'Recorrente não encontrado' })
    const { tenant_id } = request.user
    const d = parsed.data
    return app.withTenant(tenant_id, async (db) => {
      const sets = []
      const params = [request.params.id, tenant_id]
      for (const [col, cast] of [['nome', ''], ['descricao', ''], ['grupo', ''], ['valor', ''], ['dia_vencimento', ''],
        ['mes_offset', ''], ['inicio', '::date'], ['fim', '::date'], ['ativo', '']]) {
        if (d[col] === undefined) continue
        params.push(col === 'valor' ? r2(d[col]) : d[col])
        sets.push(`${col} = $${params.length}${cast}`)
      }
      const r = await db.query(
        `UPDATE custos_recorrentes SET ${sets.join(', ')}, atualizado_em = NOW()
          WHERE id = $1::uuid AND tenant_id = $2::uuid RETURNING ${RECORRENTE_COLS}`,
        params,
      )
      if (!r.rows[0]) return reply.code(404).send({ error: 'Recorrente não encontrado' })
      const rec = r.rows[0]
      if (rec.fim && rec.fim < rec.inicio) return reply.code(400).send({ error: 'fim deve ser >= inicio' })
      auditar(app, request, 'financeiro.custo_recorrente_update', 'custo_recorrente', rec.id, d)
      return fmtRec(rec)
    })
  })

  app.delete('/v1/financeiro/custos-recorrentes/:id', WRITE, async (request, reply) => {
    if (!UUID.safeParse(request.params.id).success) return reply.code(404).send({ error: 'Recorrente não encontrado' })
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const r = await db.query(
        'DELETE FROM custos_recorrentes WHERE id = $1::uuid AND tenant_id = $2::uuid RETURNING id',
        [request.params.id, tenant_id],
      )
      if (!r.rows[0]) return reply.code(404).send({ error: 'Recorrente não encontrado' })
      auditar(app, request, 'financeiro.custo_recorrente_delete', 'custo_recorrente', request.params.id)
      return { ok: true }
    })
  })
}
