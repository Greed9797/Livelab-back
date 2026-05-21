import Fastify from 'fastify'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { agendaRoutes } from '../src/routes/agenda.js'
import { comissoesRoutes } from '../src/routes/comissoes.js'
import { configuracoesRoutes } from '../src/routes/configuracoes.js'
import { financeiroRoutes } from '../src/routes/financeiro.js'
import { livesRoutes } from '../src/routes/lives.js'
import { marcasRoutes } from '../src/routes/marcas.js'
import { calcularComissoesAtribuidas, upsertVendaAtribuida, vendasAtribuidasRoutes } from '../src/routes/vendas_atribuidas.js'
import { videosRoutes } from '../src/routes/videos.js'

function buildApp({ papel = 'franqueado', queryMock } = {}) {
  const app = Fastify()
  const _query = queryMock ?? vi.fn().mockResolvedValue({ rows: [] })
  const release = vi.fn()
  const tenantIds = []

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!request.user) request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel }
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('dbTenant', async () => ({ query: _query, release }))
  app.decorate('withTenant', async (tenantId, fn) => {
    tenantIds.push(tenantId)
    const db = await app.dbTenant(tenantId)
    try { return await fn(db) } finally { db.release() }
  })
  app.decorate('audit', { log: vi.fn().mockResolvedValue(undefined) })

  return { app, _query, release, tenantIds }
}

