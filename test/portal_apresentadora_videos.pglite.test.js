import { readFile } from 'node:fs/promises'
import Fastify from 'fastify'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { portalApresentadoraRoutes } from '../src/routes/portal_apresentadora.js'
import { saoPauloDateInput } from '../src/lib/timezone.js'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant = id(1)
const anaUser = id(3)
const biaUser = id(4)
const ana = id(6)
const bia = id(7)
const marca = id(20)
const officialLive = id(30)
const linkedLive = id(31)

let db
let app

async function apply(name) {
  await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'))
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE tenants(id uuid PRIMARY KEY);
    CREATE TABLE users(id uuid PRIMARY KEY, tenant_id uuid, ativo boolean DEFAULT true, papel text);
    CREATE TABLE apresentadoras(id uuid PRIMARY KEY, tenant_id uuid, user_id uuid, nome text, ativo boolean DEFAULT true, arquivada boolean DEFAULT false, fixo numeric DEFAULT 2700, foto_url text, comissao_pct numeric, data_inicio date, data_fim date);
    CREATE TABLE clientes(id uuid PRIMARY KEY, tenant_id uuid, status text, logo_url text);
    CREATE TABLE contratos(id uuid PRIMARY KEY, tenant_id uuid, status text, comissao_pct numeric, cliente_id uuid);
    CREATE TABLE marcas(id uuid PRIMARY KEY, tenant_id uuid, cliente_id uuid, nome text, status text, tipo text, criado_em timestamptz DEFAULT now(), comissao_franquia_pct numeric, comissao_franqueadora_pct numeric, valor_fixo_minimo numeric, tipo_cobranca text, logo_url text, site text);
    CREATE TABLE cabines(id uuid PRIMARY KEY, tenant_id uuid, nome text, numero int, ativo boolean DEFAULT true, contrato_id uuid);
    CREATE TABLE lives(id uuid PRIMARY KEY, tenant_id uuid, cabine_id uuid, cliente_id uuid, apresentador_id uuid, gestor_id uuid, status text, iniciado_em timestamptz, encerrado_em timestamptz, fat_gerado numeric, final_orders_count int, live_impressions bigint, manual_views int, resumo text, tipo text, status_publicacao text, origem_dados text, marca_id uuid, comissao_calculada numeric, comissao_apresentadora_pct numeric, comissao_apresentadora_valor numeric, agenda_evento_id uuid);
    CREATE TABLE live_apresentadores(tenant_id uuid, live_id uuid, apresentador_id uuid);
    CREATE TABLE live_apresentadoras_v2(tenant_id uuid, live_id uuid, apresentadora_id uuid, papel text, percentual_rateio numeric);
    CREATE TABLE apresentadora_marcas(tenant_id uuid, apresentadora_id uuid, marca_id uuid, ativo boolean);
    CREATE TABLE agenda_eventos(id uuid PRIMARY KEY, tenant_id uuid, tipo text, marca_id uuid, cabine_id uuid, apresentadora_id uuid, data_inicio timestamptz, data_fim timestamptz, status text, live_id uuid, observacoes text, criado_por uuid, atualizado_em timestamptz);
    CREATE TABLE agenda_evento_apresentadoras(tenant_id uuid, agenda_evento_id uuid, apresentadora_id uuid, data_inicio timestamptz, data_fim timestamptz);
    CREATE TABLE vendas_atribuidas(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, origem text, origem_id uuid, marca_id uuid, apresentadora_id uuid, data date, gmv numeric, pedidos int, comissao_apresentadora numeric, comissao_franquia numeric, comissao_franqueadora numeric, marca_condicao_id uuid, status_aprovacao text DEFAULT 'pendente_aprovacao', atualizado_em timestamptz);
    CREATE TABLE marca_condicoes_comerciais(id uuid, tenant_id uuid, marca_id uuid, inicio_vigencia date, fixo_mensal numeric, comissao_franquia_pct numeric, comissao_franqueadora_pct numeric, tipo_cobranca text, fixo_confirmado boolean, comissao_confirmada boolean, origem text, cancelled_at timestamptz);
    CREATE TABLE apresentadora_comissao_faixas(tenant_id uuid, apresentadora_id uuid, ativo boolean, gmv_inicio numeric, gmv_fim numeric, comissao_pct numeric);
    CREATE TABLE tenant_comissao_faixas_default(tenant_id uuid, ativo boolean, gmv_inicio numeric, gmv_fim numeric, comissao_pct numeric);
    CREATE TABLE apresentadora_fixo_historico(id uuid, tenant_id uuid, apresentadora_id uuid, vigencia_inicio date, valor numeric);
    CREATE TABLE video_registros(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, marca_id uuid NOT NULL, apresentadora_id uuid, agenda_evento_id uuid, data date NOT NULL, quantidade int NOT NULL DEFAULT 0, plataforma text DEFAULT 'tiktok', campanha text, gmv_atribuido numeric(15,2) DEFAULT 0, pedidos_atribuidos int DEFAULT 0, observacoes text, criado_por uuid, criado_em timestamptz DEFAULT now());
    ALTER TABLE vendas_atribuidas ENABLE ROW LEVEL SECURITY;
    CREATE POLICY va_tenant ON vendas_atribuidas USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
    ALTER TABLE video_registros ENABLE ROW LEVEL SECURITY;
    CREATE POLICY vr_tenant ON video_registros USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  `)
  await apply('144_portal_apresentadora_submissoes.sql')
  await apply('145_portal_apresentadora_runtime_role.sql')
  await apply('147_live_oficial_excluida_tombstone.sql')
  await apply('149_submission_archive_workflow.sql')
  await apply('155_portal_runtime_marca_condicoes.sql')
  await apply('156_portal_runtime_marca_condicoes_least_privilege.sql')
  await apply('187_portal_apresentadora_videos.sql')
  await db.exec(`
    ALTER TABLE apresentadora_live_submissoes
      ADD COLUMN IF NOT EXISTS live_impressions_declaradas BIGINT,
      ADD COLUMN IF NOT EXISTS manual_views_declaradas INTEGER,
      ADD COLUMN IF NOT EXISTS live_impressions_oficiais BIGINT,
      ADD COLUMN IF NOT EXISTS manual_views_oficiais INTEGER;
  `)
  await db.query('INSERT INTO tenants VALUES ($1)', [tenant])
  await db.query(
    `INSERT INTO users(id, tenant_id, papel) VALUES ($1, $3, 'apresentadora'), ($2, $3, 'apresentadora')`,
    [anaUser, biaUser, tenant],
  )
  await db.query(
    `INSERT INTO apresentadoras(id, tenant_id, user_id, nome) VALUES ($1, $3, $4, 'Ana'), ($2, $3, $5, 'Bia')`,
    [ana, bia, tenant, anaUser, biaUser],
  )
  await db.query(
    `INSERT INTO lives(id, tenant_id, status, fat_gerado) VALUES ($1, $3, 'encerrada', 320.50), ($2, $3, 'encerrada', 320.50)`,
    [officialLive, linkedLive, tenant],
  )

  await db.query(`INSERT INTO marcas(id, tenant_id, nome, status, tipo, comissao_franquia_pct, comissao_franqueadora_pct) VALUES ($1, $2, 'Marca A', 'ativa', 'propria', 10, 5)`, [marca, tenant])

  process.env.PORTAL_APRESENTADORA_TENANT_ALLOWLIST = tenant
  app = Fastify()
  app.decorate('authenticate', async (request) => {
    request.user = {
      tenant_id: tenant,
      sub: request.headers['x-test-user'] || anaUser,
      papel: 'apresentadora',
    }
  })
  app.decorate('requirePapel', (roles) => async (request, reply) => {
    if (!roles.includes(request.user.papel)) return reply.code(403).send({ error: 'forbidden' })
  })
  app.decorate('db', { pool: { connect: async () => ({ query: (sql, params) => db.query(sql, params), release() {} }) } })
  await app.register(portalApresentadoraRoutes)
})

afterAll(async () => {
  await app?.close()
  await db?.close()
})

const hoje = () => saoPauloDateInput(new Date())
const mesAnterior = () => {
  const d = new Date(`${hoje().slice(0, 7)}-01T12:00:00Z`)
  d.setUTCDate(0)
  return d.toISOString().slice(0, 10)
}

function call(method, url, payload, user = anaUser) {
  return app.inject({ method, url, payload, headers: { 'x-test-user': user } })
}

describe('portal da apresentadora — registro de vídeo', () => {
  it('registra vídeo, gera venda pendente com comissão do motor e não cria live', async () => {
    const livesAntes = (await db.query('SELECT count(*)::int AS n FROM lives')).rows[0].n
    const res = await call('POST', '/v1/portal/apresentadora/videos', { marca_id: marca, data: hoje(), quantidade: 3, gmv_atribuido: '1.000,00', pedidos_atribuidos: 4 })
    expect(res.statusCode).toBe(201)
    const video = res.json()
    expect(video).toMatchObject({ apresentadora_id: ana, quantidade: 3, data: hoje(), gmv_atribuido: '1000.00', pedidos_atribuidos: 4, editavel: true })

    const venda = await db.query(`SELECT origem, gmv, pedidos, status_aprovacao, comissao_apresentadora FROM vendas_atribuidas WHERE origem_id = $1`, [video.id])
    expect(venda.rows).toHaveLength(1)
    expect(venda.rows[0]).toMatchObject({ origem: 'video', pedidos: 4, status_aprovacao: 'pendente_aprovacao' })
    expect(Number(venda.rows[0].gmv)).toBe(1000)
    expect(Number(venda.rows[0].comissao_apresentadora)).toBeCloseTo(10) // 1% (faixa padrão até R$70 mil)
    expect((await db.query('SELECT count(*)::int AS n FROM lives')).rows[0].n).toBe(livesAntes)

    const lista = await call('GET', '/v1/portal/apresentadora/videos')
    expect(lista.statusCode).toBe(200)
    expect(lista.json().total_videos).toBeGreaterThanOrEqual(3)
    expect(lista.json().items.find((item) => item.id === video.id)).toMatchObject({ marca_nome: 'Marca A', venda_status: 'pendente_aprovacao', editavel: true })
  })

  it('vídeo sem GMV conta na quantidade e não gera venda', async () => {
    const res = await call('POST', '/v1/portal/apresentadora/videos', { marca_id: marca, data: hoje(), quantidade: 2 })
    expect(res.statusCode).toBe(201)
    const venda = await db.query('SELECT 1 FROM vendas_atribuidas WHERE origem_id = $1', [res.json().id])
    expect(venda.rows).toHaveLength(0)
  })

  it('valida quantidade, data futura e mês anterior', async () => {
    const amanha = new Date(Date.now() + 36 * 3600 * 1000)
    for (const payload of [
      { marca_id: marca, data: hoje(), quantidade: 0 },
      { marca_id: marca, data: saoPauloDateInput(amanha), quantidade: 1 },
      { marca_id: marca, data: mesAnterior(), quantidade: 1 },
      { marca_id: marca, data: '2026-02-30', quantidade: 1 },
      { marca_id: marca, data: hoje(), quantidade: 1, duracao: 30 },
    ]) {
      const res = await call('POST', '/v1/portal/apresentadora/videos', payload)
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    }
  })

  it('edita e exclui o próprio vídeo; zerar o GMV remove a venda pendente', async () => {
    const created = (await call('POST', '/v1/portal/apresentadora/videos', { marca_id: marca, data: hoje(), quantidade: 1, gmv_atribuido: 200 })).json()
    const edit = await call('PATCH', `/v1/portal/apresentadora/videos/${created.id}`, { marca_id: marca, data: hoje(), quantidade: 5, gmv_atribuido: 0 })
    expect(edit.statusCode).toBe(200)
    expect(edit.json().quantidade).toBe(5)
    expect((await db.query('SELECT 1 FROM vendas_atribuidas WHERE origem_id = $1', [created.id])).rows).toHaveLength(0)

    const del = await call('DELETE', `/v1/portal/apresentadora/videos/${created.id}`)
    expect(del.statusCode).toBe(200)
    expect((await db.query('SELECT 1 FROM video_registros WHERE id = $1', [created.id])).rows).toHaveLength(0)
  })

  it('não altera vídeo de outra apresentadora, de mês anterior nem com venda aprovada', async () => {
    const peer = (await call('POST', '/v1/portal/apresentadora/videos', { marca_id: marca, data: hoje(), quantidade: 1 }, biaUser)).json()
    expect((await call('PATCH', `/v1/portal/apresentadora/videos/${peer.id}`, { marca_id: marca, data: hoje(), quantidade: 9 })).statusCode).toBe(404)
    expect((await call('DELETE', `/v1/portal/apresentadora/videos/${peer.id}`)).statusCode).toBe(404)

    const antigo = id(90)
    await db.query(`INSERT INTO video_registros(id, tenant_id, marca_id, apresentadora_id, data, quantidade) VALUES ($1, $2, $3, $4, $5, 1)`, [antigo, tenant, marca, ana, mesAnterior()])
    expect((await call('DELETE', `/v1/portal/apresentadora/videos/${antigo}`)).statusCode).toBe(409)

    const aprovado = (await call('POST', '/v1/portal/apresentadora/videos', { marca_id: marca, data: hoje(), quantidade: 1, gmv_atribuido: 50 })).json()
    await db.query(`UPDATE vendas_atribuidas SET status_aprovacao = 'aprovada' WHERE origem_id = $1`, [aprovado.id])
    const res = await call('DELETE', `/v1/portal/apresentadora/videos/${aprovado.id}`)
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('FINANCIAL_ROW_CLOSED')
  })

  it('o papel do portal só apaga venda de vídeo não fechada', async () => {
    const live = id(91)
    const videoAprovado = id(92)
    await db.query(`INSERT INTO vendas_atribuidas(tenant_id, origem, origem_id, gmv, status_aprovacao) VALUES ($1, 'live', $2, 10, 'pendente_aprovacao'), ($1, 'video', $3, 10, 'aprovada')`, [tenant, live, videoAprovado])
    await db.exec('BEGIN')
    await db.query('SET LOCAL ROLE livelab_portal_runtime')
    await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant])
    const apagadas = await db.query('DELETE FROM vendas_atribuidas WHERE origem_id = ANY($1::uuid[]) RETURNING id', [[live, videoAprovado]])
    await db.exec('ROLLBACK')
    expect(apagadas.rows).toHaveLength(0)
  })
})
