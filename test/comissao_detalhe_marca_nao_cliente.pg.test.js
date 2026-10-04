// Comissão de franquia no DETALHE por linha (F4b estendida) com Postgres real. Só roda com
// TEST_PG_URL num banco com o schema completo (scripts/setup_fresh_schema.js + apply_migrations.js).
//
// Regra (marcaGeraReceitaSql): só marca tipo 'cliente' e não sistema mostra comissão de franquia.
// Afiliada / própria / parceira / sistema: comissao_franquia exibida = 0; GMV, pedidos, comissão de
// apresentadora e de franqueadora iguais ao gravado. Nada gravado muda (vendas_atribuidas intacta).
// /v1/comissoes/pendentes é fila de aprovação e fica como antes (mostra o gravado).
import pg from 'pg'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import '../src/lib/pg-date-string.js'
import { comissoesRoutes } from '../src/routes/comissoes.js'
import { financeiroRoutes } from '../src/routes/financeiro.js'
import { _clearDashboardCache } from '../src/lib/dashboard-cache.js'

const url = process.env.TEST_PG_URL

describe.skipIf(!url)('comissão de franquia no detalhe — marca não-cliente (Postgres real)', () => {
  let pool
  let t
  let app
  const ids = {}
  const lives = {}
  const q = (sql, params) => pool.query(sql, params)

  // marca → [tipo, % franquia, gmv da live, sistema]
  const MARCAS = {
    alfa: ['cliente', 10, 10000, false],
    betaAfi: ['afiliada', 10, 1000, false], // afiliada vinculada ao cliente Beta
    gama: ['afiliada', 100, 700, false],
    delta: ['propria', 5, 2000, false],
    epsilon: ['parceira', 20, 1500, false],
    sistema: ['propria', 10, 500, true],
  }
  const NAO_CLIENTE = ['betaAfi', 'gama', 'delta', 'epsilon', 'sistema']

  const fotoVendas = async () => (await q(
    `SELECT md5(COALESCE(json_agg(x ORDER BY x.id)::text, '')) AS h
       FROM (SELECT id, gmv, pedidos, comissao_apresentadora, comissao_franquia, comissao_franqueadora, status_aprovacao
               FROM vendas_atribuidas WHERE tenant_id = $1) x`,
    [t],
  )).rows[0].h

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 })
    t = (await q(`INSERT INTO tenants (nome) VALUES ('t-comissao-detalhe') RETURNING id`)).rows[0].id
    const cliente = async (nome) => (await q(
      `INSERT INTO clientes (tenant_id, nome, celular, status) VALUES ($1, $2, '47999990000', 'ativo') RETURNING id`, [t, nome],
    )).rows[0].id
    ids.cAlfa = await cliente('Alfa')
    ids.cBeta = await cliente('Beta')
    ids.ap = (await q(`INSERT INTO apresentadoras (tenant_id, nome) VALUES ($1, 'Ana') RETURNING id`, [t])).rows[0].id

    for (const [chave, [tipo, pct, gmv, sistema]] of Object.entries(MARCAS)) {
      const clienteId = chave === 'alfa' ? ids.cAlfa : chave === 'betaAfi' ? ids.cBeta : null
      ids[chave] = (await q(
        `INSERT INTO marcas (tenant_id, cliente_id, nome, tipo, data_inicio, sistema, comissao_franquia_pct)
         VALUES ($1, $2, $3, $4, '2026-01-01', $5, $6) RETURNING id`,
        [t, clienteId, `M ${chave}`, tipo, sistema, pct],
      )).rows[0].id
      await q(
        `INSERT INTO marca_condicoes_comerciais (tenant_id, marca_id, inicio_vigencia, fixo_mensal, comissao_franquia_pct,
           tipo_cobranca, fixo_confirmado, comissao_confirmada, origem)
         VALUES ($1, $2, '2026-01-01', 0, $3, 'fixo_mais_comissao', true, true, 'gestao')`,
        [t, ids[chave], pct],
      )
      lives[chave] = (await q(
        `INSERT INTO lives (tenant_id, marca_id, status, iniciado_em, encerrado_em, fat_gerado)
         VALUES ($1, $2, 'encerrada', '2026-08-10T15:00:00-03:00', '2026-08-10T17:00:00-03:00', $3) RETURNING id`,
        [t, ids[chave], gmv],
      )).rows[0].id
      // Linha como o commission-engine grava: franquia = gmv × % (inclusive de não-cliente).
      await q(
        `INSERT INTO vendas_atribuidas (tenant_id, origem, origem_id, marca_id, apresentadora_id, data, gmv, pedidos,
           comissao_apresentadora, comissao_franquia, comissao_franqueadora)
         VALUES ($1, 'live', $2, $3, $4, '2026-08-10', $5, 10, $5 * 0.01, $5 * $6 / 100.0, $5 * 0.02)`,
        [t, lives[chave], ids[chave], ids.ap, gmv, pct],
      )
    }
    // Vídeo de afiliada (gama 100%) e de cliente (alfa 10%).
    for (const [chave, gmv] of [['gama', 300], ['alfa', 400]]) {
      const vr = (await q(
        `INSERT INTO video_registros (tenant_id, marca_id, apresentadora_id, data, quantidade, gmv_atribuido, pedidos_atribuidos)
         VALUES ($1, $2, $3, '2026-08-11', 1, $4, 3) RETURNING id`,
        [t, ids[chave], ids.ap, gmv],
      )).rows[0].id
      await q(
        `INSERT INTO vendas_atribuidas (tenant_id, origem, origem_id, marca_id, apresentadora_id, data, gmv, pedidos,
           comissao_apresentadora, comissao_franquia, comissao_franqueadora)
         VALUES ($1, 'video', $2, $3, $4, '2026-08-11', $5, 3, $5 * 0.01, $5 * $6 / 100.0, $5 * 0.02)`,
        [t, vr, ids[chave], ids.ap, gmv, MARCAS[chave][1]],
      )
    }

    app = Fastify()
    app.decorate('authenticate', async (request) => { request.user = { tenant_id: t, papel: 'franqueado', sub: null } })
    app.decorate('requirePapel', () => async (request) => { request.user = { tenant_id: t, papel: 'franqueado', sub: null } })
    app.decorate('withTenant', async (_tenant, fn) => fn(pool))
    await app.register(comissoesRoutes)
    await app.register(financeiroRoutes)
  })

  afterAll(async () => {
    if (!pool) return
    await app?.close()
    for (const tb of ['vendas_atribuidas', 'video_registros', 'lives', 'marca_condicoes_comerciais', 'marcas', 'apresentadoras', 'clientes']) {
      await q(`DELETE FROM ${tb} WHERE tenant_id = $1`, [t]).catch(() => {})
    }
    await q('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {})
    await pool.end()
  })

  const get = async (u) => {
    _clearDashboardCache()
    const res = await app.inject({ method: 'GET', url: u })
    expect(res.statusCode).toBe(200)
    return res
  }

  it('gravado (antes): vendas_atribuidas guarda franquia de toda marca', async () => {
    const rows = (await q(
      `SELECT marca_id, SUM(comissao_franquia)::float AS f FROM vendas_atribuidas WHERE tenant_id = $1 GROUP BY 1`, [t],
    )).rows
    const por = Object.fromEntries(rows.map((r) => [r.marca_id, r.f]))
    expect(por[ids.alfa]).toBeCloseTo(1000 + 40, 2)
    expect(por[ids.gama]).toBeCloseTo(700 + 300, 2)
    expect(por[ids.epsilon]).toBeCloseTo(300, 2)
    expect(por[ids.sistema]).toBeCloseTo(50, 2)
  })

  it('/v1/lives/:id/comissoes — cliente inalterado; não-cliente com franquia 0; GMV igual', async () => {
    const hash = await fotoVendas()
    const alfa = (await get(`/v1/lives/${lives.alfa}/comissoes`)).json().comissoes[0]
    expect(alfa).toMatchObject({ gmv: 10000, comissao_apresentadora: 100, comissao_franquia: 1000, comissao_franqueadora: 200 })
    for (const chave of NAO_CLIENTE) {
      const gmv = MARCAS[chave][2]
      const row = (await get(`/v1/lives/${lives[chave]}/comissoes`)).json().comissoes[0]
      expect(row).toMatchObject({ gmv, comissao_franquia: 0 })
      expect(row.comissao_apresentadora).toBeCloseTo(gmv * 0.01, 2)
      expect(row.comissao_franqueadora).toBeCloseTo(gmv * 0.02, 2)
    }
    expect(await fotoVendas()).toBe(hash)
  })

  it('/v1/comissoes/por-live — mesma regra por linha', async () => {
    const rows = (await get('/v1/comissoes/por-live?mes=2026-08')).json()
    expect(rows).toHaveLength(6)
    const por = Object.fromEntries(rows.map((r) => [r.live_id, r]))
    expect(por[lives.alfa].comissao_franquia).toBeCloseTo(1000, 2)
    for (const chave of NAO_CLIENTE) {
      expect(por[lives[chave]].comissao_franquia).toBe(0)
      expect(por[lives[chave]].gmv).toBe(MARCAS[chave][2])
      expect(por[lives[chave]].comissao_apresentadora).toBeCloseTo(MARCAS[chave][2] * 0.01, 2)
    }
    expect(rows.reduce((s, r) => s + r.gmv, 0)).toBe(10000 + 1000 + 700 + 2000 + 1500 + 500)
  })

  it('/v1/comissoes/export-csv — coluna comissao_franquia 0 em não-cliente (live e vídeo); GMV igual', async () => {
    const csv = (await get('/v1/comissoes/export-csv?mes=2026-08')).body
    const [header, ...linhas] = csv.split('\n')
    expect(header).toBe('data,apresentadora,marca,origem,gmv,comissao_apresentadora,comissao_franquia,comissao_franqueadora,status')
    const cells = linhas.map((l) => l.split(','))
    const porMarca = (nome, origem) => cells.filter((c) => c[2] === nome && c[3] === origem)
    expect(porMarca('M alfa', 'live')[0].slice(4, 8)).toEqual(['10000.00', '100.00', '1000.00', '200.00'])
    expect(porMarca('M alfa', 'video')[0].slice(4, 8)).toEqual(['400.00', '4.00', '40.00', '8.00'])
    expect(porMarca('M gama', 'video')[0].slice(4, 8)).toEqual(['300.00', '3.00', '0.00', '6.00'])
    for (const chave of NAO_CLIENTE) {
      const linha = porMarca(`M ${chave}`, 'live')[0]
      expect(Number(linha[4])).toBe(MARCAS[chave][2])
      expect(linha[6]).toBe('0.00')
    }
    const gmvTotal = cells.reduce((s, c) => s + Number(c[4]), 0)
    expect(gmvTotal).toBe(10000 + 1000 + 700 + 2000 + 1500 + 500 + 300 + 400)
  })

  it('/v1/comissoes/pendentes (fila de aprovação) — inalterada: mostra a franquia gravada', async () => {
    const rows = (await get('/v1/comissoes/pendentes?mes=2026-08')).json()
    const gama = rows.find((r) => r.origem === 'live' && r.origem_id === lives.gama)
    expect(Number(gama.comissao_franquia)).toBeCloseTo(700, 2)
  })

  it('/v1/financeiro/faturamento — receita_liquida só de marca cliente; GMV (total) igual', async () => {
    const { por_cliente: rows } = (await get('/v1/financeiro/faturamento?inicio=2026-08&fim=2026-08')).json()
    const porCliente = Object.fromEntries(rows.filter((r) => r.cliente_id).map((r) => [r.cliente_id, r]))
    const porMarca = Object.fromEntries(rows.filter((r) => !r.cliente_id).map((r) => [r.marca_id, r]))
    // Alfa: (10000 + 400 vídeo) × 10%.
    expect(porCliente[ids.cAlfa]).toMatchObject({ total: 10400 })
    expect(porCliente[ids.cAlfa].receita_liquida).toBeCloseTo(1040, 2)
    // Beta: só a afiliada vinculada (1000 de GMV) — antes 100 de "receita", agora 0.
    expect(porCliente[ids.cBeta]).toMatchObject({ total: 1000, receita_liquida: 0 })
    expect(porMarca[ids.gama]).toMatchObject({ total: 1000, receita_liquida: 0 })
    for (const chave of ['delta', 'epsilon', 'sistema']) {
      expect(porMarca[ids[chave]]).toMatchObject({ total: MARCAS[chave][2], receita_liquida: 0 })
    }
    expect(rows.reduce((s, r) => s + r.total, 0)).toBe(10000 + 1000 + 700 + 2000 + 1500 + 500 + 300 + 400)
  })
})
