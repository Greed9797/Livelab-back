// Regressão: GET listagens devem excluir registros soft-deletados por default.
// Causa raiz: DELETE marca status='cancelado' / ativo=false; GETs sem filtro
// retornavam soft-deletados → registros reapareciam após DELETE na UI.

import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { agendaRoutes } from '../src/routes/agenda.js'
import { apresentadorasRoutes } from '../src/routes/apresentadoras.js'
import { pacotesRoutes } from '../src/routes/pacotes.js'
import { usuariosRoutes } from '../src/routes/usuarios.js'
import { marcasRoutes } from '../src/routes/marcas.js'

function buildApp({ papel = 'franqueado' } = {}) {
  const app = Fastify()
  const query = vi.fn().mockResolvedValue({ rows: [] })
  const release = vi.fn()

  app.decorate('authenticate', async (request) => {
    request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel }
  })
  app.decorate('requirePapel', () => async (request) => {
    if (!request.user) request.user = { tenant_id: 'tenant-1', sub: 'user-1', papel }
  })
  app.decorate('withTenant', async (_tid, fn) => {
    try { return await fn({ query }) } finally { release() }
  })
  app.decorate('audit', { log: async () => {} })

  return { app, query }
}

function getSqlFromLastCall(query) {
  const call = query.mock.calls[query.mock.calls.length - 1]
  return String(call?.[0] ?? '')
}

describe('Soft-delete leakage — GET listagens excluem soft-deletados por default', () => {
  describe('GET /v1/agenda', () => {
    it('exclui status=cancelado por default', async () => {
      const { app, query } = buildApp()
      await app.register(agendaRoutes)
      const res = await app.inject({ method: 'GET', url: '/v1/agenda' })
      expect(res.statusCode).toBe(200)
      const sql = getSqlFromLastCall(query)
      expect(sql).toContain(`ae.status <> 'cancelado'`)
      await app.close()
    })

    it('?status=all bypassa o default', async () => {
      const { app, query } = buildApp()
      await app.register(agendaRoutes)
      const res = await app.inject({ method: 'GET', url: '/v1/agenda?status=all' })
      expect(res.statusCode).toBe(200)
      const sql = getSqlFromLastCall(query)
      expect(sql).not.toContain(`ae.status <> 'cancelado'`)
      expect(sql).not.toContain('ae.status = $')
      await app.close()
    })

    it('?status=planejado filtra exato', async () => {
      const { app, query } = buildApp()
      await app.register(agendaRoutes)
      const res = await app.inject({ method: 'GET', url: '/v1/agenda?status=planejado' })
      expect(res.statusCode).toBe(200)
      const call = query.mock.calls[query.mock.calls.length - 1]
      const sql = String(call[0])
      const values = call[1]
      expect(sql).toContain('ae.status = $')
      expect(values).toContain('planejado')
      await app.close()
    })
  })

  describe('GET /v1/apresentadoras', () => {
    it('exclui ativo=false por default', async () => {
      const { app, query } = buildApp()
      await app.register(apresentadorasRoutes)
      const res = await app.inject({ method: 'GET', url: '/v1/apresentadoras' })
      expect(res.statusCode).toBe(200)
      const sql = getSqlFromLastCall(query)
      expect(sql).toContain('a.ativo IS NOT FALSE')
      await app.close()
    })

    it('?include_inactive=true bypassa', async () => {
      const { app, query } = buildApp()
      await app.register(apresentadorasRoutes)
      const res = await app.inject({ method: 'GET', url: '/v1/apresentadoras?include_inactive=true' })
      expect(res.statusCode).toBe(200)
      const sql = getSqlFromLastCall(query)
      expect(sql).not.toContain('a.ativo IS NOT FALSE')
      await app.close()
    })
  })

  describe('GET /v1/pacotes', () => {
    it('exclui ativo=false por default', async () => {
      const { app, query } = buildApp()
      await app.register(pacotesRoutes)
      const res = await app.inject({ method: 'GET', url: '/v1/pacotes' })
      expect(res.statusCode).toBe(200)
      const sql = getSqlFromLastCall(query)
      expect(sql).toContain('ativo IS NOT FALSE')
      await app.close()
    })

    it('?include_inactive=true bypassa', async () => {
      const { app, query } = buildApp()
      await app.register(pacotesRoutes)
      const res = await app.inject({ method: 'GET', url: '/v1/pacotes?include_inactive=true' })
      expect(res.statusCode).toBe(200)
      const sql = getSqlFromLastCall(query)
      expect(sql).not.toContain('ativo IS NOT FALSE')
      await app.close()
    })
  })

  describe('GET /v1/usuarios', () => {
    it('exclui ativo=false por default', async () => {
      const { app, query } = buildApp({ papel: 'franqueado' })
      await app.register(usuariosRoutes)
      const res = await app.inject({ method: 'GET', url: '/v1/usuarios' })
      expect(res.statusCode).toBe(200)
      const sql = getSqlFromLastCall(query)
      expect(sql).toContain('u.ativo IS NOT FALSE')
      await app.close()
    })

    it('?ativo=true filtra exato', async () => {
      const { app, query } = buildApp({ papel: 'franqueado' })
      await app.register(usuariosRoutes)
      const res = await app.inject({ method: 'GET', url: '/v1/usuarios?ativo=true' })
      expect(res.statusCode).toBe(200)
      const sql = getSqlFromLastCall(query)
      expect(sql).toContain('u.ativo = $')
      expect(sql).not.toContain('u.ativo IS NOT FALSE')
      await app.close()
    })
  })

  describe('GET /v1/marcas', () => {
    it('exclui status=inativa por default', async () => {
      const { app, query } = buildApp()
      await app.register(marcasRoutes)
      const res = await app.inject({ method: 'GET', url: '/v1/marcas' })
      expect(res.statusCode).toBe(200)
      const sql = getSqlFromLastCall(query)
      expect(sql).toContain(`m.status <> 'inativa'`)
      await app.close()
    })

    it('?status=all bypassa', async () => {
      const { app, query } = buildApp()
      await app.register(marcasRoutes)
      const res = await app.inject({ method: 'GET', url: '/v1/marcas?status=all' })
      expect(res.statusCode).toBe(200)
      const sql = getSqlFromLastCall(query)
      expect(sql).not.toContain(`m.status <> 'inativa'`)
      await app.close()
    })
  })
})
