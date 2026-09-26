import Fastify from 'fastify'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { liveHasFinancialHistory } from '../src/lib/live-archive.js'
import { livesRoutes } from '../src/routes/lives.js'

function buildApp({ papel = 'franqueado', queryMock } = {}) {
  const app = Fastify()
  const query = queryMock ?? vi.fn().mockResolvedValue({ rows: [] })
  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel }
  })
  app.decorate('requirePapel', (papeis) => async (request, reply) => {
    if (!papeis.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
  })
  app.decorate('withTenant', async (_tenantId, fn) => fn({ query }))
  app.decorate('audit', { log: vi.fn().mockResolvedValue(undefined) })
  return { app, query }
}

const liveId = '11111111-1111-4111-8111-111111111111'

describe('liveHasFinancialHistory', () => {
  it('ignora o zero default de fat_gerado e comissão e não trata null como zero', () => {
    expect(liveHasFinancialHistory({ fat_gerado: 0, comissao_calculada: '0.00' })).toBe(false)
    expect(liveHasFinancialHistory({ fat_gerado: null, manual_gmv: null, ads_gmv: null })).toBe(false)
    expect(liveHasFinancialHistory({})).toBe(false)
  })

  it('reconhece GMV gravado, inclusive zero informado, e venda atribuída', () => {
    expect(liveHasFinancialHistory({ fat_gerado: '1500.00' })).toBe(true)
    expect(liveHasFinancialHistory({ manual_gmv: 0 })).toBe(true)
    expect(liveHasFinancialHistory({ ads_gmv: '0' })).toBe(true)
    expect(liveHasFinancialHistory({ comissao_apresentadora_valor: 0 })).toBe(true)
    expect(liveHasFinancialHistory({ tem_venda_atribuida: true, fat_gerado: 0 })).toBe(true)
    expect(liveHasFinancialHistory({ tem_revisao_gmv: 't' })).toBe(true)
  })
})

