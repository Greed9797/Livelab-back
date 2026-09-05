// Grade visual — resolução padrão+exceções, filtros, upsert, copiar-dia.
// Segue o padrão dos testes existentes: mock de withTenant/authenticate + app.inject.

import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { gradeRoutes } from '../src/routes/grade.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const cabine1 = '00000000-0000-4000-8000-000000000001'
const cabine2 = '00000000-0000-4000-8000-000000000002'
const marcaHaag = '00000000-0000-4000-8000-00000000000a'
const marcaOutra = '00000000-0000-4000-8000-00000000000b'
const apresentadoraJulia = '00000000-0000-4000-8000-0000000000aa'

function padraoRow(overrides = {}) {
  return {
    id: 'gp-1',
    tenant_id: tenantId,
    dia_semana: 5, // sexta (2026-07-17)
    cabine_id: cabine1,
    cabine_numero: 1,
    hora_inicio: '08:00:00',
    hora_fim: '11:00:00',
    marca_id: marcaHaag,
    marca_nome: 'HAAG',
    marca_logo_url: null,
    apresentadora_id: apresentadoraJulia,
    apresentadora_nome: 'Julia',
    observacao: null,
    ...overrides,
  }
}

function excecaoRow(overrides = {}) {
  return {
    id: 'ge-1',
    tenant_id: tenantId,
    data: '2026-07-17',
    cabine_id: cabine1,
    cabine_numero: 1,
    hora_inicio: '08:00:00',
    hora_fim: '11:00:00',
    marca_id: marcaOutra,
    marca_nome: 'OUTRA',
    marca_logo_url: null,
    apresentadora_id: null,
    apresentadora_nome: null,
    observacao: null,
    ...overrides,
  }
}

// Roteia o mock por SQL: SELECTs de padrão/exceções + writes genéricos.
function buildApp({ padrao = [], excecoes = [], onQuery } = {}) {
  const app = Fastify()
  const query = vi.fn(async (sql, values) => {
    if (onQuery) {
      const custom = onQuery(sql, values)
      if (custom) return custom
    }
    if (String(sql).includes('FROM grade_padrao gp') && String(sql).includes('FROM grade_excecoes ge')) {
      return { rows: [
        ...padrao.map((row) => ({ ...row, origem: 'padrao', data: null })),
        ...excecoes.map((row) => ({ ...row, origem: 'excecao', dia_semana: null })),
      ] }
    }
    if (String(sql).includes('FROM grade_padrao gp')) return { rows: padrao }
    if (String(sql).includes('FROM grade_excecoes ge')) return { rows: excecoes }
    if (String(sql).startsWith('SELECT id FROM')) return { rows: [{ id: 'ok' }] }
    return { rows: [{ id: 'row-1' }], rowCount: 1 }
  })

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: tenantId, sub: 'user-1', papel: 'franqueado' }
  })
  app.decorate('requirePapel', () => async () => {})
  app.decorate('withTenant', async (_t, fn) => fn({ query }))

  return { app, query }
}

