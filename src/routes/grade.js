import { z } from 'zod'
import { READ_AGENDA, WRITE_AGENDA } from '../config/role_groups.js'

// Grade visual de agenda por cabine — 100% desacoplada de agenda_eventos/lives.
// grade_padrao = template semanal (dia_semana 0=domingo, convenção extract(dow)
// do Postgres e Date.getDay()); grade_excecoes = overrides por data.
// Resolução de um dia D: padrão do dow(D) + exceções de D por cima (match
// cabine_id + hora_inicio); exceção com marca_id NULL apaga a célula.

const MAX_INTERVALO_DIAS = 62

const horaSchema = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Hora inválida (HH:MM)')
const dataSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (YYYY-MM-DD)')

const diaSemanaSchema = z.number().int().min(0).max(6)

// `dias_semana` aplica a mesma célula a vários dias da semana numa só requisição
// (usado pela aba "Seg–Sex" da grade). `dia_semana` single segue aceito.
const padraoUpsertSchema = z.object({
  dia_semana: diaSemanaSchema.optional(),
  dias_semana: z.array(diaSemanaSchema).min(1).optional(),
  cabine_id: z.string().uuid(),
  hora_inicio: horaSchema,
  hora_fim: horaSchema,
  marca_id: z.string().uuid(),
  apresentadora_id: z.string().uuid().nullable().optional(),
  observacao: z.string().nullable().optional(),
}).refine((d) => normalizeHora(d.hora_fim) > normalizeHora(d.hora_inicio), {
  message: 'hora_fim deve ser maior que hora_inicio',
}).refine((d) => d.dia_semana !== undefined || (d.dias_semana?.length ?? 0) > 0, {
  message: 'Informe dia_semana ou dias_semana',
})

const padraoDeleteSchema = z.object({
  dia_semana: z.coerce.number().int().min(0).max(6).optional(),
  // Query string: ?dias_semana=1,2,3,4,5
  dias_semana: z.string().optional(),
  cabine_id: z.string().uuid(),
  hora_inicio: horaSchema,
}).refine((d) => d.dia_semana !== undefined || Boolean(d.dias_semana), {
  message: 'Informe dia_semana ou dias_semana',
})

