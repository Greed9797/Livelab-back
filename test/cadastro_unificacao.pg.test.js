// Cadastro unificado (F1–F4) com Postgres real. Só roda com TEST_PG_URL num banco com o
// schema completo (scripts/setup_fresh_schema.js + apply_migrations.js). Rodar com
// --no-file-parallelism (o teste recria o gatilho da 175 e reaplica 174–176).
//
// Dados fictícios: marca de cliente com live importada sem cliente_id e lives em união,
// cliente com 2 marcas (cliente + afiliada vinculada), afiliada sem cliente com % 100,
// marca própria, marca-sistema e um segundo tenant (isolamento).
import fs from 'node:fs'
import pg from 'pg'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import '../src/lib/pg-date-string.js'
import { calcularReceitasComerciais, gerarTitulosReceita, listarTitulosReceita } from '../src/services/receitas-comercial.js'
import { getPerformanceRanking } from '../src/lib/performance-rollups.js'
import { financeiroRoutes } from '../src/routes/financeiro.js'
import { _clearDashboardCache } from '../src/lib/dashboard-cache.js'
import {
  atualizarCadastro, criarCadastro, listarCadastros, obterCadastro, promoverACliente,
} from '../src/services/cadastros.js'

const url = process.env.TEST_PG_URL
const HOJE = '2026-09-15'
const sqlDe = (arquivo) => fs.readFileSync(`migrations/${arquivo}`, 'utf8')
const SQL174 = sqlDe('174_cadastro_unificado_diagnostico.sql')
const SQL175 = sqlDe('175_lives_cliente_da_marca.sql')
const SQL176 = sqlDe('176_lives_cliente_id_backfill.sql')
const ROLLBACK = fs.readFileSync('docs/ops/rollback-175-176-lives-cliente-id.sql', 'utf8')

