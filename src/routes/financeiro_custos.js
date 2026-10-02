// Custos manuais do financeiro: pontuais, recorrentes e parcelados.
// Permissões: READ_FINANCEIRO (GET) / WRITE_FINANCEIRO (demais). Registrar em src/app.js.
//
//   GET    /v1/financeiro/custos?mes=YYYY-MM | inicio=YYYY-MM&fim=YYYY-MM
//   POST   /v1/financeiro/custos                     (pontual)
//   POST   /v1/financeiro/custos/parcelado           (N parcelas)
//   POST   /v1/financeiro/custos/gerar?mes=YYYY-MM   (materializa recorrentes, idempotente)
//   PATCH  /v1/financeiro/custos/:id                 (aceita id virtual rec:<uuid>:<YYYY-MM>)
//   PATCH  /v1/financeiro/custos/:id/pagar | /desfazer   (custo cancelado → 409 no pagar)
//   PATCH  /v1/financeiro/custos/:id/cancelar { motivo? } | /reativar
//          (aceita rec:<uuid>:<YYYY-MM>: materializa e cancela só aquele mês; migration 173)
//   DELETE /v1/financeiro/custos/:id?escopo=um|grupo|futuras
//   POST   /v1/financeiro/custos/importar            (carga em massa idempotente; dry_run)
//   GET/POST /v1/financeiro/custos-recorrentes ; PATCH/DELETE .../:id
//
// classe_custo ('fixo' | 'variavel' | null) é OVERRIDE opcional da classe derivada
// (src/lib/custo-classe.js; migration 171). null = volta à regra derivada.

import { z } from 'zod'
import { READ_FINANCEIRO, WRITE_FINANCEIRO } from '../config/role_groups.js'
import { moneySchema } from '../lib/money.js'
import { CLASSES_CUSTO } from '../lib/custo-classe.js'
import {
  CUSTO_COLS, GRUPOS_CUSTO, RECORRENTE_COLS, cancelarCusto, custoParaItem, erroCustoCancelado,
  gerarCustosDoMes, listarCustos, materializarVirtual, mesValido, parseIdVirtual, planejarParcelas,
  primeiroDia, r2, reativarCusto,
} from '../services/custos-plano.js'
import { MOTIVO_MAX } from '../lib/lancamento-status.js'

export function hojeSaoPaulo(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now)
}

const dataSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato: YYYY-MM-DD')
const competenciaSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/, 'Formato: YYYY-MM ou YYYY-MM-DD')
const grupoSchema = z.enum(GRUPOS_CUSTO)
const classeSchema = z.enum(CLASSES_CUSTO, { error: "classe_custo deve ser 'fixo', 'variavel' ou null" })
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
  classe_custo: classeSchema.nullish(),
}).refine((d) => d.competencia || d.data_vencimento, { message: 'Informe competencia ou data_vencimento' })

const custoPatchSchema = z.object({
  descricao: z.string().trim().min(1),
  valor: positivo,
  grupo: grupoSchema,
  competencia: competenciaSchema,
  data_vencimento: dataSchema.nullable(),
  observacao: z.string().nullable(),
  classe_custo: classeSchema.nullable(),
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
  classe_custo: classeSchema.nullish(),
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
  classe_custo: classeSchema.nullish(),
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
  classe_custo: classeSchema.nullable(),
}).partial().refine((d) => Object.keys(d).length > 0, { message: 'Nada para atualizar' })

const UUID = z.string().uuid()

const motivoSchema = z.object({
  motivo: z.string().max(MOTIVO_MAX, `motivo deve ter no máximo ${MOTIVO_MAX} caracteres`).nullish(),
}).strict()

function responderErro(reply, error) {
  if (error?.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ code: error.code, error: error.message })
  throw error
}

// ─── Importação em massa ────────────────────────────────────────────────────
export const IMPORTAR_MAX_ITENS = 200

const importRecorrenteSchema = z.object({
  nome: z.string().trim().min(1),
  descricao: z.string().nullish(),
  grupo: grupoSchema,
  valor: moneySchema,
  dia_vencimento: z.number().int().min(1).max(31),
  mes_offset: z.number().int().min(0).max(1).default(0),
  inicio: dataSchema,
  fim: dataSchema.nullable(),
}).refine((d) => !d.fim || d.fim >= d.inicio, { message: 'fim deve ser >= inicio' })

const importPontualSchema = z.object({
  descricao: z.string().trim().min(1),
  grupo: grupoSchema,
  valor: positivo,
  data_vencimento: dataSchema,
  competencia: competenciaSchema,
  parcela_num: z.number().int().min(1).max(120).optional(),
  parcelas_total: z.number().int().min(1).max(120).optional(),
}).refine((d) => (d.parcela_num == null) === (d.parcelas_total == null), { message: 'Informe parcela_num e parcelas_total juntos' })
  .refine((d) => d.parcela_num == null || d.parcela_num <= d.parcelas_total, { message: 'parcela_num deve ser <= parcelas_total' })