describe('LIVELAB operational routes', () => {
  it('GET /v1/marcas uses withTenant and explicit tenant filter', async () => {
    const queryMock = vi.fn().mockResolvedValueOnce({
      rows: [{ id: 'marca-1', nome: 'Marca A', ativo: true }],
    })
    const { app, tenantIds } = buildApp({ queryMock })
    await app.register(marcasRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/marcas' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([{ id: 'marca-1', nome: 'Marca A', ativo: true }])
    expect(tenantIds).toEqual(['tenant-1'])
    expect(queryMock.mock.calls[0][0]).toContain('WHERE m.tenant_id = $1::uuid')
    expect(queryMock.mock.calls[0][1]).toEqual(['tenant-1'])
    await app.close()
  })

  it('POST /v1/agenda inserts tenant-scoped agenda events', async () => {
    const marcaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: marcaId }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'agenda-1', marca_id: marcaId, status: 'planejado' }],
      })
    const { app } = buildApp({ queryMock })
    await app.register(agendaRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agenda',
      payload: {
        tipo: 'live',
        marca_id: marcaId,
        data_inicio: '2026-05-20T18:00:00Z',
        data_fim: '2026-05-20T19:00:00Z',
      },
    })

    expect(res.statusCode).toBe(201)
    const insertCall = queryMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO agenda_eventos'))
    expect(insertCall).toBeTruthy()
    expect(insertCall[1][0]).toBe('tenant-1')
    await app.close()
  })

  it('POST /v1/agenda allows adjacent events in the same cabine', async () => {
    const marcaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const cabineId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: marcaId }] })
      .mockResolvedValueOnce({ rows: [{ id: cabineId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'agenda-adjacente', marca_id: marcaId, cabine_id: cabineId, status: 'planejado' }],
      })
    const { app } = buildApp({ queryMock })
    await app.register(agendaRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agenda',
      payload: {
        tipo: 'live',
        marca_id: marcaId,
        cabine_id: cabineId,
        data_inicio: '2026-05-20T13:00:00Z',
        data_fim: '2026-05-20T14:00:00Z',
      },
    })

    expect(res.statusCode).toBe(201)
    const conflictSql = queryMock.mock.calls.find(([sql]) => sql.includes('FROM agenda_eventos ae'))?.[0]
    expect(conflictSql).toContain('ae.data_inicio < $3::timestamptz')
    expect(conflictSql).toContain('ae.data_fim > $2::timestamptz')
    await app.close()
  })

  it('POST /v1/agenda rejects recurrence ending before the first event date', async () => {
    const marcaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const queryMock = vi.fn().mockResolvedValue({ rows: [{ id: marcaId }] })
    const { app } = buildApp({ queryMock })
    await app.register(agendaRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agenda',
      payload: {
        tipo: 'live',
        marca_id: marcaId,
        data_inicio: '2026-05-21T18:00:00Z',
        data_fim: '2026-05-21T19:00:00Z',
        recorrencia: { frequencia: 'diaria', ate: '2026-05-20' },
      },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: expect.stringContaining('Repetir até') })
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('POST /v1/agenda blocks overlapping cabine events with 409', async () => {
    const marcaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const cabineId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: marcaId }] })
      .mockResolvedValueOnce({ rows: [{ id: cabineId }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'agenda-existente',
          tipo: 'live',
          entidade: 'cabine',
          cabine_id: cabineId,
          apresentadora_id: null,
          data_inicio: '2026-05-20T18:30:00Z',
          data_fim: '2026-05-20T19:30:00Z',
          status: 'planejado',
        }],
      })
    const { app } = buildApp({ queryMock })
    await app.register(agendaRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agenda',
      payload: {
        tipo: 'live',
        marca_id: marcaId,
        cabine_id: cabineId,
        data_inicio: '2026-05-20T18:00:00Z',
        data_fim: '2026-05-20T19:00:00Z',
      },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      code: 'AGENDA_CONFLICT',
      conflitos: [{ entidade: 'cabine', evento_id: 'agenda-existente', cabine_id: cabineId }],
    })
    expect(queryMock.mock.calls.some(([sql]) => sql.includes('INSERT INTO agenda_eventos'))).toBe(false)
    await app.close()
  })

  it('POST /v1/agenda blocks overlapping apresentadora events with 409', async () => {
    const marcaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const apresentadoraId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: marcaId }] })
      .mockResolvedValueOnce({ rows: [{ id: apresentadoraId }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'agenda-apresentadora',
          tipo: 'live',
          entidade: 'apresentadora',
          cabine_id: null,
          apresentadora_id: apresentadoraId,
          data_inicio: '2026-05-20T18:30:00Z',
          data_fim: '2026-05-20T19:30:00Z',
          status: 'planejado',
        }],
      })
    const { app } = buildApp({ queryMock })
    await app.register(agendaRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agenda',
      payload: {
        tipo: 'live',
        marca_id: marcaId,
        apresentadora_id: apresentadoraId,
        data_inicio: '2026-05-20T18:00:00Z',
        data_fim: '2026-05-20T19:00:00Z',
      },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      code: 'AGENDA_CONFLICT',
      conflitos: [{ entidade: 'apresentadora', evento_id: 'agenda-apresentadora', apresentadora_id: apresentadoraId }],
    })
    expect(queryMock.mock.calls.some(([sql]) => sql.includes('INSERT INTO agenda_eventos'))).toBe(false)
    await app.close()
  })

  it('POST /v1/videos with GMV upserts vendas_atribuidas origem=video', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (sql.includes('FROM marcas')) return { rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', comissao_franquia_pct: '10', comissao_franqueadora_pct: '2.5' }] }
      if (sql.includes('FROM apresentadoras')) return { rows: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }] }
      if (sql.includes('FROM apresentadora_marcas')) return { rows: [{ comissao_video_pct: '12.5' }] }
      if (sql.includes('FROM vendas_atribuidas')) return { rows: [] }
      if (sql.includes('INSERT INTO vendas_atribuidas')) {
        return { rows: [{ id: 'venda-1', origem: 'video', gmv: '1000.00', comissao_apresentadora: '125.00' }] }
      }
      if (sql.includes('INSERT INTO video_registros')) {
        return { rows: [{
          id: 'video-1',
          marca_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          apresentadora_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          data: '2026-05-20',
          quantidade: 1,
          gmv_atribuido: '1000.00',
          pedidos_atribuidos: 8,
        }] }
      }
      return { rows: [] }
    })

    const { app } = buildApp({ queryMock })
    await app.register(videosRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/videos',
      payload: {
        marca_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        apresentadora_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        data: '2026-05-20',
        quantidade: 1,
        gmv_atribuido: 1000,
        pedidos_atribuidos: 8,
      },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().venda_atribuida).toMatchObject({ id: 'venda-1', origem: 'video' })
    const vendaCall = queryMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO vendas_atribuidas'))
    expect(vendaCall).toBeTruthy()
    expect(vendaCall[1][1]).toBe('video')
    await app.close()
  })

  it('POST /v1/vendas-atribuidas blocks cliente_parceiro writes', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] })
    const { app } = buildApp({ papel: 'cliente_parceiro', queryMock })
    await app.register(vendasAtribuidasRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/vendas-atribuidas',
      payload: { origem: 'manual', valor_gmv: 100, quantidade_pedidos: 1 },
    })

    expect(res.statusCode).toBe(403)
    expect(queryMock).not.toHaveBeenCalled()
    await app.close()
  })

  it('DELETE /v1/lives/:id removes an ended live and related attribution rows', async () => {
    const liveId = '11111111-1111-4111-8111-111111111111'
    const queryMock = vi.fn(async (sql) => {
      if (/SELECT id, status/i.test(sql) && /FROM lives/i.test(sql)) {
        return { rows: [{ id: liveId, status: 'encerrada', cabine_id: 'cabine-1', iniciado_em: '2026-05-19T18:00:00Z' }] }
      }
      return { rows: [] }
    })
    const { app } = buildApp({ queryMock })
    await app.register(livesRoutes)

    const res = await app.inject({ method: 'DELETE', url: `/v1/lives/${liveId}` })

    expect(res.statusCode).toBe(204)
    expect(queryMock.mock.calls.some(([sql]) => /DELETE FROM vendas_atribuidas/i.test(sql))).toBe(true)
    expect(queryMock.mock.calls.some(([sql]) => /DELETE FROM lives/i.test(sql))).toBe(true)
    await app.close()
  })

  it('DELETE /v1/lives/:id closes and deletes an in-progress live without leaving cabine locked', async () => {
    const liveId = '11111111-1111-4111-8111-111111111111'
    const cabineId = '22222222-2222-4222-8222-222222222222'
    const queryMock = vi.fn(async (sql) => {
      if (/SELECT id, status/i.test(sql) && /FROM lives/i.test(sql)) {
        return { rows: [{ id: liveId, status: 'em_andamento', cabine_id: cabineId, iniciado_em: '2026-05-19T18:00:00Z' }] }
      }
      return { rows: [] }
    })
    const { app } = buildApp({ queryMock })
    await app.register(livesRoutes)

    const res = await app.inject({ method: 'DELETE', url: `/v1/lives/${liveId}` })

    expect(res.statusCode).toBe(204)
    expect(queryMock.mock.calls.some(([sql, params]) => (
      /UPDATE cabines/i.test(sql) &&
      /live_atual_id = NULL/i.test(sql) &&
      params.includes(cabineId)
    ))).toBe(true)
    expect(queryMock.mock.calls.some(([sql]) => /UPDATE agenda_eventos/i.test(sql) && /status = 'cancelado'/i.test(sql))).toBe(true)
    expect(queryMock.mock.calls.some(([sql]) => /DELETE FROM lives/i.test(sql))).toBe(true)
    await app.close()
  })

  it('GET /v1/lives applies the completed-status filter used by conteúdo', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] })
    const { app } = buildApp({ queryMock })
    await app.register(livesRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/lives?status=encerrada' })

    expect(res.statusCode).toBe(200)
    expect(queryMock.mock.calls[0][0]).toContain('AND l.status = $2')
    expect(queryMock.mock.calls[0][1]).toEqual(['tenant-1', 'encerrada'])
    await app.close()
  })

  it('PATCH /v1/lives/:id/encerrar rolls back when agenda sync fails', async () => {
    const liveId = '11111111-1111-4111-8111-111111111111'
    const cabineId = '22222222-2222-4222-8222-222222222222'
    const queryMock = vi.fn(async (sql) => {
      if (/SELECT id, cabine_id, cliente_id, apresentador_id, status, iniciado_em/i.test(sql)) {
        return { rows: [{ id: liveId, cabine_id: cabineId, cliente_id: '33333333-3333-4333-8333-333333333333', apresentador_id: null, status: 'em_andamento', iniciado_em: '2026-05-19T18:00:00Z' }] }
      }
      if (/SELECT id, contrato_id, status/i.test(sql) && /FROM cabines/i.test(sql)) {
        return { rows: [{ id: cabineId, contrato_id: null, status: 'ao_vivo' }] }
      }
      if (/SELECT id\s+FROM marcas/i.test(sql)) return { rows: [] }
      if (/UPDATE agenda_eventos/i.test(sql)) throw new Error('agenda update failed')
      return { rows: [] }
    })
    const { app } = buildApp({ queryMock })
    await app.register(livesRoutes)

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/lives/${liveId}/encerrar`,
      payload: { fat_gerado: 100, qtd_pedidos: 1 },
    })

    expect(res.statusCode).toBe(500)
    expect(queryMock.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true)
    expect(queryMock.mock.calls.some(([sql]) => /UPDATE cabines/i.test(sql) && /live_atual_id = NULL/i.test(sql))).toBe(false)
    await app.close()
  })

  it('DELETE /v1/lives/:id returns 404 when live does not exist', async () => {
    const queryMock = vi.fn().mockResolvedValue({ rows: [] })
    const { app } = buildApp({ queryMock })
    await app.register(livesRoutes)

    const res = await app.inject({ method: 'DELETE', url: '/v1/lives/11111111-1111-4111-8111-111111111111' })

    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('DELETE /v1/lives/:id returns 409 for unmapped foreign-key dependencies', async () => {
    const liveId = '11111111-1111-4111-8111-111111111111'
    const queryMock = vi.fn(async (sql) => {
      if (/SELECT id, status/i.test(sql) && /FROM lives/i.test(sql)) {
        return { rows: [{ id: liveId, status: 'encerrada', cabine_id: 'cabine-1', iniciado_em: '2026-05-19T18:00:00Z' }] }
      }
      if (/DELETE FROM lives/i.test(sql)) {
        const error = new Error('fk')
        error.code = '23503'
        throw error
      }
      return { rows: [] }
    })
    const { app } = buildApp({ queryMock })
    await app.register(livesRoutes)

    const res = await app.inject({ method: 'DELETE', url: `/v1/lives/${liveId}` })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'LIVE_FOREIGN_KEY_DEPENDENCY' })
    expect(queryMock.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true)
    await app.close()
  })

  it('migration registry includes commission goals compatibility without duplicate faixa table name', () => {
    const registry = readFileSync(new URL('../apply_migrations.js', import.meta.url), 'utf8')
    const migration = readFileSync(new URL('../migrations/090_comissao_metas_compat.sql', import.meta.url), 'utf8')

    expect(registry).toContain('090_comissao_metas_compat.sql')
    expect(migration).toContain('valor_fixo_minimo')
    expect(migration).toContain('valor_fixo_mensal')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS metas_apresentadora')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS metas_supervisor')
    expect(migration).not.toContain('apresentadora_faixas_comissao')
  })

  it('GET /v1/comissoes/resumo aggregates live and video attribution rows', async () => {
    const queryMock = vi.fn().mockResolvedValueOnce({
      rows: [{
        gmv_total: '2000.00',
        gmv_lives: '2000.00',
        gmv_videos: '0',
        pedidos_total: '15',
        registros: '3',
        comissao_apresentadoras: '225.00',
        comissao_franquia: '0',
        comissao_franqueadora: '0',
      }],
    })
    const { app } = buildApp({ queryMock })
    await app.register(comissoesRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/comissoes/resumo' })

    expect(res.statusCode).toBe(200)
    expect(res.json().totais).toMatchObject({
      gmv: 2000,
      gmv_lives: 2000,
      gmv_videos: 0,
      pedidos: 15,
      comissao: 225,
      registros: 3,
    })
    expect(queryMock.mock.calls[0][0]).toContain('FROM vendas_atribuidas va')
    await app.close()
  })

  it('GET /v1/comissoes/apresentadoras ranks only attributed presenters by GMV', async () => {
    const queryMock = vi.fn().mockResolvedValueOnce({
      rows: [{ apresentadora_id: 'ap-1', apresentadora_nome: 'Edja', gmv_total: '1142.00', comissao_apresentadora: '11.42' }],
    })
    const { app } = buildApp({ queryMock })
    await app.register(comissoesRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/comissoes/apresentadoras' })

    expect(res.statusCode).toBe(200)
    expect(res.json()[0]).toMatchObject({ apresentadora_nome: 'Edja', gmv_total: '1142.00' })
    expect(queryMock.mock.calls[0][0]).toContain('va.apresentadora_id IS NOT NULL')
    expect(queryMock.mock.calls[0][0]).toContain('ORDER BY gmv_total DESC, comissao_apresentadora DESC')
    await app.close()
  })

  it('GET /v1/financeiro/resumo uses vendas_atribuidas as GMV source', async () => {
    const queryMock = vi.fn().mockResolvedValueOnce({
      rows: [{
        gmv_total: '1142.00',
        receita_liquida: '114.20',
        comissao_configurada: '1',
        comissao_faltante_count: '0',
        total_custos: '20.00',
      }],
    })
    const { app } = buildApp({ queryMock })
    await app.register(financeiroRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/financeiro/resumo?inicio=2026-05&fim=2026-05' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      gmv_total: 1142,
      receita_liquida: 114.2,
      comissao_configurada: 1,
      comissao_faltante_count: 0,
    })
    expect(queryMock.mock.calls[0][0]).toContain('FROM vendas_atribuidas va')
    await app.close()
  })

  it('GET /v1/financeiro/fluxo-caixa uses vendas_atribuidas for entradas', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [{ dia: '2026-05-19', valor: '1142.00' }] })
      .mockResolvedValueOnce({ rows: [{ dia: '2026-05-19', valor: '100.00' }] })
    const { app } = buildApp({ queryMock })
    await app.register(financeiroRoutes)

    const res = await app.inject({ method: 'GET', url: '/v1/financeiro/fluxo-caixa?inicio=2026-05-01&fim=2026-05-31' })

    expect(res.statusCode).toBe(200)
    expect(res.json().items[0]).toMatchObject({ dia: '2026-05-19', entradas: 1142, saidas: 100 })
    expect(queryMock.mock.calls[0][0]).toContain('FROM vendas_atribuidas va')
    await app.close()
  })

  it('GET/PATCH /v1/configuracoes/ranking-publico reads and updates public ranking fields', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: 'tenant-1',
          nome: 'Livelab Blumenau',
          logo_url: 'https://cdn/logo.png',
          cidade: 'Blumenau',
          uf: 'SC',
          ranking_publico_ativo: true,
          ranking_publico_nome: 'LiveLab Blumenau',
          ranking_publico_logo_url: null,
          ranking_publico_cidade: null,
          ranking_publico_uf: null,
          ranking_publico_meta_gmv: '50000.00',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          ranking_publico_ativo: false,
          ranking_publico_nome: 'Unidade Blumenau',
          ranking_publico_logo_url: '',
          ranking_publico_cidade: 'Blumenau',
          ranking_publico_uf: 'SC',
          ranking_publico_meta_gmv: '80000.00',
        }],
      })
    const { app } = buildApp({ queryMock })
    await app.register(configuracoesRoutes)

    const getRes = await app.inject({ method: 'GET', url: '/v1/configuracoes/ranking-publico' })
    expect(getRes.statusCode).toBe(200)
    expect(getRes.json()).toMatchObject({ ativo: true, nome_publico: 'LiveLab Blumenau', meta_gmv: 50000 })

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/v1/configuracoes/ranking-publico',
      payload: { ativo: false, nome_publico: 'Unidade Blumenau', cidade: 'Blumenau', uf: 'SC', meta_gmv: '80.000,00' },
    })
    expect(patchRes.statusCode).toBe(200)
    expect(patchRes.json()).toMatchObject({ ativo: false, nome_publico: 'Unidade Blumenau', meta_gmv: 80000 })
    expect(queryMock.mock.calls[1][0]).toContain('ranking_publico_ativo')
    await app.close()
  })

  it('calcularComissoesAtribuidas chooses presenter ladder by monthly GMV', async () => {
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [{ comissao_franquia_pct: '10', comissao_franqueadora_pct: '2' }] })
      .mockResolvedValueOnce({ rows: [{ gmv_mes: '49000.00' }] })
      .mockResolvedValueOnce({ rows: [{ comissao_pct: '1' }] })
      .mockResolvedValueOnce({ rows: [{ comissao_live_pct: '0.5', comissao_video_pct: '0.5' }] })

    const result = await calcularComissoesAtribuidas({ query: queryMock }, {
      tenantId: 'tenant-1',
      marcaId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      apresentadoraId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      origem: 'live',
      origemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      data: '2026-05-19',
      gmv: 2000,
    })

    expect(result).toMatchObject({
      comissao_apresentadora: 20,
      comissao_franquia: 200,
      comissao_franqueadora: 40,
    })
    expect(queryMock.mock.calls[2][0]).toContain('apresentadora_comissao_faixas')
  })

  it('calcularComissoesAtribuidas applies 2 percent for weekend live', async () => {
    const queryMock = vi.fn(async (sql) => {
      if (sql.includes('FROM marcas')) return { rows: [{ comissao_franquia_pct: '10', comissao_franqueadora_pct: '2' }] }
      if (sql.includes('FROM vendas_atribuidas')) return { rows: [{ gmv_mes: '0.00' }] }
      if (sql.includes('FROM apresentadora_comissao_faixas')) return { rows: [{ comissao_pct: '0.5' }] }
      if (sql.includes('FROM apresentadora_marcas')) return { rows: [{ comissao_live_pct: '0.5', comissao_video_pct: '0.5' }] }
      return { rows: [] }
    })

    const result = await calcularComissoesAtribuidas({ query: queryMock }, {
      tenantId: 'tenant-1',
      marcaId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      apresentadoraId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      origem: 'live',
      origemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      data: '2026-05-23',
      gmv: 2000,
    })

    expect(result).toMatchObject({
      comissao_apresentadora: 40,
      comissao_franquia: 200,
      comissao_franqueadora: 40,
    })
  })

  it('upsertVendaAtribuida does not overwrite approved sales', async () => {
    const approved = {
      id: 'venda-aprovada',
      status_aprovacao: 'aprovada',
      gmv: '1000.00',
      comissao_apresentadora: '10.00',
    }
    const queryMock = vi.fn(async (sql) => {
      if (sql.includes('FROM marcas')) return { rows: [{ comissao_franquia_pct: '10', comissao_franqueadora_pct: '2' }] }
      if (sql.includes('FROM vendas_atribuidas') && sql.includes('COALESCE(SUM(gmv)')) return { rows: [{ gmv_mes: '0.00' }] }
      if (sql.includes('FROM apresentadora_comissao_faixas')) return { rows: [{ comissao_pct: '1' }] }
      if (sql.includes('FROM apresentadora_marcas')) return { rows: [{ comissao_live_pct: '1', comissao_video_pct: '1' }] }
      if (sql.includes('FROM vendas_atribuidas') && sql.includes('origem_id = $3::uuid')) return { rows: [approved] }
      if (sql.includes('UPDATE vendas_atribuidas')) throw new Error('approved sale should not be updated')
      return { rows: [] }
    })

    const result = await upsertVendaAtribuida({ query: queryMock }, {
      tenantId: 'tenant-1',
      marcaId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      apresentadoraId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      origem: 'live',
      origemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      data: '2026-05-19',
      gmv: 2000,
      pedidos: 5,
    })

    expect(result).toBe(approved)
    expect(queryMock.mock.calls.some(([sql]) => sql.includes('UPDATE vendas_atribuidas'))).toBe(false)
  })
})