/** dia_semana single ou dias_semana[] → lista única e ordenada de dows. */
function resolveDows({ dia_semana, dias_semana }) {
  const raw = Array.isArray(dias_semana)
    ? dias_semana
    : typeof dias_semana === 'string' && dias_semana
      ? dias_semana.split(',').map((v) => Number(v.trim()))
      : []
  const all = raw.length ? raw : [dia_semana]
  return [...new Set(all.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
}

const excecaoUpsertSchema = z.object({
  data: dataSchema,
  cabine_id: z.string().uuid(),
  hora_inicio: horaSchema,
  hora_fim: horaSchema,
  marca_id: z.string().uuid().nullable(), // NULL = célula vazia neste dia
  apresentadora_id: z.string().uuid().nullable().optional(),
  observacao: z.string().nullable().optional(),
}).refine((d) => normalizeHora(d.hora_fim) > normalizeHora(d.hora_inicio), {
  message: 'hora_fim deve ser maior que hora_inicio',
})

const excecaoDeleteSchema = z.object({
  data: dataSchema,
  cabine_id: z.string().uuid(),
  hora_inicio: horaSchema,
})

const copiarDiaSchema = z.object({
  data_origem: dataSchema,
  data_destino: dataSchema,
}).refine((d) => d.data_origem !== d.data_destino, {
  message: 'data_origem e data_destino devem ser diferentes',
})

const gradeQuerySchema = z.object({
  data_inicio: dataSchema,
  data_fim: dataSchema,
  marca_id: z.string().uuid().optional(),
  apresentadora_id: z.string().uuid().optional(),
}).refine((d) => d.data_fim >= d.data_inicio, {
  message: 'data_fim deve ser igual ou posterior a data_inicio',
})

// "08:00:00" | "08:00" → "08:00" (chave de match e formato de resposta)
function normalizeHora(hora) {
  return String(hora).slice(0, 5)
}

// DATE do pg pode vir como string 'YYYY-MM-DD' (padrão do projeto) ou Date.
function normalizeData(data) {
  if (data instanceof Date) {
    // DATE sem TZ: componentes UTC preservam o dia gravado
    return data.toISOString().slice(0, 10)
  }
  return String(data).slice(0, 10)
}

// Itera dias [inicio, fim] como strings YYYY-MM-DD via UTC (imune a DST local)
function listarDias(dataInicio, dataFim) {
  const dias = []
  const cursor = new Date(`${dataInicio}T00:00:00Z`)
  const fim = new Date(`${dataFim}T00:00:00Z`)
  while (cursor <= fim) {
    dias.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dias
}

function diaSemanaDe(dataStr) {
  return new Date(`${dataStr}T00:00:00Z`).getUTCDay()
}

function celulaFromRow(row, origem) {
  return {
    cabine_id: row.cabine_id,
    cabine_numero: row.cabine_numero,
    hora_inicio: normalizeHora(row.hora_inicio),
    hora_fim: normalizeHora(row.hora_fim),
    marca_id: row.marca_id,
    marca_nome: row.marca_nome,
    marca_logo_url: row.marca_logo_url ?? null,
    apresentadora_id: row.apresentadora_id,
    apresentadora_nome: row.apresentadora_nome,
    origem,
    observacao: row.observacao ?? null,
  }
}

const PADRAO_SELECT = `
  SELECT gp.*,
         m.nome AS marca_nome,
         m.logo_url AS marca_logo_url,
         a.nome AS apresentadora_nome,
         c.numero AS cabine_numero
  FROM grade_padrao gp
  JOIN marcas m ON m.id = gp.marca_id AND m.tenant_id = gp.tenant_id
  JOIN cabines c ON c.id = gp.cabine_id AND c.tenant_id = gp.tenant_id
  LEFT JOIN apresentadoras a ON a.id = gp.apresentadora_id AND a.tenant_id = gp.tenant_id
  WHERE gp.tenant_id = $1::uuid`

const EXCECOES_SELECT = `
  SELECT ge.*,
         m.nome AS marca_nome,
         m.logo_url AS marca_logo_url,
         a.nome AS apresentadora_nome,
         c.numero AS cabine_numero
  FROM grade_excecoes ge
  LEFT JOIN marcas m ON m.id = ge.marca_id AND m.tenant_id = ge.tenant_id
  JOIN cabines c ON c.id = ge.cabine_id AND c.tenant_id = ge.tenant_id
  LEFT JOIN apresentadoras a ON a.id = ge.apresentadora_id AND a.tenant_id = ge.tenant_id
  WHERE ge.tenant_id = $1::uuid
    AND ge.data BETWEEN $2::date AND $3::date`

// Merge padrão + exceções de um dia. Retorna células ordenadas por cabine/hora.
function resolverDia(dataStr, padraoPorDow, excecoesPorData) {
  const celulas = new Map()
  for (const row of padraoPorDow.get(diaSemanaDe(dataStr)) ?? []) {
    celulas.set(`${row.cabine_id}:${normalizeHora(row.hora_inicio)}`, celulaFromRow(row, 'padrao'))
  }
  for (const row of excecoesPorData.get(dataStr) ?? []) {
    const key = `${row.cabine_id}:${normalizeHora(row.hora_inicio)}`
    if (row.marca_id === null) celulas.delete(key) // exceção "vazia" apaga o padrão
    else celulas.set(key, celulaFromRow(row, 'excecao'))
  }
  return [...celulas.values()].sort((a, b) =>
    (a.cabine_numero ?? 0) - (b.cabine_numero ?? 0) || a.hora_inicio.localeCompare(b.hora_inicio))
}

async function carregarGradeResolvida(db, tenantId, dataInicio, dataFim) {
  const [padraoQ, excecoesQ] = [
    await db.query(PADRAO_SELECT, [tenantId]),
    await db.query(EXCECOES_SELECT, [tenantId, dataInicio, dataFim]),
  ]

  const padraoPorDow = new Map()
  for (const row of padraoQ.rows) {
    const dow = Number(row.dia_semana)
    if (!padraoPorDow.has(dow)) padraoPorDow.set(dow, [])
    padraoPorDow.get(dow).push(row)
  }

  const excecoesPorData = new Map()
  for (const row of excecoesQ.rows) {
    const data = normalizeData(row.data)
    if (!excecoesPorData.has(data)) excecoesPorData.set(data, [])
    excecoesPorData.get(data).push(row)
  }

  return listarDias(dataInicio, dataFim).map((data) => ({
    data,
    celulas: resolverDia(data, padraoPorDow, excecoesPorData),
  }))
}

async function ensureGradeRefs(db, reply, { tenantId, marcaId, cabineId, apresentadoraId }) {
  if (marcaId) {
    const marca = await db.query('SELECT id FROM marcas WHERE id = $1 AND tenant_id = $2::uuid', [marcaId, tenantId])
    if (!marca.rows[0]) {
      reply.code(404).send({ error: 'Marca não encontrada' })
      return false
    }
  }
  if (cabineId) {
    const cabine = await db.query('SELECT id FROM cabines WHERE id = $1 AND tenant_id = $2::uuid', [cabineId, tenantId])
    if (!cabine.rows[0]) {
      reply.code(404).send({ error: 'Cabine não encontrada' })
      return false
    }
  }
  if (apresentadoraId) {
    const apresentadora = await db.query('SELECT id FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid', [apresentadoraId, tenantId])
    if (!apresentadora.rows[0]) {
      reply.code(404).send({ error: 'Apresentadora não encontrada' })
      return false
    }
  }
  return true
}

export async function gradeRoutes(app) {
  const readAccess = [app.authenticate, app.requirePapel(READ_AGENDA)]
  const writeAccess = [app.authenticate, app.requirePapel(WRITE_AGENDA)]

  // GET /v1/grade — dias do intervalo já resolvidos (merge padrão+exceções no backend)
  app.get('/v1/grade', { preHandler: readAccess }, async (request, reply) => {
    const parsed = gradeQuerySchema.safeParse(request.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { data_inicio, data_fim, marca_id, apresentadora_id } = parsed.data
    if (listarDias(data_inicio, data_fim).length > MAX_INTERVALO_DIAS) {
      return reply.code(400).send({ error: `Intervalo máximo de ${MAX_INTERVALO_DIAS} dias` })
    }

    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      let dias = await carregarGradeResolvida(db, tenant_id, data_inicio, data_fim)

      // Filtros aplicados APÓS a resolução (exceção pode sobrepor marca do padrão)
      if (marca_id || apresentadora_id) {
        dias = dias.map((dia) => ({
          data: dia.data,
          celulas: dia.celulas.filter((c) =>
            (!marca_id || c.marca_id === marca_id) &&
            (!apresentadora_id || c.apresentadora_id === apresentadora_id)),
        }))
      }

      return { dias }
    })
  })

  // GET /v1/grade/padrao — template completo com joins de nomes
  app.get('/v1/grade/padrao', { preHandler: readAccess }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `${PADRAO_SELECT} ORDER BY gp.dia_semana, c.numero, gp.hora_inicio`,
        [tenant_id],
      )
      return {
        celulas: result.rows.map((row) => ({
          ...celulaFromRow(row, 'padrao'),
          dia_semana: Number(row.dia_semana),
        })),
      }
    })
  })

  // PUT /v1/grade/padrao — upsert de uma célula do template em 1..N dias da semana
  app.put('/v1/grade/padrao', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = padraoUpsertSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const d = parsed.data
    const dows = resolveDows(d)
    if (dows.length === 0) return reply.code(400).send({ error: 'Informe dia_semana ou dias_semana' })

    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const refsOk = await ensureGradeRefs(db, reply, {
        tenantId: tenant_id,
        marcaId: d.marca_id,
        cabineId: d.cabine_id,
        apresentadoraId: d.apresentadora_id,
      })
      if (!refsOk) return reply

      // unnest($2::int[]) grava todos os dows numa única query — sem estado parcial
      // se um deles falhar (a aba "Seg–Sex" manda [1,2,3,4,5]).
      const result = await db.query(
        `INSERT INTO grade_padrao (tenant_id, dia_semana, cabine_id, hora_inicio, hora_fim, marca_id, apresentadora_id, observacao)
         SELECT $1, dow, $3, $4, $5, $6, $7, $8 FROM unnest($2::int[]) AS dow
         ON CONFLICT (tenant_id, dia_semana, cabine_id, hora_inicio)
         DO UPDATE SET hora_fim = EXCLUDED.hora_fim,
                       marca_id = EXCLUDED.marca_id,
                       apresentadora_id = EXCLUDED.apresentadora_id,
                       observacao = EXCLUDED.observacao,
                       atualizado_em = NOW()
         RETURNING *`,
        [tenant_id, dows, d.cabine_id, d.hora_inicio, d.hora_fim, d.marca_id, d.apresentadora_id ?? null, d.observacao ?? null],
      )
      return { celulas: result.rows, celula: result.rows[0] }
    })
  })

  // DELETE /v1/grade/padrao — remove a célula do template em 1..N dias da semana
  app.delete('/v1/grade/padrao', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = padraoDeleteSchema.safeParse(request.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { cabine_id, hora_inicio } = parsed.data
    const dows = resolveDows(parsed.data)
    if (dows.length === 0) return reply.code(400).send({ error: 'Informe dia_semana ou dias_semana' })

    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `DELETE FROM grade_padrao
         WHERE tenant_id = $1::uuid AND dia_semana = ANY($2::int[])
           AND cabine_id = $3::uuid AND hora_inicio = $4::time`,
        [tenant_id, dows, cabine_id, hora_inicio],
      )
      if ((result.rowCount ?? 0) === 0) return reply.code(404).send({ error: 'Célula não encontrada' })
      return reply.code(204).send()
    })
  })

  // PUT /v1/grade/excecoes — upsert de célula excepcional (marca_id null = vazia)
  app.put('/v1/grade/excecoes', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = excecaoUpsertSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const d = parsed.data
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const refsOk = await ensureGradeRefs(db, reply, {
        tenantId: tenant_id,
        marcaId: d.marca_id,
        cabineId: d.cabine_id,
        apresentadoraId: d.apresentadora_id,
      })
      if (!refsOk) return reply

      const result = await db.query(
        `INSERT INTO grade_excecoes (tenant_id, data, cabine_id, hora_inicio, hora_fim, marca_id, apresentadora_id, observacao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, data, cabine_id, hora_inicio)
         DO UPDATE SET hora_fim = EXCLUDED.hora_fim,
                       marca_id = EXCLUDED.marca_id,
                       apresentadora_id = EXCLUDED.apresentadora_id,
                       observacao = EXCLUDED.observacao,
                       atualizado_em = NOW()
         RETURNING *`,
        [tenant_id, d.data, d.cabine_id, d.hora_inicio, d.hora_fim, d.marca_id, d.apresentadora_id ?? null, d.observacao ?? null],
      )
      return { celula: result.rows[0] }
    })
  })

  // DELETE /v1/grade/excecoes — remove o override (o dia volta ao padrão)
  app.delete('/v1/grade/excecoes', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = excecaoDeleteSchema.safeParse(request.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { data, cabine_id, hora_inicio } = parsed.data
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `DELETE FROM grade_excecoes
         WHERE tenant_id = $1::uuid AND data = $2::date AND cabine_id = $3::uuid AND hora_inicio = $4::time`,
        [tenant_id, data, cabine_id, hora_inicio],
      )
      if ((result.rowCount ?? 0) === 0) return reply.code(404).send({ error: 'Exceção não encontrada' })
      return reply.code(204).send()
    })
  })

  // POST /v1/grade/copiar-dia — grava a grade resolvida da origem como exceções no destino
  app.post('/v1/grade/copiar-dia', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = copiarDiaSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { data_origem, data_destino } = parsed.data
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const [dia] = await carregarGradeResolvida(db, tenant_id, data_origem, data_origem)

      // Sobrescreve exceções existentes no destino
      await db.query(
        `DELETE FROM grade_excecoes WHERE tenant_id = $1::uuid AND data = $2::date`,
        [tenant_id, data_destino],
      )

      let copiadas = 0
      for (const celula of dia.celulas) {
        await db.query(
          `INSERT INTO grade_excecoes (tenant_id, data, cabine_id, hora_inicio, hora_fim, marca_id, apresentadora_id, observacao)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [tenant_id, data_destino, celula.cabine_id, celula.hora_inicio, celula.hora_fim,
           celula.marca_id, celula.apresentadora_id ?? null, celula.observacao ?? null],
        )
        copiadas++
      }

      return reply.code(201).send({ data_destino, copiadas })
    })
  })
}