export const importarSchema = z.object({
  recorrentes: z.array(importRecorrenteSchema).max(IMPORTAR_MAX_ITENS, `Máximo de ${IMPORTAR_MAX_ITENS} recorrentes`).default([]),
  pontuais: z.array(importPontualSchema).max(IMPORTAR_MAX_ITENS, `Máximo de ${IMPORTAR_MAX_ITENS} pontuais`).default([]),
  dry_run: z.boolean().default(false),
})

// "2 iPhones — parcela 1/4" / "Notebook (2/10)" → base comum para agrupar parcelas.
const baseParcela = (desc) => desc.replace(/\s*[—–-]?\s*(parcela\s*)?\(?\d+\/\d+\)?\s*$/i, '').trim().toLowerCase()

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
                             valor_pago, data_pagamento, observacao, classe_custo)
         VALUES ($1::uuid,$2,$3,'outros',$4,$5::date,$6::date,$7,$8::date,$9,$10)
         RETURNING ${CUSTO_COLS}`,
        [tenant_id, d.descricao, r2(d.valor), d.grupo, competencia, venc, pago, dataPag, d.observacao ?? null, d.classe_custo ?? null],
      )
      auditar(app, request, 'financeiro.custo_create', 'custo', r.rows[0].id, { descricao: d.descricao, grupo: d.grupo, valor: d.valor, classe_custo: d.classe_custo ?? null })
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
                               parcela_grupo_id, parcela_num, parcelas_total, observacao, classe_custo)
           VALUES ($1::uuid,$2,$3,'parcela',$4,$5::date,$6::date,$7::uuid,$8,$9,$10,$11)
           RETURNING ${CUSTO_COLS}`,
          [tenant_id, `${d.descricao} (${p.parcela_num}/${p.parcelas_total})`, p.valor, d.grupo,
            p.competencia, p.data_vencimento, grupoId, p.parcela_num, p.parcelas_total, d.observacao ?? null, d.classe_custo ?? null],
        )
        itens.push(custoParaItem(r.rows[0], hojeSaoPaulo()))
      }
      auditar(app, request, 'financeiro.custo_parcelado', 'custo', grupoId, { descricao: d.descricao, parcelas: d.parcelas })
      return reply.code(201).send({ parcela_grupo_id: grupoId, parcelas: itens })
    })
  })

  // Idempotente: item já existente (pela chave natural) é ignorado, nunca alterado.
  app.post('/v1/financeiro/custos/importar', WRITE, async (request, reply) => {
    const parsed = importarSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const { tenant_id } = request.user
    const { recorrentes, pontuais, dry_run: dryRun } = parsed.data
    return app.withTenant(tenant_id, async (db) => {
      const relRec = { criados: 0, ignorados: 0, itens: [] }
      const relPon = { criados: 0, ignorados: 0, itens: [] }
      const vistos = new Set()

      for (const d of recorrentes) {
        const chave = `r|${d.nome.toLowerCase()}|${d.grupo}|${d.dia_vencimento}`
        let existe = vistos.has(chave)
        if (!existe) {
          const r = await db.query(
            `SELECT id FROM custos_recorrentes
              WHERE tenant_id = $1::uuid AND lower(nome) = lower($2) AND grupo = $3 AND dia_vencimento = $4
              LIMIT 1`,
            [tenant_id, d.nome, d.grupo, d.dia_vencimento],
          )
          existe = r.rows.length > 0
        }
        vistos.add(chave)
        if (existe) { relRec.ignorados++; relRec.itens.push({ nome: d.nome, acao: 'ignorado' }); continue }
        if (!dryRun) {
          await db.query(
            `INSERT INTO custos_recorrentes (tenant_id, nome, descricao, grupo, valor, dia_vencimento, mes_offset, inicio, fim, ativo)
             VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::date,$9::date,true)`,
            [tenant_id, d.nome, d.descricao ?? null, d.grupo, r2(d.valor), d.dia_vencimento, d.mes_offset, d.inicio, d.fim ?? null],
          )
        }
        relRec.criados++
        relRec.itens.push({ nome: d.nome, acao: 'criado' })
      }

      const grupos = new Map()
      for (const d of pontuais) {
        const valor = r2(d.valor)
        const chave = `p|${d.descricao}|${d.data_vencimento}|${valor}`
        let existe = vistos.has(chave)
        if (!existe) {
          const r = await db.query(
            `SELECT id FROM custos
              WHERE tenant_id = $1::uuid AND descricao = $2 AND data_vencimento = $3::date AND valor = $4::numeric
              LIMIT 1`,
            [tenant_id, d.descricao, d.data_vencimento, valor],
          )
          existe = r.rows.length > 0
        }
        vistos.add(chave)
        if (existe) { relPon.ignorados++; relPon.itens.push({ descricao: d.descricao, acao: 'ignorado' }); continue }
        if (!dryRun) {
          const competencia = normComp(d.competencia)
          if (d.parcela_num != null) {
            const gk = `${baseParcela(d.descricao)}|${d.grupo}|${d.parcelas_total}`
            if (!grupos.has(gk)) grupos.set(gk, (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id)
            await db.query(
              `INSERT INTO custos (tenant_id, descricao, valor, tipo, grupo, competencia, data_vencimento,
                                   parcela_grupo_id, parcela_num, parcelas_total)
               VALUES ($1::uuid,$2,$3,'parcela',$4,$5::date,$6::date,$7::uuid,$8,$9)`,
              [tenant_id, d.descricao, valor, d.grupo, competencia, d.data_vencimento, grupos.get(gk), d.parcela_num, d.parcelas_total],
            )
          } else {
            await db.query(
              `INSERT INTO custos (tenant_id, descricao, valor, tipo, grupo, competencia, data_vencimento)
               VALUES ($1::uuid,$2,$3,'outros',$4,$5::date,$6::date)`,
              [tenant_id, d.descricao, valor, d.grupo, competencia, d.data_vencimento],
            )
          }
        }
        relPon.criados++
        relPon.itens.push({ descricao: d.descricao, acao: 'criado' })
      }

      const res = { dry_run: dryRun, recorrentes: relRec, pontuais: relPon }
      if (!dryRun) {
        auditar(app, request, 'financeiro.custos_importar', 'custo', null, {
          recorrentes: { criados: relRec.criados, ignorados: relRec.ignorados },
          pontuais: { criados: relPon.criados, ignorados: relPon.ignorados },
        })
      }
      return res
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
      if (d.classe_custo !== undefined) add('classe_custo', d.classe_custo)
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
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND cancelado_em IS NULL
          RETURNING ${CUSTO_COLS}`,
        [id, tenant_id, parsed.data.valor_pago ?? null, parsed.data.data_pagamento ?? null, hoje],
      )
      if (!r.rows[0]) {
        if (await carregar(db, tenant_id, id)) return responderErro(reply, erroCustoCancelado())
        return reply.code(404).send({ error: 'Custo não encontrado' })
      }
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

  // Cancelar: sai do a pagar e do previsto; linha preservada. rec:<uuid>:<YYYY-MM> materializa só o mês.
  app.patch('/v1/financeiro/custos/:id/cancelar', WRITE, async (request, reply) => {
    const parsed = motivoSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const { tenant_id, sub } = request.user
    return app.withTenant(tenant_id, async (db) => {
      try {
        const id = await resolverId(db, tenant_id, request.params.id)
        if (!id) return reply.code(404).send({ error: 'Custo não encontrado' })
        const res = await cancelarCusto(db, { tenantId: tenant_id, id, motivo: parsed.data.motivo, actorUserId: sub ?? null })
        if (!res) return reply.code(404).send({ error: 'Custo não encontrado' })
        const item = custoParaItem(res.row, hojeSaoPaulo())
        auditar(app, request, 'financeiro.custo_cancelar', 'custo', id, {
          id_informado: request.params.id, motivo: item.cancelado_motivo, ja_cancelado: res.ja_cancelado,
          valor_previsto: item.valor_previsto, valor_pago: item.valor_pago,
        })
        return item
      } catch (error) {
        return responderErro(reply, error)
      }
    })
  })

  app.patch('/v1/financeiro/custos/:id/reativar', WRITE, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      try {
        // Reativar nunca materializa: rec: sem linha gerada nunca foi cancelado → devolve o virtual.
        const v = parseIdVirtual(request.params.id)
        let id = UUID.safeParse(request.params.id).success ? request.params.id : null
        if (v) {
          const got = await db.query(
            'SELECT id FROM custos WHERE tenant_id = $1::uuid AND recorrente_id = $2::uuid AND competencia = $3::date',
            [tenant_id, v.recorrente_id, primeiroDia(v.mes)],
          )
          id = got.rows[0]?.id ?? null
          if (!id) {
            const itens = await listarCustos(db, { tenantId: tenant_id, inicio: v.mes, fim: v.mes, hoje: hojeSaoPaulo() })
            const virtual = itens.find((i) => i.id === request.params.id)
            return virtual ?? reply.code(404).send({ error: 'Custo não encontrado' })
          }
        }
        if (!id) return reply.code(404).send({ error: 'Custo não encontrado' })
        const res = await reativarCusto(db, { tenantId: tenant_id, id })
        if (!res) return reply.code(404).send({ error: 'Custo não encontrado' })
        auditar(app, request, 'financeiro.custo_reativar', 'custo', id, {
          id_informado: request.params.id, estava_cancelado: res.estava_cancelado,
        })
        return custoParaItem(res.row, hojeSaoPaulo())
      } catch (error) {
        return responderErro(reply, error)
      }
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
        `INSERT INTO custos_recorrentes (tenant_id, nome, descricao, grupo, valor, dia_vencimento, mes_offset, inicio, fim, ativo, classe_custo)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10,$11)
         RETURNING ${RECORRENTE_COLS}`,
        [tenant_id, d.nome, d.descricao ?? null, d.grupo, r2(d.valor), d.dia_vencimento, d.mes_offset, d.inicio, d.fim ?? null, d.ativo, d.classe_custo ?? null],
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
        ['mes_offset', ''], ['inicio', '::date'], ['fim', '::date'], ['ativo', ''], ['classe_custo', '']]) {
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
