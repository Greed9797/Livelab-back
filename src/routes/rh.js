import { z } from 'zod'
import { READ_RH, WRITE_RH } from '../config/role_groups.js'
import { moneySchema } from '../lib/money.js'

const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/
const STATUS_VALUES = ['ativo', 'inativo', 'ferias', 'afastado']
const CONTRATO_VALUES = ['clt', 'pj', 'estagio', 'freelancer']

export function competenciaDoMes(mes) {
  return `${mes}-01`
}

function dataCalendarioValida(value) {
  if (!DATA_RE.test(value)) return false
  const [ano, mes, dia] = value.split('-').map(Number)
  const data = new Date(Date.UTC(ano, mes - 1, dia))
  return data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia
}

const dataSchema = z.string()
  .refine(dataCalendarioValida, 'Data inválida (YYYY-MM-DD).')
  .nullable()
  .optional()

const colaboradorSchema = z.object({
  nome: z.string({ error: 'Nome é obrigatório' }).trim().min(1, 'Nome é obrigatório'),
  cargo: z.string().optional(),
  setor: z.string().optional(),
  email: z.string().optional(),
  telefone: z.string().optional(),
  cpf: z.string().optional(),
  observacoes: z.string().optional(),
  data_nascimento: dataSchema,
  data_admissao: dataSchema,
  data_desligamento: dataSchema,
  salario_fixo: moneySchema.default(0),
  comissao_pct: z.number().min(0).max(100).default(0),
  ativo: z.boolean().optional(),
  status: z.enum(STATUS_VALUES).optional(),
  tipo_contrato: z.enum(CONTRATO_VALUES).default('clt'),
  centro_custo: z.array(z.string().trim().min(1)).nullable().optional(),
  responsavel_id: z.string().uuid().nullable().optional(),
  ote_comissao: z.string().max(300).nullable().optional(),
  chave_pix: z.string().max(300).nullable().optional(),
})

// PATCH não herda defaults do create: campo omitido não pode virar salário 0.
const colaboradorUpdateSchema = z.object({
  nome: z.string({ error: 'Nome é obrigatório' }).trim().min(1, 'Nome é obrigatório').optional(),
  cargo: z.string().optional(),
  setor: z.string().optional(),
  email: z.string().optional(),
  telefone: z.string().optional(),
  cpf: z.string().optional(),
  observacoes: z.string().optional(),
  data_nascimento: dataSchema,
  data_admissao: dataSchema,
  data_desligamento: dataSchema,
  salario_fixo: moneySchema.optional(),
  comissao_pct: z.number().min(0).max(100).optional(),
  ativo: z.boolean().optional(),
  status: z.enum(STATUS_VALUES).optional(),
  tipo_contrato: z.enum(CONTRATO_VALUES).optional(),
  centro_custo: z.array(z.string().trim().min(1)).nullable().optional(),
  responsavel_id: z.string().uuid().nullable().optional(),
  ote_comissao: z.string().max(300).nullable().optional(),
  chave_pix: z.string().max(300).nullable().optional(),
})

// Whitelist: chave de coluna nunca vem do cliente.
const COLABORADOR_COLS = new Set([
  'nome', 'cargo', 'setor', 'email', 'telefone', 'cpf', 'observacoes',
  'data_nascimento', 'data_admissao', 'data_desligamento', 'salario_fixo',
  'comissao_pct', 'ativo', 'status', 'tipo_contrato', 'centro_custo',
  'responsavel_id', 'ote_comissao', 'chave_pix',
])

const folhaBodySchema = z.object({
  mes: z.string().regex(MES_RE, 'Mês inválido (YYYY-MM).'),
  salario_fixo: moneySchema.optional(),
  meta_valor: moneySchema.optional(),
  meta_realizado: moneySchema.optional(),
  comissao: moneySchema.optional(),
  bonus: moneySchema.optional(),
  descontos: moneySchema.optional(),
  observacoes: z.string().nullable().optional(),
})

const statusSchema = z.object({
  status: z.enum(['rascunho', 'fechado', 'pago'], { message: 'Status inválido.' }),
})

const TOTAIS_ZERO = {
  salario_fixo: 0,
  meta_valor: 0,
  meta_realizado: 0,
  comissao: 0,
  bonus: 0,
  descontos: 0,
  total: 0,
}