describe.skipIf(!url)('cadastro unificado (Postgres real)', () => {
  let pool
  let t
  let t2
  const ids = {}
  const q = (sql, params) => pool.query(sql, params)

  const cliente = async (tenant, nome) => (await q(
    `INSERT INTO clientes (tenant_id, nome, celular, status) VALUES ($1, $2, '47999990000', 'ativo') RETURNING id`,
    [tenant, nome],
  )).rows[0].id
  const marca = async (tenant, nome, tipo, clienteId = null, extra = {}) => (await q(
    `INSERT INTO marcas (tenant_id, cliente_id, nome, tipo, data_inicio, sistema)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, false)) RETURNING id`,
    [tenant, clienteId, nome, tipo, extra.data_inicio ?? null, extra.sistema ?? null],
  )).rows[0].id
  const condicao = (tenant, marcaId, inicio, fixo, pct) => q(
    `INSERT INTO marca_condicoes_comerciais (tenant_id, marca_id, inicio_vigencia, fixo_mensal, comissao_franquia_pct,
       tipo_cobranca, fixo_confirmado, comissao_confirmada, origem)
     VALUES ($1, $2, $3, $4, $5, 'fixo_mais_comissao', true, true, 'gestao')`,
    [tenant, marcaId, inicio, fixo, pct],
  )
  const live = async (tenant, marcaId, dia, gmv, clienteId = null) => (await q(
    `INSERT INTO lives (tenant_id, marca_id, cliente_id, status, iniciado_em, encerrado_em, fat_gerado)
     VALUES ($1, $2, $3, 'encerrada', $4::timestamptz, $4::timestamptz + interval '2 hours', $5) RETURNING id`,
    [tenant, marcaId, clienteId, `${dia}T15:00:00-03:00`, gmv],
  )).rows[0].id
  const clienteDaLive = async (id) => (await q('SELECT cliente_id FROM lives WHERE id = $1', [id])).rows[0].cliente_id

  // Fotografia dos dados do tenant (para provar que 174 não muda nada e que dinheiro não muda).
  const foto = async (tenant) => (await q(
    `SELECT
       (SELECT md5(COALESCE(json_agg(x ORDER BY x.id)::text, '')) FROM (SELECT id, nome, tipo, status, cliente_id, sistema, data_inicio, tiktok_username FROM marcas WHERE tenant_id = $1) x) AS marcas,
       (SELECT md5(COALESCE(json_agg(x ORDER BY x.id)::text, '')) FROM (SELECT id, nome, status, deleted_at, tiktok_username FROM clientes WHERE tenant_id = $1) x) AS clientes,
       (SELECT md5(COALESCE(json_agg(x ORDER BY x.id)::text, '')) FROM (SELECT id, marca_id, cliente_id, fat_gerado, status FROM lives WHERE tenant_id = $1) x) AS lives,
       (SELECT md5(COALESCE(json_agg(x ORDER BY x.id)::text, '')) FROM (SELECT * FROM receita_titulos WHERE tenant_id = $1) x) AS receita_titulos`,
    [tenant],
  )).rows[0]

  // Equivalência de dinheiro (decisão: totais de receita por mês e por marca tipo cliente idênticos).
  const dinheiro = async (tenant) => {
    const calc = await calcularReceitasComerciais(pool, { tenantId: tenant, inicio: '2026-07', fim: '2026-09' })
    const titulos = await listarTitulosReceita(pool, { tenantId: tenant, inicio: '2026-07', fim: '2026-09', hoje: HOJE })
    const norm = (xs) => xs
      .map((x) => `${x.marca_id}|${String(x.competencia).slice(0, 7)}|${x.componente}|${Number(x.valor_previsto ?? x.valor ?? 0).toFixed(2)}|${Number(x.valor_pago ?? 0).toFixed(2)}`)
      .sort()
    const agregado = await q(
      `SELECT competencia::text, componente, count(*)::int AS n, sum(valor_previsto)::text AS previsto, sum(valor_pago)::text AS pago
         FROM receita_titulos WHERE tenant_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`,
      [tenant],
    )
    return { calc: norm(calc), titulos: norm(titulos), agregado: agregado.rows }
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 })
    // Estado pré-175: sem o gatilho, lives importadas nascem com cliente_id NULL.
    await q('DROP TRIGGER IF EXISTS lives_cliente_da_marca ON lives')
    t = (await q(`INSERT INTO tenants (nome) VALUES ('t-cadastro') RETURNING id`)).rows[0].id
    t2 = (await q(`INSERT INTO tenants (nome) VALUES ('t-cadastro-outro') RETURNING id`)).rows[0].id

    ids.c1 = await cliente(t, 'Alfa')
    ids.alfa = await marca(t, 'Alfa', 'cliente', ids.c1, { data_inicio: '2026-01-01' })
    await condicao(t, ids.alfa, '2026-01-01', 1000, 10)
    ids.c2 = await cliente(t, 'Beta')
    ids.beta = await marca(t, 'Beta', 'cliente', ids.c2, { data_inicio: '2026-01-01' })
    await condicao(t, ids.beta, '2026-01-01', 0, 5)
    ids.betaAfi = await marca(t, 'Beta Afiliada', 'afiliada', ids.c2)
    await condicao(t, ids.betaAfi, '2026-01-01', 0, 10)
    ids.gama = await marca(t, 'Gama', 'afiliada')
    await condicao(t, ids.gama, '2026-01-01', 0, 100)
    ids.delta = await marca(t, 'Delta', 'propria')
    await condicao(t, ids.delta, '2026-01-01', 0, 5)
    ids.sistema = await marca(t, 'Livelab Sistema T', 'propria', null, { sistema: true })
    ids.epsilon = await marca(t, 'Epsilon', 'parceira')

    ids.lImportada = await live(t, ids.alfa, '2026-08-10', 10000)
    ids.lComCliente = await live(t, ids.alfa, '2026-08-12', 5000, ids.c1)
    ids.lBeta = await live(t, ids.beta, '2026-08-13', 4000)
    ids.lBetaAfi = await live(t, ids.betaAfi, '2026-08-14', 1000)
    ids.lGama = await live(t, ids.gama, '2026-08-15', 700)
    ids.lDelta = await live(t, ids.delta, '2026-08-16', 2000)
    ids.lSistema = await live(t, ids.sistema, '2026-08-17', 500)

    // União: destino (GMV 3000) + origem absorvida, ambos sem cliente_id em marca de cliente.
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query("SET LOCAL livelab.live_merge_write = 'on'")
      ids.uniao = (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id
      ids.lDestino = (await c.query(
        `INSERT INTO lives (tenant_id, marca_id, status, iniciado_em, encerrado_em, fat_gerado, uniao_id)
         VALUES ($1, $2, 'encerrada', '2026-08-20T15:00:00-03:00', '2026-08-20T19:00:00-03:00', 3000, $3) RETURNING id`,
        [t, ids.alfa, ids.uniao],
      )).rows[0].id
      await c.query(
        `INSERT INTO live_unioes (id, tenant_id, live_destino_id, request_id, request_hash, preview_token, origens, resultado, motivo)
         VALUES ($1, $2, $3, gen_random_uuid(), 'h', 'p', '[]'::jsonb, '{}'::jsonb, 'teste')`,
        [ids.uniao, t, ids.lDestino],
      )
      ids.lOrigem = (await c.query(
        `INSERT INTO lives (tenant_id, marca_id, status, iniciado_em, encerrado_em, fat_gerado, uniao_destino_id)
         VALUES ($1, $2, 'encerrada', '2026-08-20T15:00:00-03:00', '2026-08-20T17:00:00-03:00', 1234, $3) RETURNING id`,
        [t, ids.alfa, ids.lDestino],
      )).rows[0].id
      await c.query('COMMIT')
    } catch (err) {
      await c.query('ROLLBACK')
      throw err
    } finally {
      c.release()
    }

    ids.c3 = await cliente(t2, 'Outro')
    ids.outra = await marca(t2, 'Outra', 'cliente', ids.c3, { data_inicio: '2026-01-01' })
    ids.lOutra = await live(t2, ids.outra, '2026-08-10', 999)

    // Títulos reais de agosto antes das migrations (devem ficar intocados).
    await gerarTitulosReceita(pool, { tenantId: t, mes: '2026-08', hoje: HOJE })
  })

  afterAll(async () => {
    if (!pool) return
    // Garante o gatilho no estado migrado (o teste o derrubou no início).
    await q(SQL175).catch(() => {})
    const tenants = [t, t2].filter(Boolean)
    await q('DELETE FROM migr176_lives_cliente_id_backup WHERE tenant_id = ANY($1::uuid[])', [tenants]).catch(() => {})
    await q("SET livelab.live_merge_write = 'on'").catch(() => {})
    await q('UPDATE lives SET uniao_destino_id = NULL, uniao_id = NULL WHERE tenant_id = ANY($1::uuid[])', [tenants]).catch(() => {})
    for (const tb of ['live_unioes', 'lives', 'receita_titulos', 'marca_condicoes_comerciais', 'apresentadora_marcas', 'marcas', 'clientes']) {
      await q(`DELETE FROM ${tb} WHERE tenant_id = ANY($1::uuid[])`, [tenants]).catch(() => {})
    }
    await q('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenants]).catch(() => {})
    await pool.end()
  })

  it('174 não altera dado nenhum (aplicada 2x)', async () => {
    const antes = [await foto(t), await foto(t2)]
    await q(SQL174)
    await q(SQL174)
    expect([await foto(t), await foto(t2)]).toEqual(antes)
  })

  it('175 + 176: preenche só cliente_id NULL de marca tipo cliente, pula união, idempotente e sem mexer em dinheiro', async () => {
    const dinheiroAntes = await dinheiro(t)
    const titulosAntes = (await foto(t)).receita_titulos
    expect(dinheiroAntes.calc.length).toBeGreaterThan(0)
    expect(dinheiroAntes.agregado.length).toBeGreaterThan(0)

    await q(SQL175)
    await q(SQL175)
    await q(SQL176)
    expect(await clienteDaLive(ids.lImportada)).toBe(ids.c1)
    expect(await clienteDaLive(ids.lComCliente)).toBe(ids.c1)
    expect(await clienteDaLive(ids.lBeta)).toBe(ids.c2)
    expect(await clienteDaLive(ids.lBetaAfi)).toBeNull() // afiliada vinculada a cliente: não é marca tipo cliente
    expect(await clienteDaLive(ids.lGama)).toBeNull()
    expect(await clienteDaLive(ids.lDelta)).toBeNull()
    expect(await clienteDaLive(ids.lSistema)).toBeNull()
    expect(await clienteDaLive(ids.lDestino)).toBeNull() // união: não tocada
    expect(await clienteDaLive(ids.lOrigem)).toBeNull()
    expect(await clienteDaLive(ids.lOutra)).toBe(ids.c3) // tenant isolado
    const backup = (await q(
      'SELECT live_id, cliente_id_novo FROM migr176_lives_cliente_id_backup WHERE tenant_id = ANY($1::uuid[]) ORDER BY live_id',
      [[t, t2]],
    )).rows
    expect(backup.map((b) => b.live_id).sort()).toEqual([ids.lImportada, ids.lBeta, ids.lOutra].sort())

    const depoisPrimeira = [await foto(t), await foto(t2)]
    await q(SQL176) // 2ª vez: nada muda
    expect([await foto(t), await foto(t2)]).toEqual(depoisPrimeira)
    expect((await q('SELECT count(*)::int AS n FROM migr176_lives_cliente_id_backup WHERE tenant_id = ANY($1::uuid[])', [[t, t2]])).rows[0].n).toBe(3)

    // Dinheiro idêntico: receitas calculadas, títulos listados e receita_titulos.
    expect(await dinheiro(t)).toEqual(dinheiroAntes)
    expect((await foto(t)).receita_titulos).toBe(titulosAntes)
  })

  it('175: gatilho em INSERT/UPDATE de marca_id; respeita cliente_id informado e união', async () => {
    const nova = await live(t, ids.alfa, '2026-09-01', 0)
    expect(await clienteDaLive(nova)).toBe(ids.c1)
    const explicita = await live(t, ids.alfa, '2026-09-02', 0, ids.c2)
    expect(await clienteDaLive(explicita)).toBe(ids.c2)
    const afi = await live(t, ids.gama, '2026-09-03', 0)
    expect(await clienteDaLive(afi)).toBeNull()
    await q('UPDATE lives SET resumo = $2 WHERE id = $1', [afi, 'x'])
    expect(await clienteDaLive(afi)).toBeNull()
    await q('UPDATE lives SET marca_id = $2 WHERE id = $1', [afi, ids.beta])
    expect(await clienteDaLive(afi)).toBe(ids.c2)
    // Live de união: atualização de coluna derivada passa pelo guard e o gatilho não age.
    await q('UPDATE lives SET comissao_calculada = 1 WHERE id = $1', [ids.lDestino])
    expect(await clienteDaLive(ids.lDestino)).toBeNull()
    // Mudar a marca de live de união continua bloqueado pelo guard (não pelo gatilho).
    await expect(q('UPDATE lives SET marca_id = $2 WHERE id = $1', [ids.lDestino, ids.beta]))
      .rejects.toMatchObject({ code: '23514' })
    await q('DELETE FROM lives WHERE id = ANY($1::uuid[])', [[nova, explicita, afi]])
  })

  it('rollback manual restaura cliente_id NULL e a 176 reaplica igual', async () => {
    await q(ROLLBACK)
    expect(await clienteDaLive(ids.lImportada)).toBeNull()
    expect(await clienteDaLive(ids.lBeta)).toBeNull()
    expect(await clienteDaLive(ids.lComCliente)).toBe(ids.c1) // não era da 176
    expect(await clienteDaLive(ids.lOutra)).toBeNull()
    await q(SQL176)
    expect(await clienteDaLive(ids.lImportada)).toBe(ids.c1)
    expect(await clienteDaLive(ids.lBeta)).toBe(ids.c2)
    expect(await clienteDaLive(ids.lOutra)).toBe(ids.c3)
  })

  it('F4b: Comissões/Ranking — comissão de franquia só de marca tipo cliente; GMV intacto', async () => {
    const rows = await getPerformanceRanking(pool, {
      tenantId: t, range: { start: '2026-08-01', end: '2026-09-01', mes: '2026-08' }, groupBy: 'marca', limit: 100,
    })
    const por = Object.fromEntries(rows.map((r) => [r.marca_id, r]))
    // Alfa: (10000 + 5000 + 3000 destino da união) × 10% + fixo 1000. Beta: 4000 × 5%.
    expect(por[ids.alfa].comissao_franquia).toBeCloseTo(2800, 2)
    expect(por[ids.beta].comissao_franquia).toBeCloseTo(200, 2)
    for (const id of [ids.betaAfi, ids.gama, ids.delta, ids.sistema]) {
      expect(por[id].comissao_franquia).toBe(0)
      expect(por[id].comissao_fixo).toBe(0)
    }
    expect(por[ids.gama].gmv_total).toBe(700)
    expect(por[ids.betaAfi].gmv_total).toBe(1000)
    const gmv = rows.reduce((s, r) => s + r.gmv_total, 0)
    expect(gmv).toBe(10000 + 5000 + 3000 + 4000 + 1000 + 700 + 2000 + 500)
  })

  it('F4b: /resumo legado — receita igual à receita comercial (sem GMV × % de não-cliente)', async () => {
    _clearDashboardCache()
    const app = Fastify()
    app.decorate('requirePapel', () => async (request) => { request.user = { tenant_id: t, papel: 'franqueado', sub: null } })
    app.decorate('withTenant', async (_tenant, fn) => fn(pool))
    await app.register(financeiroRoutes)
    const res = await app.inject({ method: 'GET', url: '/v1/financeiro/resumo?inicio=2026-08&fim=2026-08' })
    expect(res.statusCode).toBe(200)
    const r = res.json()
    expect(r.gmv_lives).toBe(10000 + 5000 + 3000 + 4000 + 1000 + 700 + 2000 + 500)
    expect(r.comissao_franquia_lives).toBeCloseTo(1800 + 200, 2)
    expect(r.receita_liquida).toBeCloseTo(3000, 2)
    const calc = await calcularReceitasComerciais(pool, { tenantId: t, inicio: '2026-08', fim: '2026-08' })
    const totalCalc = calc.reduce((s, x) => s + Number(x.valor_previsto ?? x.valor ?? 0), 0)
    expect(r.receita_liquida).toBeCloseTo(totalCalc, 2)
    await app.close()
  })

  it('F1: GET de cadastros — tipo, gera_receita, ficha só na marca de cliente, aceita cliente_id', async () => {
    const lista = await listarCadastros(pool, { tenantId: t, status: 'all' })
    const por = Object.fromEntries(lista.map((c) => [c.marca_id, c]))
    expect(por[ids.alfa]).toMatchObject({ id: ids.alfa, tipo: 'cliente', cliente_id: ids.c1, gera_receita: true, status_comercial: 'ativo', celular: '47999990000' })
    expect(por[ids.betaAfi]).toMatchObject({ tipo: 'afiliada', cliente_id: null, gera_receita: false, celular: null })
    expect(por[ids.sistema]).toMatchObject({ sistema: true, gera_receita: false })
    expect(lista.every((c) => c.tenant_id === t)).toBe(true)
    expect((await listarCadastros(pool, { tenantId: t, geraReceita: true })).map((c) => c.marca_id).sort()).toEqual([ids.alfa, ids.beta].sort())
    expect((await listarCadastros(pool, { tenantId: t, incluirSistema: false, status: 'all' })).some((c) => c.sistema)).toBe(false)
    expect((await obterCadastro(pool, { tenantId: t, id: ids.c2 })).marca_id).toBe(ids.beta)
    expect(await obterCadastro(pool, { tenantId: t2, id: ids.alfa })).toBeNull() // outro tenant
  })

  it('F1: criar/editar/promover sem mexer na receita de agosto', async () => {
    const antes = await dinheiro(t)
    const nova = await criarCadastro(pool, { tenantId: t, dados: { nome: 'Zeta', celular: '47', cnpj: '9', cor: '#112233' } })
    expect(nova).toMatchObject({ tipo: 'cliente', gera_receita: true, cnpj: '9', cor: '#112233' })
    const editada = await atualizarCadastro(pool, { tenantId: t, id: nova.cliente_id, dados: { nome: 'Zeta 2', email: 'z@z' } })
    expect(editada).toMatchObject({ nome: 'Zeta 2', cliente_nome: 'Zeta 2', email: 'z@z' })
    // Gama tem condição de 100% desde janeiro: promover exige confirmação.
    await expect(promoverACliente(pool, { tenantId: t, id: ids.gama, dados: { celular: '1' } }))
      .rejects.toMatchObject({ statusCode: 409, code: 'PROMOCAO_CONDICAO_RETROATIVA' })
    expect((await obterCadastro(pool, { tenantId: t, id: ids.gama })).tipo).toBe('afiliada')
    // Epsilon (sem condição > 0) vira cliente a partir de data_inicio.
    const promovida = await promoverACliente(pool, { tenantId: t, id: ids.epsilon, dados: { celular: '2', data_inicio: '2026-10-01' } })
    expect(promovida.cadastro).toMatchObject({ tipo: 'cliente', gera_receita: true, data_inicio: '2026-10-01' })
    expect(promovida.cadastro.cliente_id).toBeTruthy()
    expect(await dinheiro(t)).toEqual(antes)
  })

  it('F2: cliente apagado derruba o cadastro para arquivada', async () => {
    await q('UPDATE clientes SET deleted_at = NOW() WHERE id = $1', [ids.c2])
    const beta = await obterCadastro(pool, { tenantId: t, id: ids.beta })
    expect(beta.status_operacional).toBe('arquivada')
    expect((await listarCadastros(pool, { tenantId: t })).some((c) => c.marca_id === ids.beta)).toBe(false)
  })
})