describe('lista do gestor', () => {
  it('não inclui envio já devolvido à apresentadora', async () => {
    const { app, query } = buildApp()
    await app.register(livesRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/lives?registro=1&paginado=1' })
    expect(res.statusCode).toBe(200)
    const sql = query.mock.calls[0][0]
    expect(sql).toContain("s.status = 'pendente'")
    expect(sql).not.toContain("s.status IN ('pendente','devolvida')")
    expect(sql).toContain('l.arquivada_em IS NULL')
    await app.close()
  })

  it('mantém o envio devolvido na lista da apresentadora', () => {
    const portal = readFileSync(new URL('../src/routes/portal_apresentadora.js', import.meta.url), 'utf8')
    const start = portal.indexOf("app.get('/v1/portal/apresentadora/lives'")
    const livesQuery = portal.slice(start, portal.indexOf("app.post('/v1/portal/apresentadora/submissoes'", start))
    expect(livesQuery).toContain('FROM apresentadora_live_submissoes s')
    expect(livesQuery).not.toContain("s.status <> 'devolvida'")
    expect(livesQuery).not.toContain("s.status = 'pendente'")
  })
})

describe('arquivar e excluir', () => {
  it('arquiva a live sem escrever GMV nem comissão', async () => {
    const query = vi.fn(async (sql) => {
      if (/SELECT id, status/i.test(sql) && /FROM lives/i.test(sql)) {
        return { rows: [{ id: liveId, status: 'encerrada' }] }
      }
      if (/UPDATE lives/i.test(sql) && /arquivada_em/i.test(sql)) {
        return { rows: [{ id: liveId, arquivada_em: '2026-09-24T12:00:00Z' }] }
      }
      return { rows: [] }
    })
    const { app } = buildApp({ queryMock: query })
    await app.register(livesRoutes)
    const res = await app.inject({ method: 'POST', url: `/v1/lives/${liveId}/arquivar` })
    expect(res.statusCode).toBe(200)
    const update = query.mock.calls.map(([sql]) => sql).find((sql) => /UPDATE lives/i.test(sql))
    expect(update).toContain('arquivada_em = COALESCE(arquivada_em, NOW())')
    expect(update).not.toMatch(/fat_gerado|manual_gmv|comissao_|vendas_atribuidas/i)
    await app.close()
  })

  it('gestor exclui live com venda atribuída e não mexe na comissão de outra live', async () => {
    const otherLiveId = '99999999-9999-4999-8999-999999999999'
    const submissionId = '33333333-3333-4333-8333-333333333333'
    const query = vi.fn(async (sql) => {
      if (/SELECT id, status/i.test(sql) && /FROM lives/i.test(sql)) {
        return {
          rows: [{
            id: liveId,
            status: 'encerrada',
            fat_gerado: '320.50',
            manual_gmv: null,
            comissao_apresentadora_valor: '40.00',
            tem_venda_atribuida: true,
          }],
        }
      }
      if (/UPDATE apresentadora_live_submissoes/i.test(sql) && /live_oficial_excluida_id/i.test(sql)) {
        return { rows: [{ id: submissionId, versao: 2 }] }
      }
      return { rows: [] }
    })
    const { app } = buildApp({ papel: 'franqueado', queryMock: query })
    await app.register(livesRoutes)
    const res = await app.inject({ method: 'DELETE', url: `/v1/lives/${liveId}` })
    expect(res.statusCode).toBe(204)

    const calls = query.mock.calls.map(([sql, params]) => ({ sql, params: params ?? [] }))
    const vendas = calls.find(({ sql }) => /DELETE FROM vendas_atribuidas/i.test(sql))
    const revisoes = calls.find(({ sql }) => /DELETE FROM live_metric_revisions/i.test(sql))
    const apagouLive = calls.find(({ sql }) => /DELETE FROM lives/i.test(sql))
    expect(vendas?.sql).toMatch(/origem\s*=\s*'live'/i)
    expect(vendas?.sql).toMatch(/origem_id\s*=\s*\$1/i)
    expect(vendas?.sql).toMatch(/tenant_id\s*=\s*\$2/i)
    expect(vendas?.params).toEqual([liveId, 'tenant-1'])
    expect(revisoes?.sql).toMatch(/live_id\s*=\s*\$1/i)
    expect(revisoes?.sql).toMatch(/tenant_id\s*=\s*\$2/i)
    expect(revisoes?.params).toEqual([liveId, 'tenant-1'])
    expect(apagouLive?.params).toEqual([liveId, 'tenant-1'])

    const tombstone = calls.find(({ sql }) => /UPDATE apresentadora_live_submissoes/i.test(sql))
    expect(tombstone?.sql).toMatch(/live_oficial_excluida_id/i)
    expect(tombstone?.params).toEqual(['tenant-1', liveId])
    const historico = calls.find(({ sql }) => /live_oficial_excluida/i.test(sql) && /INSERT INTO apresentadora_live_submissao_historico/i.test(sql))
    expect(historico?.params?.[1]).toBe(submissionId)

    const params = calls.flatMap(({ params: values }) => values)
    expect(params).not.toContain(otherLiveId)
    expect(calls.some(({ sql }) => /UPDATE\s+lives/i.test(sql))).toBe(false)
    expect(calls.some(({ sql }) => /comissao_\w*\s*=\s*0|manual_gmv\s*=\s*0|fat_gerado\s*=\s*0|ads_gmv\s*=\s*0/i.test(sql))).toBe(false)
    expect(res.body).not.toContain('LIVE_COM_HISTORICO_FINANCEIRO')
    await app.close()
  })

  it('apresentador não exclui a live', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const { app } = buildApp({ papel: 'apresentador', queryMock: query })
    await app.register(livesRoutes)
    const res = await app.inject({ method: 'DELETE', url: `/v1/lives/${liveId}` })
    expect(res.statusCode).toBe(403)
    expect(query.mock.calls.some(([sql]) => /DELETE FROM lives/i.test(sql))).toBe(false)
    await app.close()
  })

  it('arquiva envio sem alterar o GMV declarado', async () => {
    const submissionId = '22222222-2222-4222-8222-222222222222'
    const query = vi.fn(async (sql) => {
      if (/UPDATE apresentadora_live_submissoes/i.test(sql)) {
        return { rows: [{ id: submissionId, status: 'cancelada', arquivamento_status: 'confirmado', versao: 4, gmv_declarado: '890.00' }] }
      }
      return { rows: [] }
    })
    const { app } = buildApp({ queryMock: query })
    await app.register(livesRoutes)
    const res = await app.inject({ method: 'POST', url: `/v1/lives/submissoes-apresentadoras/${submissionId}/arquivar` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: submissionId, status: 'cancelada', arquivamento_status: 'confirmado', versao: 4 })
    expect(res.json().gmv_declarado).toBeUndefined()
    const update = query.mock.calls.map(([sql]) => sql).find((sql) => /UPDATE apresentadora_live_submissoes/i.test(sql))
    expect(update).not.toMatch(/gmv_declarado\s*=/)
    await app.close()
  })

  it('registra a migration 161 sem reutilizar 158–160', () => {
    const registry = readFileSync(new URL('../apply_migrations.js', import.meta.url), 'utf8')
    expect(registry).toContain('160_lives_cabine_opcional.sql')
    expect(registry).toContain('161_lives_gestor_arquivada.sql')
    expect(registry).not.toContain('162_')
    const migration = readFileSync(new URL('../migrations/161_lives_gestor_arquivada.sql', import.meta.url), 'utf8')
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS arquivada_em')
  })
})