export async function rhRoutes(app) {
  // GET /v1/rh/colaboradores
  app.get('/v1/rh/colaboradores', { preHandler: app.requirePapel(READ_RH) }, async (request) => {
    const tenantId = request.user.tenant_id
    const includeInactive = String(request.query?.include_inactive ?? '').toLowerCase() === 'true'
    return app.withTenant(tenantId, async (db) => {
      const { rows } = await db.query(
        `SELECT id, tenant_id, nome, cargo, setor, email, telefone, cpf,
                data_nascimento, data_admissao, data_desligamento, salario_fixo,
                comissao_pct, ativo, observacoes, criado_em, atualizado_em,
                status, tipo_contrato, centro_custo, responsavel_id,
                ote_comissao, chave_pix
           FROM rh_colaboradores
          WHERE tenant_id = $1::uuid
            ${includeInactive ? '' : "AND status <> 'inativo'"}
          ORDER BY ativo DESC, nome ASC`,
        [tenantId],
      )
      return rows
    })
  })

  // POST /v1/rh/colaboradores
  app.post('/v1/rh/colaboradores', { preHandler: app.requirePapel(WRITE_RH) }, async (request, reply) => {
    const parsed = colaboradorSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data
    const tenantId = request.user.tenant_id
    const status = d.status ?? (d.ativo === false ? 'inativo' : 'ativo')
    const ativo = d.ativo ?? status !== 'inativo'

    const row = await app.withTenant(tenantId, async (db) => {
      const result = await db.query(
        `INSERT INTO rh_colaboradores
           (tenant_id, nome, cargo, setor, email, telefone, cpf,
            data_nascimento, data_admissao, data_desligamento, salario_fixo,
            comissao_pct, ativo, observacoes,
            status, tipo_contrato, centro_custo, responsavel_id, ote_comissao, chave_pix)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10::date, $11, $12, $13, $14,
                 $15, $16, $17, $18::uuid, $19, $20)
         RETURNING *`,
        [
          tenantId, d.nome, d.cargo ?? null, d.setor ?? null, d.email ?? null,
          d.telefone ?? null, d.cpf ?? null, d.data_nascimento ?? null,
          d.data_admissao ?? null, d.data_desligamento ?? null,
          d.salario_fixo ?? 0, d.comissao_pct ?? 0, ativo, d.observacoes ?? null,
          status, d.tipo_contrato ?? 'clt', d.centro_custo ?? null,
          d.responsavel_id ?? null, d.ote_comissao ?? null, d.chave_pix ?? null,
        ],
      )
      return result.rows[0]
    })

    app.audit?.log?.(request, {
      action: 'rh.colaborador_create',
      entity_type: 'rh_colaborador',
      entity_id: row?.id ?? null,
      metadata: { nome: d.nome },
    })?.catch?.((err) => app.log.error({ err }, 'audit log rh.colaborador_create failed'))

    return reply.code(201).send(row)
  })

  // PATCH /v1/rh/colaboradores/:id
  app.patch('/v1/rh/colaboradores/:id', { preHandler: app.requirePapel(WRITE_RH) }, async (request, reply) => {
    const id = String(request.params?.id ?? '')
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: 'Colaborador não encontrado.' })

    const parsed = colaboradorUpdateSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const updatesObj = { ...parsed.data }
    if ('status' in updatesObj || 'ativo' in updatesObj) {
      if ('status' in updatesObj) {
        updatesObj.ativo = updatesObj.status !== 'inativo'
      } else {
        updatesObj.status = updatesObj.ativo ? 'ativo' : 'inativo'
      }
    }
    if (updatesObj.responsavel_id === id) {
      return reply.code(400).send({ error: 'Colaborador não pode ser responsável por si mesmo.' })
    }
    const updates = Object.entries(updatesObj).filter(([key]) => COLABORADOR_COLS.has(key))
    if (updates.length === 0) return reply.code(400).send({ error: 'Nenhum campo para atualizar.' })

    const tenantId = request.user.tenant_id
    const set = updates.map(([key], index) => `${key} = $${index + 3}`).join(', ')
    const values = [id, tenantId, ...updates.map(([, value]) => value)]

    const outcome = await app.withTenant(tenantId, async (db) => {
      if (updatesObj.responsavel_id) {
        const { rows } = await db.query(
          `SELECT id, responsavel_id FROM rh_colaboradores WHERE tenant_id = $1::uuid`,
          [tenantId],
        )
        const porId = new Map(rows.map((linha) => [linha.id, linha.responsavel_id]))
        const vistos = new Set()
        let atual = updatesObj.responsavel_id
        while (atual) {
          if (atual === id) return { cycle: true }
          if (vistos.has(atual) || !porId.has(atual)) break
          vistos.add(atual)
          atual = porId.get(atual)
        }
      }

      const result = await db.query(
        `UPDATE rh_colaboradores
            SET ${set}, atualizado_em = NOW()
          WHERE id = $1::uuid AND tenant_id = $2::uuid
          RETURNING *`,
        values,
      )
      return { row: result.rows[0] ?? null }
    })
    if (outcome.cycle) return reply.code(400).send({ error: 'Vínculo criaria um ciclo de gestão.' })
    if (!outcome.row) return reply.code(404).send({ error: 'Colaborador não encontrado.' })

    app.audit?.log?.(request, {
      action: 'rh.colaborador_update',
      entity_type: 'rh_colaborador',
      entity_id: id,
      metadata: { changed_fields: updates.map(([key]) => key) },
    })?.catch?.((err) => app.log.error({ err }, 'audit log rh.colaborador_update failed'))

    return outcome.row
  })

  // DELETE /v1/rh/colaboradores/:id — soft delete
  app.delete('/v1/rh/colaboradores/:id', { preHandler: app.requirePapel(WRITE_RH) }, async (request, reply) => {
    const id = String(request.params?.id ?? '')
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: 'Colaborador não encontrado.' })

    const tenantId = request.user.tenant_id
    const row = await app.withTenant(tenantId, async (db) => {
      const result = await db.query(
        `UPDATE rh_colaboradores
            SET ativo = false, status = 'inativo', atualizado_em = NOW()
          WHERE id = $1::uuid AND tenant_id = $2::uuid
          RETURNING id`,
        [id, tenantId],
      )
      return result.rows[0] ?? null
    })
    if (!row) return reply.code(404).send({ error: 'Colaborador não encontrado.' })

    app.audit?.log?.(request, {
      action: 'rh.colaborador_delete',
      entity_type: 'rh_colaborador',
      entity_id: id,
      metadata: { soft_delete: true },
    })?.catch?.((err) => app.log.error({ err }, 'audit log rh.colaborador_delete failed'))

    return reply.code(204).send()
  })

  // GET /v1/rh/folha?mes=YYYY-MM
  app.get('/v1/rh/folha', { preHandler: app.requirePapel(READ_RH) }, async (request, reply) => {
    const mes = String(request.query?.mes ?? '')
    if (!MES_RE.test(mes)) return reply.code(400).send({ error: 'Mês inválido (YYYY-MM).' })
    const tenantId = request.user.tenant_id

    const rows = await app.withTenant(tenantId, async (db) => {
      const result = await db.query(
        `SELECT c.id AS colaborador_id, c.nome, c.cargo, c.setor, c.ativo,
                f.id AS folha_id, f.competencia::text AS competencia,
                COALESCE(f.salario_fixo, c.salario_fixo) AS salario_fixo,
                COALESCE(f.meta_valor, 0) AS meta_valor,
                COALESCE(f.meta_realizado, 0) AS meta_realizado,
                COALESCE(f.comissao, 0) AS comissao,
                COALESCE(f.bonus, 0) AS bonus,
                COALESCE(f.descontos, 0) AS descontos,
                COALESCE(f.total, c.salario_fixo) AS total,
                f.status, f.observacoes
           FROM rh_colaboradores c
           LEFT JOIN rh_folha_mensal f
             ON f.colaborador_id = c.id AND f.tenant_id = c.tenant_id AND f.competencia = $2::date
          WHERE c.tenant_id = $1::uuid AND (c.status <> 'inativo' OR f.id IS NOT NULL)
          ORDER BY c.nome ASC`,
        [tenantId, competenciaDoMes(mes)],
      )
      return result.rows
    })

    const totais = rows.reduce((acc, row) => {
      for (const key of Object.keys(TOTAIS_ZERO)) acc[key] += Number(row[key] ?? 0)
      return acc
    }, { ...TOTAIS_ZERO })

    return { mes, colaboradores: rows, totais }
  })

  // PUT /v1/rh/folha/:colaboradorId
  app.put('/v1/rh/folha/:colaboradorId', { preHandler: app.requirePapel(WRITE_RH) }, async (request, reply) => {
    const colaboradorId = String(request.params?.colaboradorId ?? '')
    if (!UUID_RE.test(colaboradorId)) return reply.code(400).send({ error: 'Colaborador inválido.' })

    const parsed = folhaBodySchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const d = parsed.data
    const competencia = competenciaDoMes(d.mes)
    const tenantId = request.user.tenant_id

    const outcome = await app.withTenant(tenantId, async (db) => {
      const existente = await db.query(
        `SELECT status FROM rh_folha_mensal
          WHERE tenant_id = $1::uuid AND colaborador_id = $2::uuid AND competencia = $3::date`,
        [tenantId, colaboradorId, competencia],
      )
      if (existente.rows[0]?.status === 'pago') return { conflict: true }

      const colaborador = await db.query(
        `SELECT salario_fixo FROM rh_colaboradores
          WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [colaboradorId, tenantId],
      )
      if (!colaborador.rows[0]) return { notFound: true }

      const salarioFixo = d.salario_fixo ?? Number(colaborador.rows[0].salario_fixo ?? 0)
      const result = await db.query(
        `INSERT INTO rh_folha_mensal
           (tenant_id, colaborador_id, competencia, salario_fixo, meta_valor, meta_realizado,
            comissao, bonus, descontos, observacoes, criado_por)
         VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, $7, $8, $9, $10, $11::uuid)
         ON CONFLICT (tenant_id, colaborador_id, competencia) DO UPDATE SET
           salario_fixo = EXCLUDED.salario_fixo,
           meta_valor = EXCLUDED.meta_valor,
           meta_realizado = EXCLUDED.meta_realizado,
           comissao = EXCLUDED.comissao,
           bonus = EXCLUDED.bonus,
           descontos = EXCLUDED.descontos,
           observacoes = EXCLUDED.observacoes,
           atualizado_em = NOW()
         WHERE rh_folha_mensal.status <> 'pago'
         RETURNING *`,
        [
          tenantId, colaboradorId, competencia, salarioFixo,
          d.meta_valor ?? 0, d.meta_realizado ?? 0, d.comissao ?? 0,
          d.bonus ?? 0, d.descontos ?? 0, d.observacoes ?? null,
          request.user.sub ?? null,
        ],
      )
      return { row: result.rows[0] ?? null }
    })

    if (outcome.conflict) return reply.code(409).send({ error: 'Folha paga não pode ser editada.' })
    if (outcome.notFound) return reply.code(404).send({ error: 'Colaborador não encontrado.' })
    if (!outcome.row) return reply.code(409).send({ error: 'Folha paga não pode ser editada.' })

    app.audit?.log?.(request, {
      action: 'rh.folha_upsert',
      entity_type: 'rh_folha_mensal',
      entity_id: outcome.row.id,
      metadata: { colaborador_id: colaboradorId, competencia },
    })?.catch?.((err) => app.log.error({ err }, 'audit log rh.folha_upsert failed'))

    return outcome.row
  })

  // PATCH /v1/rh/folha/:id/status
  app.patch('/v1/rh/folha/:id/status', { preHandler: app.requirePapel(WRITE_RH) }, async (request, reply) => {
    const id = String(request.params?.id ?? '')
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: 'Folha não encontrada.' })

    const parsed = statusSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const status = parsed.data.status
    const tenantId = request.user.tenant_id

    const row = await app.withTenant(tenantId, async (db) => {
      const result = await db.query(
        `UPDATE rh_folha_mensal
            SET status = $3,
                fechado_em = CASE WHEN $3 = 'fechado' THEN NOW() ELSE fechado_em END,
                pago_em = CASE WHEN $3 = 'pago' THEN NOW() ELSE pago_em END,
                atualizado_em = NOW()
          WHERE id = $1::uuid AND tenant_id = $2::uuid
          RETURNING *`,
        [id, tenantId, status],
      )
      return result.rows[0] ?? null
    })
    if (!row) return reply.code(404).send({ error: 'Folha não encontrada.' })

    app.audit?.log?.(request, {
      action: 'rh.folha_status',
      entity_type: 'rh_folha_mensal',
      entity_id: id,
      metadata: { status },
    })?.catch?.((err) => app.log.error({ err }, 'audit log rh.folha_status failed'))

    return row
  })
}
