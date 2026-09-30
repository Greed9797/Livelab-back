import Fastify from 'fastify'
import { readFileSync, existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { financeiroCustosRoutes, importarSchema } from '../src/routes/financeiro_custos.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const URL_IMP = '/v1/financeiro/custos/importar'
const SEED = new URL('./fixtures/seed-custos-planilha.json', import.meta.url)

// Fake db com estado em memória: SELECT de existência + INSERTs.
function fakeDb() {
  const recs = []
  const custos = []
  const calls = []
  let n = 0
  const query = vi.fn(async (sql, params) => {
    const s = String(sql)
    calls.push({ sql: s, params })
    if (/gen_random_uuid/.test(s)) return { rows: [{ id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` }] }
    if (/SELECT id FROM custos_recorrentes/.test(s)) {
      const [, nome, grupo, dia] = params
      return { rows: recs.filter((r) => r.nome.toLowerCase() === nome.toLowerCase() && r.grupo === grupo && r.dia === dia).map(() => ({ id: 'x' })) }
    }
    if (/SELECT id FROM custos/.test(s)) {
      const [, desc, venc, valor] = params
      return { rows: custos.filter((c) => c.desc === desc && c.venc === venc && c.valor === valor).map(() => ({ id: 'x' })) }
    }
    if (/INSERT INTO custos_recorrentes/.test(s)) {
      recs.push({ nome: params[1], grupo: params[3], dia: params[5] })
      return { rows: [], rowCount: 1 }
    }
    if (/INSERT INTO custos/.test(s)) {
      custos.push({ desc: params[1], valor: params[2], venc: params[5], params, sql: s })
      return { rows: [], rowCount: 1 }
    }
    return { rows: [] }
  })
  return { query, calls, recs, custos }
}

function buildApp(db) {
  const app = Fastify()
  app.decorate('requirePapel', () => async (request) => {
    request.user = { tenant_id: tenantId, sub: 'u1', papel: 'financeiro' }
  })
  app.decorate('withTenant', async (_t, fn) => fn(db))
  app.decorate('audit', { log: async () => {} })
  return app
}

const rec = (o = {}) => ({ nome: 'Aluguel', grupo: 'estrutural', valor: 3000, dia_vencimento: 10, mes_offset: 0, inicio: '2026-09-01', fim: null, ...o })
const pon = (o = {}) => ({ descricao: 'Notebook', grupo: 'investimento', valor: 500.5, data_vencimento: '2026-09-05', competencia: '2026-09-01', ...o })

async function setup() {
  const db = fakeDb()
  const app = buildApp(db)
  await app.register(financeiroCustosRoutes)
  return { db, app }
}
const post = (app, payload) => app.inject({ method: 'POST', url: URL_IMP, payload })

describe('POST /custos/importar', () => {
  it('cria recorrentes e pontuais (inclui parcela com grupo compartilhado)', async () => {
    const { db, app } = await setup()
    const res = await post(app, {
      recorrentes: [rec(), rec({ nome: 'Condomínio', descricao: 'x' })],
      pontuais: [
        pon(),
        pon({ descricao: 'iPhone — parcela 1/2', data_vencimento: '2026-09-05', parcela_num: 1, parcelas_total: 2 }),
        pon({ descricao: 'iPhone — parcela 2/2', data_vencimento: '2026-10-05', competencia: '2026-10-15', parcela_num: 2, parcelas_total: 2 }),
      ],
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      dry_run: false,
      recorrentes: { criados: 2, ignorados: 0, itens: [{ nome: 'Aluguel', acao: 'criado' }, { nome: 'Condomínio', acao: 'criado' }] },
      pontuais: {
        criados: 3, ignorados: 0,
        itens: [
          { descricao: 'Notebook', acao: 'criado' },
          { descricao: 'iPhone — parcela 1/2', acao: 'criado' },
          { descricao: 'iPhone — parcela 2/2', acao: 'criado' },
        ],
      },
    })
    expect(db.recs).toHaveLength(2)
    expect(db.custos).toHaveLength(3)
    const [avulso, p1, p2] = db.custos
    expect(avulso.sql).toMatch(/'outros'/)
    expect(p1.sql).toMatch(/'parcela'/)
    expect(p1.params[6]).toBe(p2.params[6]) // mesmo parcela_grupo_id
    expect(p2.params[4]).toBe('2026-10-01') // competência normalizada para dia 1
    expect(p2.params[2]).toBe(500.5)
  })

  it('reimportar ignora tudo e não insere', async () => {
    const { db, app } = await setup()
    const payload = { recorrentes: [rec()], pontuais: [pon()] }
    await post(app, payload)
    const inserts = () => db.calls.filter((c) => /INSERT INTO/.test(c.sql)).length
    expect(inserts()).toBe(2)
    const res = await post(app, { ...payload, recorrentes: [rec({ nome: 'ALUGUEL' })] }) // case-insensitive
    const b = res.json()
    expect(b.recorrentes).toEqual({ criados: 0, ignorados: 1, itens: [{ nome: 'ALUGUEL', acao: 'ignorado' }] })
    expect(b.pontuais).toEqual({ criados: 0, ignorados: 1, itens: [{ descricao: 'Notebook', acao: 'ignorado' }] })
    expect(inserts()).toBe(2)
  })

  it('duplicata dentro do mesmo payload conta como ignorado', async () => {
    const { db, app } = await setup()
    const res = await post(app, { recorrentes: [rec(), rec()], pontuais: [pon(), pon()] })
    const b = res.json()
    expect([b.recorrentes.criados, b.recorrentes.ignorados, b.pontuais.criados, b.pontuais.ignorados]).toEqual([1, 1, 1, 1])
    expect(db.recs).toHaveLength(1)
    expect(db.custos).toHaveLength(1)
  })

  it('dry_run não grava e devolve o mesmo relatório', async () => {
    const { db, app } = await setup()
    const payload = { recorrentes: [rec(), rec({ nome: 'B' })], pontuais: [pon(), pon({ descricao: 'P', parcela_num: 1, parcelas_total: 2 })] }
    const dry = await post(app, { ...payload, dry_run: true })
    expect(dry.statusCode).toBe(200)
    expect(db.calls.some((c) => /INSERT INTO|gen_random_uuid/.test(c.sql))).toBe(false)
    const real = await post(app, payload)
    expect({ ...dry.json(), dry_run: false }).toEqual(real.json())
    expect(dry.json().dry_run).toBe(true)
  })

  it('valida grupo inválido, dia 32, mes_offset 2, limite de 200 e parcela incompleta', async () => {
    const { app } = await setup()
    expect((await post(app, { recorrentes: [rec({ grupo: 'xpto' })] })).statusCode).toBe(400)
    expect((await post(app, { recorrentes: [rec({ dia_vencimento: 32 })] })).statusCode).toBe(400)
    expect((await post(app, { recorrentes: [rec({ mes_offset: 2 })] })).statusCode).toBe(400)
    expect((await post(app, { pontuais: [pon({ grupo: 'xpto' })] })).statusCode).toBe(400)
    expect((await post(app, { pontuais: [pon({ parcela_num: 1 })] })).statusCode).toBe(400)
    const muitos = await post(app, { recorrentes: Array.from({ length: 201 }, (_, i) => rec({ nome: `r${i}` })) })
    expect(muitos.statusCode).toBe(400)
    expect(muitos.json().error).toMatch(/200/)
    expect((await post(app, { pontuais: Array.from({ length: 201 }, (_, i) => pon({ descricao: `p${i}` })) })).statusCode).toBe(400)
    const ok200 = await post(app, { recorrentes: Array.from({ length: 200 }, (_, i) => rec({ nome: `r${i}` })), dry_run: true })
    expect(ok200.statusCode).toBe(200)
  })

  it('tenant explícito em todas as queries', async () => {
    const { db, app } = await setup()
    await post(app, { recorrentes: [rec()], pontuais: [pon(), pon({ descricao: 'P', parcela_num: 1, parcelas_total: 2 })] })
    const tenantQueries = db.calls.filter((c) => !/gen_random_uuid/.test(c.sql))
    expect(tenantQueries.length).toBeGreaterThanOrEqual(5)
    for (const c of tenantQueries) {
      expect(c.params[0]).toBe(tenantId)
      expect(c.sql).toMatch(/\$1::uuid/)
      if (/^\s*SELECT/.test(c.sql)) expect(c.sql).toMatch(/tenant_id = \$1::uuid/)
    }
  })
})

describe('schema com SEED_CUSTOS.json real', () => {
  it.skipIf(!existsSync(SEED))('payload da planilha é válido', () => {
    const seed = JSON.parse(readFileSync(SEED, 'utf8'))
    const r = importarSchema.safeParse({ recorrentes: seed.recorrentes, pontuais: seed.pontuais, dry_run: true })
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true)
    expect(r.data.recorrentes).toHaveLength(seed.recorrentes.length)
    expect(r.data.pontuais).toHaveLength(seed.pontuais.length)
  })
})