describe('GET /v1/grade — resolução de dias', () => {
  it('GET /v1/grade/padrao mantém a leitura do template configurável', async () => {
    const { app } = buildApp({ padrao: [padraoRow()] })
    await app.register(gradeRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/grade/padrao' })
    expect(res.statusCode).toBe(200)
    expect(res.json().celulas).toHaveLength(1)
    expect(res.json().celulas[0]).toMatchObject({ cabine_id: cabine1, marca_nome: 'HAAG', origem: 'padrao' })
    await app.close()
  })

  it('dia útil: padrão puro aparece com origem=padrao', async () => {
    const { app } = buildApp({ padrao: [padraoRow()] })
    await app.register(gradeRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/grade?data_inicio=2026-07-17&data_fim=2026-07-17' })
    expect(res.statusCode).toBe(200)
    const { dias } = res.json()
    expect(dias).toHaveLength(1)
    expect(dias[0].data).toBe('2026-07-17')
    expect(dias[0].celulas).toEqual([expect.objectContaining({
      cabine_id: cabine1,
      hora_inicio: '08:00',
      hora_fim: '11:00',
      marca_nome: 'HAAG',
      apresentadora_nome: 'Julia',
      origem: 'padrao',
    })])
    await app.close()
  })

  it('exceção sobrepõe célula do padrão (mesma cabine+hora_inicio)', async () => {
    const { app } = buildApp({ padrao: [padraoRow()], excecoes: [excecaoRow()] })
    await app.register(gradeRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/grade?data_inicio=2026-07-17&data_fim=2026-07-17' })
    const { dias } = res.json()
    expect(dias[0].celulas).toHaveLength(1)
    expect(dias[0].celulas[0]).toMatchObject({ marca_nome: 'OUTRA', origem: 'excecao' })
    await app.close()
  })

  it('exceção com marca_id null apaga a célula do padrão naquele dia', async () => {
    const { app } = buildApp({
      padrao: [padraoRow()],
      excecoes: [excecaoRow({ marca_id: null, marca_nome: null })],
    })
    await app.register(gradeRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/grade?data_inicio=2026-07-17&data_fim=2026-07-17' })
    expect(res.json().dias[0].celulas).toEqual([])
    await app.close()
  })

  it('padrão de sexta NÃO vaza pro sábado; sábado mostra só exceções', async () => {
    const { app } = buildApp({
      padrao: [padraoRow()], // dia_semana=5 (sexta)
      excecoes: [excecaoRow({ data: '2026-07-18', marca_nome: 'HAAG', marca_id: marcaHaag })],
    })
    await app.register(gradeRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/grade?data_inicio=2026-07-18&data_fim=2026-07-18' })
    const { dias } = res.json()
    expect(dias[0].data).toBe('2026-07-18') // sábado
    expect(dias[0].celulas).toHaveLength(1)
    expect(dias[0].celulas[0].origem).toBe('excecao')
    await app.close()
  })

  it('filtro por marca no intervalo: só dias/células da marca aparecem', async () => {
    const { app } = buildApp({
      padrao: [
        padraoRow(),
        padraoRow({ id: 'gp-2', cabine_id: cabine2, cabine_numero: 2, marca_id: marcaOutra, marca_nome: 'OUTRA' }),
      ],
      excecoes: [excecaoRow({ data: '2026-07-18', marca_id: marcaHaag, marca_nome: 'HAAG' })],
    })
    await app.register(gradeRoutes)

    // Semana 13–19/07: HAAG deve aparecer na sexta (padrão) e no sábado (exceção)
    const res = await app.inject({
      method: 'GET',
      url: `/v1/grade?data_inicio=2026-07-13&data_fim=2026-07-19&marca_id=${marcaHaag}`,
    })
    const { dias } = res.json()
    expect(dias).toHaveLength(7)
    const comCelulas = dias.filter((d) => d.celulas.length > 0).map((d) => d.data)
    expect(comCelulas).toEqual(['2026-07-17', '2026-07-18'])
    for (const dia of dias) {
      for (const c of dia.celulas) expect(c.marca_id).toBe(marcaHaag)
    }
    await app.close()
  })

  it('rejeita intervalo acima de 62 dias', async () => {
    const { app } = buildApp()
    await app.register(gradeRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/grade?data_inicio=2026-01-01&data_fim=2026-06-01' })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})

describe('PUT /v1/grade/padrao — upsert idempotente', () => {
  it('duas chamadas iguais retornam 200 e usam ON CONFLICT DO UPDATE', async () => {
    const { app, query } = buildApp()
    await app.register(gradeRoutes)

    const body = {
      dia_semana: 2,
      cabine_id: cabine1,
      hora_inicio: '08:00',
      hora_fim: '11:00',
      marca_id: marcaHaag,
      apresentadora_id: apresentadoraJulia,
    }
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'PUT', url: '/v1/grade/padrao', body })
      expect(res.statusCode).toBe(200)
    }

    const upserts = query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO grade_padrao'))
    expect(upserts).toHaveLength(2)
    expect(upserts[0][0]).toContain('ON CONFLICT (tenant_id, dia_semana, cabine_id, hora_inicio)')
    expect(upserts[0][0]).toContain('DO UPDATE')
    // Isolamento de tenant: tenant_id sempre é o primeiro parâmetro
    expect(upserts[0][1][0]).toBe(tenantId)
    await app.close()
  })

  it('dias_semana [1..5] grava os 5 dows numa única query (aba Seg–Sex)', async () => {
    const { app, query } = buildApp()
    await app.register(gradeRoutes)

    const res = await app.inject({
      method: 'PUT',
      url: '/v1/grade/padrao',
      body: {
        dias_semana: [1, 2, 3, 4, 5],
        cabine_id: cabine1,
        hora_inicio: '08:00',
        hora_fim: '11:00',
        marca_id: marcaHaag,
      },
    })
    expect(res.statusCode).toBe(200)

    const upserts = query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO grade_padrao'))
    expect(upserts).toHaveLength(1) // uma query só — sem estado parcial
    expect(upserts[0][0]).toContain('unnest($2::int[])')
    expect(upserts[0][1][1]).toEqual([1, 2, 3, 4, 5])
    await app.close()
  })

  it('DELETE com dias_semana=1,2,3,4,5 remove os 5 dows', async () => {
    const { app, query } = buildApp()
    await app.register(gradeRoutes)

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/grade/padrao?dias_semana=1,2,3,4,5&cabine_id=${cabine1}&hora_inicio=08:00`,
    })
    expect(res.statusCode).toBe(204)
    const del = query.mock.calls.find(([sql]) => String(sql).includes('DELETE FROM grade_padrao'))
    expect(del[0]).toContain('dia_semana = ANY($2::int[])')
    expect(del[1][1]).toEqual([1, 2, 3, 4, 5])
    await app.close()
  })

  it('valida hora_fim > hora_inicio', async () => {
    const { app } = buildApp()
    await app.register(gradeRoutes)
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/grade/padrao',
      body: { dia_semana: 2, cabine_id: cabine1, hora_inicio: '11:00', hora_fim: '08:00', marca_id: marcaHaag },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('404 quando marca não existe no tenant', async () => {
    const { app } = buildApp({
      onQuery: (sql) => (String(sql).includes('SELECT id FROM marcas') ? { rows: [] } : null),
    })
    await app.register(gradeRoutes)
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/grade/padrao',
      body: { dia_semana: 2, cabine_id: cabine1, hora_inicio: '08:00', hora_fim: '11:00', marca_id: marcaHaag },
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})

describe('PUT/DELETE /v1/grade/excecoes', () => {
  it('aceita marca_id null (célula vazia) sem validar refs de marca', async () => {
    const { app, query } = buildApp()
    await app.register(gradeRoutes)
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/grade/excecoes',
      body: { data: '2026-07-18', cabine_id: cabine1, hora_inicio: '08:00', hora_fim: '11:00', marca_id: null },
    })
    expect(res.statusCode).toBe(200)
    const marcaCheck = query.mock.calls.find(([sql]) => String(sql).includes('SELECT id FROM marcas'))
    expect(marcaCheck).toBeUndefined()
    await app.close()
  })

  it('DELETE remove o override; 404 se não existe', async () => {
    const { app } = buildApp({
      onQuery: (sql) => (String(sql).includes('DELETE FROM grade_excecoes') ? { rows: [], rowCount: 0 } : null),
    })
    await app.register(gradeRoutes)
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/grade/excecoes?data=2026-07-18&cabine_id=${cabine1}&hora_inicio=08:00`,
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})

describe('POST /v1/grade/copiar-dia', () => {
  it('resolve a origem e grava tudo como exceções no destino, limpando antes', async () => {
    const inserts = []
    const { app, query } = buildApp({
      padrao: [padraoRow()], // sexta 2026-07-17
      onQuery: (sql, values) => {
        if (String(sql).includes('INSERT INTO grade_excecoes')) {
          inserts.push(values)
          return { rows: [], rowCount: 1 }
        }
        return null
      },
    })
    await app.register(gradeRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grade/copiar-dia',
      body: { data_origem: '2026-07-17', data_destino: '2026-07-18' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ data_destino: '2026-07-18', copiadas: 1 })

    const deleteCall = query.mock.calls.find(([sql]) => String(sql).includes('DELETE FROM grade_excecoes'))
    expect(deleteCall[1]).toEqual([tenantId, '2026-07-18'])
    expect(inserts[0]).toEqual([tenantId, '2026-07-18', cabine1, '08:00', '11:00', marcaHaag, apresentadoraJulia, null])
    await app.close()
  })

  it('rejeita origem igual ao destino', async () => {
    const { app } = buildApp()
    await app.register(gradeRoutes)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/grade/copiar-dia',
      body: { data_origem: '2026-07-17', data_destino: '2026-07-17' },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})
