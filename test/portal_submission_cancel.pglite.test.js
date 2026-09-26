import { readFile } from 'node:fs/promises'
import Fastify from 'fastify'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { portalApresentadoraRoutes } from '../src/routes/portal_apresentadora.js'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant = id(1)
const anaUser = id(3)
const biaUser = id(4)
const ana = id(6)
const bia = id(7)
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
    CREATE TABLE vendas_atribuidas(id uuid PRIMARY KEY, tenant_id uuid, origem text, origem_id uuid, marca_id uuid, apresentadora_id uuid, data date, gmv numeric, pedidos int, comissao_apresentadora numeric, comissao_franquia numeric, comissao_franqueadora numeric, status_aprovacao text);
    CREATE TABLE apresentadora_comissao_faixas(tenant_id uuid, apresentadora_id uuid, ativo boolean, gmv_inicio numeric, gmv_fim numeric, comissao_pct numeric);
    CREATE TABLE tenant_comissao_faixas_default(tenant_id uuid, ativo boolean, gmv_inicio numeric, gmv_fim numeric, comissao_pct numeric);
    CREATE TABLE apresentadora_fixo_historico(id uuid, tenant_id uuid, apresentadora_id uuid, vigencia_inicio date, valor numeric);
    CREATE TABLE video_registros(id uuid PRIMARY KEY, tenant_id uuid, marca_id uuid, apresentadora_id uuid, data date, gmv_atribuido numeric, pedidos_atribuidos int);
  `)
  await apply('144_portal_apresentadora_submissoes.sql')
  await apply('145_portal_apresentadora_runtime_role.sql')
  await apply('147_live_oficial_excluida_tombstone.sql')
  await apply('149_submission_archive_workflow.sql')
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

async function insertSubmission({ submissionId, apresentadoraId, status, liveId = null, archive = null }) {
  await db.query(
    `INSERT INTO apresentadora_live_submissoes
       (id, tenant_id, apresentadora_id, marca_descricao, iniciado_em, encerrado_em, status, live_oficial_id, revisado_em, arquivamento_status)
     VALUES ($1, $2, $3, 'Marca', '2026-09-05T12:00:00Z', '2026-09-05T14:00:00Z', $4, $5, CASE WHEN $4 = 'aprovada' THEN NOW() ELSE NULL END, $6)`,
    [submissionId, tenant, apresentadoraId, status, liveId, archive],
  )
}

function cancel(submissionId, user = anaUser) {
  return app.inject({
    method: 'DELETE',
    url: `/v1/portal/apresentadora/submissoes/${submissionId}`,
    headers: { 'x-test-user': user },
  })
}

async function statusOf(submissionId) {
  const row = await db.query('SELECT status, live_oficial_id FROM apresentadora_live_submissoes WHERE id = $1', [submissionId])
  return row.rows[0]
}

describe('cancelamento do envio pela dona', () => {
  it('a apresentadora cancela o próprio envio pendente ou devolvido e não mexe na live oficial', async () => {
    const pending = id(40)
    const returned = id(41)
    await insertSubmission({ submissionId: pending, apresentadoraId: ana, status: 'pendente' })
    await insertSubmission({ submissionId: returned, apresentadoraId: ana, status: 'devolvida' })
    const before = await db.query(`SELECT (SELECT count(*)::int FROM lives) AS lives, (SELECT count(*)::int FROM vendas_atribuidas) AS sales`)

    const pendingRes = await cancel(pending)
    expect(pendingRes.statusCode).toBe(200)
    expect(pendingRes.json()).toMatchObject({ ok: true, id: pending, status: 'cancelada' })
    expect((await statusOf(pending)).status).toBe('cancelada')

    const returnedRes = await cancel(returned)
    expect(returnedRes.statusCode).toBe(200)
    expect((await statusOf(returned)).status).toBe('cancelada')

    const history = await db.query(
      `SELECT acao FROM apresentadora_live_submissao_historico WHERE submissao_id = ANY($1::uuid[]) ORDER BY submissao_id`,
      [[pending, returned]],
    )
    expect(history.rows.map((row) => row.acao)).toEqual(['cancelada', 'cancelada'])
    const after = await db.query(`SELECT (SELECT count(*)::int FROM lives) AS lives, (SELECT count(*)::int FROM vendas_atribuidas) AS sales`)
    expect(after.rows[0]).toEqual(before.rows[0])
    const live = await db.query('SELECT fat_gerado FROM lives WHERE id = $1', [officialLive])
    expect(live.rows[0].fat_gerado).toBe('320.50')
  })

  it('não cancela envio aprovado, envio já ligado a live oficial, nem envio de outra apresentadora', async () => {
    const approved = id(42)
    const linked = id(43)
    const peer = id(44)
    const archived = id(45)
    await insertSubmission({ submissionId: approved, apresentadoraId: ana, status: 'aprovada', liveId: officialLive })
    await insertSubmission({ submissionId: linked, apresentadoraId: ana, status: 'pendente', liveId: linkedLive })
    await insertSubmission({ submissionId: peer, apresentadoraId: bia, status: 'pendente' })
    await insertSubmission({ submissionId: archived, apresentadoraId: ana, status: 'devolvida', archive: 'solicitado' })

    for (const submissionId of [approved, linked, peer, archived]) {
      const res = await cancel(submissionId)
      expect(res.statusCode).toBe(404)
    }

    expect((await statusOf(approved)).status).toBe('aprovada')
    expect((await statusOf(approved)).live_oficial_id).toBe(officialLive)
    expect((await statusOf(linked)).status).toBe('pendente')
    expect((await statusOf(linked)).live_oficial_id).toBe(linkedLive)
    expect((await statusOf(peer)).status).toBe('pendente')
    expect((await statusOf(archived)).status).toBe('devolvida')
    const stillThere = await db.query('SELECT id FROM lives WHERE id = ANY($1::uuid[])', [[officialLive, linkedLive]])
    expect(stillThere.rows).toHaveLength(2)
  })
})
