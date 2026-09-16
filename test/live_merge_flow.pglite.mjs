// End-to-end persistence proof for live consolidation. Uses an isolated in-memory
// PostgreSQL and never reads or writes production resources.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import Fastify from 'fastify'

import { liveMergeRoutes } from '../src/routes/live-merge.js'
import {
  getLiveMergeHistory,
  mergeLives,
  previewLiveMerge,
  undoLiveMerge,
} from '../src/services/live-merge.js'

const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')
const db = new PGlite()
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant = id(1)
const manager = id(2)
const client = id(3)
const brand = id(4)
const cabin = id(5)
const presenterA = id(6)
const presenterB = id(7)
const presenterUserA = id(8)
const presenterUserB = id(9)
const sourceManager = id(14)
const liveA = id(10)
const liveB = id(11)
const saleA = id(12)
const saleB = id(13)
const requestId = id(20)
const undoRequestId = id(21)
const unionId = id(22)
const destinationId = id(23)

await db.exec(`
  SET TIME ZONE 'UTC';
  CREATE TABLE tenants(id uuid PRIMARY KEY);
  CREATE TABLE users(id uuid PRIMARY KEY, tenant_id uuid, papel text, nome text);
  CREATE TABLE clientes(id uuid PRIMARY KEY, tenant_id uuid, tiktok_username text);
  CREATE TABLE contratos(id uuid PRIMARY KEY, tenant_id uuid, cliente_id uuid, tiktok_username text);
  CREATE TABLE marcas(
    id uuid PRIMARY KEY, tenant_id uuid, cliente_id uuid, nome text, tipo text,
    tiktok_username text
  );
  CREATE TABLE marca_condicoes_comerciais(
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, marca_id uuid NOT NULL,
    inicio_vigencia date NOT NULL, cancelled_at timestamptz
  );
  CREATE TABLE cabines(
    id uuid PRIMARY KEY, tenant_id uuid, numero int, contrato_id uuid
  );
  CREATE TABLE lives(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
    cabine_id uuid, cliente_id uuid, marca_id uuid, apresentador_id uuid, gestor_id uuid,
    status text, tipo text, status_publicacao text,
    origem_dados text CHECK (origem_dados IN ('manual','api','bot')),
    iniciado_em timestamptz, encerrado_em timestamptz,
    fat_gerado numeric(15,2), comissao_calculada numeric(15,2),
    final_orders_count int, final_peak_viewers int, final_total_likes bigint,
    final_total_comments bigint, final_total_shares bigint, final_gifts_diamonds bigint,
    resumo text, manual_views int, manual_likes int, manual_comments int,
    manual_shares int, manual_diamonds int, manual_orders int, manual_gmv numeric(12,2),
    ads_gmv numeric(15,2), ads_cost numeric(15,2), live_impressions bigint,
    product_impressions bigint, product_clicks bigint, avg_viewing_duration numeric(10,2),
    new_followers int, status_operacional text, problema text, proxima_acao text,
    comissao_apresentadora_pct numeric(5,2), comissao_apresentadora_valor numeric(15,2),
    comissao_recalculo_pendente boolean DEFAULT false, faturado_em timestamptz,
    boleto_id uuid, agenda_evento_id uuid, tiktok_room_id text, studio_metrics jsonb,
    ads_import_batch_id uuid, ads_import_row_id uuid, atualizado_em timestamptz
  );
  CREATE TABLE apresentadoras(
    id uuid PRIMARY KEY, tenant_id uuid, user_id uuid, nome text
  );
  CREATE TABLE live_apresentadores(tenant_id uuid, live_id uuid, apresentador_id uuid);
  CREATE TABLE live_apresentadoras_v2(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, live_id uuid REFERENCES lives(id),
    apresentadora_id uuid, papel text, percentual_rateio numeric(5,2),
    gmv_rateado numeric(15,2), segundos_rateio int,
    UNIQUE(live_id, apresentadora_id)
  );
  CREATE TABLE vendas_atribuidas(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, origem text, origem_id uuid,
    marca_id uuid, apresentadora_id uuid, data date, gmv numeric(15,2), pedidos int,
    comissao_apresentadora numeric(15,2), comissao_franquia numeric(15,2),
    comissao_franqueadora numeric(15,2), status_aprovacao text, status_motivo text,
    aprovado_por uuid, aprovado_em timestamptz, criado_em timestamptz DEFAULT now(),
    atualizado_em timestamptz DEFAULT now()
  );
  CREATE UNIQUE INDEX va_key ON vendas_atribuidas(
    tenant_id, origem, origem_id,
    COALESCE(apresentadora_id,'00000000-0000-0000-0000-000000000000'::uuid)
  );
  CREATE TABLE boletos(id uuid PRIMARY KEY, tenant_id uuid, live_id uuid);
`)
await db.exec(await readFile(new URL('../migrations/148_lives_origem_apresentadora.sql', import.meta.url), 'utf8'))
await db.exec(await readFile(new URL('../migrations/150_live_unioes.sql', import.meta.url), 'utf8'))
await db.exec(await readFile(new URL('../migrations/152_marca_condicao_snapshot.sql', import.meta.url), 'utf8'))
await db.query(`SELECT set_config('app.tenant_id',$1,false)`, [tenant])

await db.query('INSERT INTO tenants VALUES ($1)', [tenant])
await db.query(
  `INSERT INTO users(id,tenant_id,papel,nome) VALUES
   ($1,$3,'gerente','Executor'),($2,$3,'apresentadora','Ana login'),
   ($4,$3,'apresentadora','Bia login'),($5,$3,'gerente','Gestor original')`,
  [manager, presenterUserA, tenant, presenterUserB, sourceManager],
)
await db.query('INSERT INTO clientes VALUES ($1,$2,$3)', [client, tenant, 'marca.oficial'])
await db.query('INSERT INTO marcas VALUES ($1,$2,$3,$4,$5,NULL)', [brand, tenant, client, 'Marca', 'cliente'])
const conditionAugust = id(24)
const conditionSeptember = id(25)
await db.query(
  `INSERT INTO marca_condicoes_comerciais(id,tenant_id,marca_id,inicio_vigencia)
   VALUES ($1,$2,$3,'2026-08-01'),($4,$2,$3,'2026-09-01')`,
  [conditionAugust, tenant, brand, conditionSeptember],
)
await db.query('INSERT INTO cabines VALUES ($1,$2,1,NULL)', [cabin, tenant])
await db.query(
  `INSERT INTO apresentadoras(id,tenant_id,user_id,nome) VALUES
   ($1,$3,$4,'Ana'),($2,$3,$5,'Bia')`,
  [presenterA, presenterB, tenant, presenterUserA, presenterUserB],
)
await db.query(
  `INSERT INTO lives(
     id,tenant_id,cabine_id,cliente_id,apresentador_id,gestor_id,status,tipo,
     status_publicacao,origem_dados,iniciado_em,encerrado_em,fat_gerado,
     comissao_calculada,final_orders_count,manual_orders,manual_gmv,
     live_impressions,manual_views,manual_likes,manual_comments,manual_shares,
     manual_diamonds,ads_cost,product_impressions,product_clicks,new_followers,
     final_peak_viewers,marca_id,comissao_apresentadora_valor,status_operacional
   ) VALUES
   ($1,$3,$4,$5,$6,$7,'encerrada','cliente','rascunho','apresentadora',
    '2026-09-15T15:00:00.123456Z','2026-09-15T18:00:00.123456Z',2000,200,20,20,2000,
    100,200,10,5,2,1,20,50,10,3,80,$8,100,'ok'),
   ($2,$3,$4,$5,$9,$7,'encerrada','cliente','rascunho','apresentadora',
    '2026-09-15T18:00:00.123456Z','2026-09-15T21:00:00.123456Z',3000,300,30,30,3000,
    150,300,20,10,4,2,30,70,20,5,120,$8,150,'ok')`,
  [liveA, liveB, tenant, cabin, client, presenterUserA, sourceManager, brand, presenterUserB],
)
await db.query(
  `INSERT INTO live_apresentadoras_v2(
     tenant_id,live_id,apresentadora_id,papel,percentual_rateio,gmv_rateado,segundos_rateio
   ) VALUES ($1,$2,$3,'principal',100,2000,10800),($1,$4,$5,'principal',100,3000,10800)`,
  [tenant, liveA, presenterA, liveB, presenterB],
)
await db.query(
  `INSERT INTO vendas_atribuidas(
     id,tenant_id,origem,origem_id,marca_id,apresentadora_id,data,gmv,pedidos,
     comissao_apresentadora,comissao_franquia,comissao_franqueadora,marca_condicao_id,status_aprovacao
   ) VALUES
   ($1,$3,'live',$4,$5,$6,'2026-09-15',2000,20,100,200,50,$9,'pendente_aprovacao'),
   ($2,$3,'live',$7,$5,$8,'2026-09-15',3000,30,150,300,75,$9,'pendente_aprovacao')`,
  [saleA, saleB, tenant, liveA, brand, presenterA, liveB, presenterB, conditionSeptember],
)

const assertOriginalState = async () => {
  const state = (await db.query(`
    SELECT
      (SELECT count(*)::int FROM lives) AS lives,
      (SELECT count(*)::int FROM live_unioes) AS unions,
      (SELECT count(*)::int FROM vendas_atribuidas) AS sales,
      (SELECT count(*)::int FROM lives WHERE uniao_destino_id IS NOT NULL) AS absorbed
  `)).rows[0]
  assert.deepEqual(state, { lives: 2, unions: 0, sales: 2, absorbed: 0 })
}

const initialPreview = await previewLiveMerge(db, { tenantId: tenant, liveIds: [liveB, liveA] })
assert.equal(initialPreview.eligible, true)
assert.deepEqual(initialPreview.totais, {
  gmv: 5000, pedidos: 50, segundos: 21600, live_impressions: 250, manual_views: 500,
  comissao_apresentadora: 250, comissao_franquia: 500, comissao_franqueadora: 125,
})
assert.deepEqual(initialPreview.apresentadoras.map((row) => [row.nome, row.gmv, row.segundos, row.pedidos]), [
  ['Ana', 2000, 10800, 20], ['Bia', 3000, 10800, 30],
])

// A submission id that has not materialized as an official live is rejected as absent.
const pendingPreview = await previewLiveMerge(db, { tenantId: tenant, liveIds: [liveA, id(99)] })
assert.equal(pendingPreview.eligible, false)
assert.ok(pendingPreview.blockers.some((blocker) => blocker.code === 'LIVE_NOT_FOUND' && blocker.live_id === id(99)))

// Route access uses the narrow management role set. New merges are tenant-allowlisted.
const previousAllowlist = process.env.LIVE_MERGE_TENANT_ALLOWLIST
process.env.LIVE_MERGE_TENANT_ALLOWLIST = tenant
const app = Fastify({ logger: false })
app.decorate('authenticate', async (request) => {
  request.user = { tenant_id: tenant, sub: manager, papel: request.headers['x-test-role'] ?? 'gerente' }
})
app.decorate('requirePapel', (roles) => async (request, reply) => {
  if (!roles.includes(request.user.papel)) return reply.code(403).send({ error: 'Acesso negado' })
})
app.decorate('withTenant', async (_tenant, callback) => callback(db))
app.decorate('audit', { log: async () => {} })
await app.register(liveMergeRoutes)
assert.equal((await app.inject({ method: 'GET', url: '/v1/lives/uniao/capabilities', headers: { 'x-test-role': 'produtor_live' } })).statusCode, 403)
const capability = await app.inject({ method: 'GET', url: '/v1/lives/uniao/capabilities' })
assert.equal(capability.statusCode, 200)
assert.deepEqual(capability.json(), { enabled: true })

const mergeOptions = {
  tenantId: tenant,
  userId: manager,
  liveIds: [liveA, liveB],
  previewToken: initialPreview.preview_token,
  requestId,
  motivo: 'Troca de apresentadora',
  metricasPorTrecho: true,
  uuidFactory: (() => {
    const values = [unionId, destinationId]
    return () => values.shift()
  })(),
}

// Failures after material insertion and source-sale deletion must roll back everything.
for (const [failureIndex, failAfter] of [
  'live-merge:insert-destination',
  'live-merge:delete-source-sales',
  'live-merge:mark-sources',
].entries()) {
  let failed = false
  const failingDb = {
    query: async (sql, params) => {
      const result = await db.query(sql, params)
      if (!failed && String(sql).includes(failAfter)) {
        failed = true
        throw new Error(`injected after ${failAfter}`)
      }
      return result
    },
  }
  const ids = [id(30 + failureIndex * 2), id(31 + failureIndex * 2)]
  await assert.rejects(
    mergeLives(failingDb, { ...mergeOptions, requestId: ids[0], uuidFactory: () => ids.shift() }),
    new RegExp(`injected after ${failAfter}`),
  )
  await assertOriginalState()
}

// A changed metric invalidates the versioned preview before any write survives.
await db.query('UPDATE lives SET manual_views=201 WHERE id=$1', [liveA])
await assert.rejects(
  mergeLives(db, { ...mergeOptions, requestId: id(40), uuidFactory: (() => { const values = [id(41), id(42)]; return () => values.shift() })() }),
  (error) => error.code === 'PREVIEW_STALE' && error.statusCode === 409,
)
await assertOriginalState()
await db.query('UPDATE lives SET manual_views=200 WHERE id=$1', [liveA])

const freshPreview = await previewLiveMerge(db, { tenantId: tenant, liveIds: [liveA, liveB] })
mergeOptions.previewToken = freshPreview.preview_token
const merged = await mergeLives(db, mergeOptions)
assert.deepEqual(merged, { live_id: destinationId, uniao_id: unionId })
assert.deepEqual(await mergeLives(db, mergeOptions), merged)

const activeGlobal = (await db.query(`
  SELECT count(*)::int AS lives, SUM(fat_gerado)::numeric AS gmv,
         SUM(final_orders_count)::int AS pedidos
    FROM lives WHERE uniao_destino_id IS NULL AND uniao_desfeita_em IS NULL
`)).rows[0]
assert.deepEqual({ ...activeGlobal, gmv: Number(activeGlobal.gmv) }, { lives: 1, gmv: 5000, pedidos: 50 })
const destination = (await db.query(
  `SELECT origem_dados,status_operacional,gestor_id,iniciado_em,encerrado_em,manual_views,live_impressions,
          final_total_likes,final_total_comments,final_total_shares,final_gifts_diamonds
     FROM lives WHERE id=$1`, [destinationId],
)).rows[0]
assert.equal(destination.origem_dados, 'apresentadora')
assert.equal(destination.status_operacional, 'ok')
assert.equal(destination.gestor_id, sourceManager)
const exactTimes = (await db.query(
  `SELECT to_char(iniciado_em,'YYYY-MM-DD HH24:MI:SS.US') AS inicio,
          to_char(encerrado_em,'YYYY-MM-DD HH24:MI:SS.US') AS fim
     FROM lives WHERE id=$1`, [destinationId],
)).rows[0]
assert.deepEqual(exactTimes, {
  inicio: '2026-09-15 15:00:00.123456', fim: '2026-09-15 21:00:00.123456',
})
assert.deepEqual([
  destination.manual_views, Number(destination.live_impressions), Number(destination.final_total_likes),
  Number(destination.final_total_comments), Number(destination.final_total_shares), Number(destination.final_gifts_diamonds),
], [500, 250, 30, 15, 6, 3])

const rateio = (await db.query(`
  SELECT apresentadora_id,gmv_rateado,segundos_rateio,pedidos_rateados,percentual_rateio,papel
    FROM live_apresentadoras_v2 WHERE live_id=$1 ORDER BY apresentadora_id
`, [destinationId])).rows
assert.deepEqual(rateio.map((row) => [
  row.apresentadora_id, Number(row.gmv_rateado), row.segundos_rateio,
  row.pedidos_rateados, Number(row.percentual_rateio), row.papel,
]), [
  [presenterA, 2000, 10800, 20, 40, 'apoio'],
  [presenterB, 3000, 10800, 30, 60, 'principal'],
])
const mergedSales = (await db.query(`
  SELECT apresentadora_id,gmv,pedidos,comissao_apresentadora,comissao_franquia,comissao_franqueadora,marca_condicao_id
    FROM vendas_atribuidas WHERE origem_id=$1 ORDER BY apresentadora_id
`, [destinationId])).rows
assert.deepEqual(mergedSales.map((row) => [
  row.apresentadora_id, Number(row.gmv), row.pedidos, Number(row.comissao_apresentadora),
  Number(row.comissao_franquia), Number(row.comissao_franqueadora), row.marca_condicao_id,
]), [
  [presenterA, 2000, 20, 100, 200, 50, conditionSeptember],
  [presenterB, 3000, 30, 150, 300, 75, conditionSeptember],
])

// Legitimate monthly commission recalculation is allowed, but makes automatic
// reversal unsafe until the financial state is reviewed and restored.
await db.query(
  'UPDATE vendas_atribuidas SET comissao_apresentadora=comissao_apresentadora+0.01 WHERE origem_id=$1 AND apresentadora_id=$2',
  [destinationId, presenterA],
)
await assert.rejects(
  undoLiveMerge(db, {
    tenantId: tenant, userId: manager, unionId, requestId: id(50), motivo: 'Tentativa com financeiro alterado',
  }),
  (error) => error.code === 'UNION_FINANCE_CHANGED' && error.statusCode === 409,
)
await db.query(
  'UPDATE vendas_atribuidas SET comissao_apresentadora=comissao_apresentadora-0.01 WHERE origem_id=$1 AND apresentadora_id=$2',
  [destinationId, presenterA],
)

await assert.rejects(
  db.query('UPDATE lives SET manual_gmv=1 WHERE id=$1', [liveA]),
  (error) => error.code === '23514' && error.constraint === 'live_uniao_protected',
)
await assert.rejects(
  db.query('UPDATE live_apresentadoras_v2 SET segundos_rateio=1 WHERE live_id=$1', [liveA]),
  (error) => error.code === '23514' && error.constraint === 'live_uniao_protected',
)

const sourceHistory = await getLiveMergeHistory(db, { tenantId: tenant, liveId: liveA })
const destinationHistory = await getLiveMergeHistory(db, { tenantId: tenant, liveId: destinationId })
assert.equal(sourceHistory.id, unionId)
assert.equal(sourceHistory.ativo, true)
assert.equal(destinationHistory.id, unionId)

// A billing row can be linked directly through boletos.live_id without the
// denormalized columns on lives having been filled yet. Undo must still stop.
const directBoletoId = id(60)
await db.query('INSERT INTO boletos(id,tenant_id,live_id) VALUES ($1,$2,$3)', [directBoletoId, tenant, destinationId])
await assert.rejects(
  undoLiveMerge(db, {
    tenantId: tenant, userId: manager, unionId, requestId: id(61), motivo: 'Tentativa após vínculo direto de boleto',
  }),
  (error) => error.code === 'UNION_FINANCE_CHANGED' && error.statusCode === 409,
)
await db.query('DELETE FROM boletos WHERE id=$1', [directBoletoId])

const undone = await undoLiveMerge(db, {
  tenantId: tenant, userId: manager, unionId, requestId: undoRequestId, motivo: 'Revisão operacional',
})
assert.deepEqual(undone.live_ids.sort(), [liveA, liveB])
assert.deepEqual((await undoLiveMerge(db, {
  tenantId: tenant, userId: manager, unionId, requestId: undoRequestId, motivo: 'Revisão operacional',
})).live_ids.sort(), [liveA, liveB])

const restored = (await db.query(`
  SELECT
    (SELECT count(*)::int FROM lives WHERE uniao_destino_id IS NULL AND uniao_desfeita_em IS NULL) AS lives,
    (SELECT SUM(gmv)::numeric FROM vendas_atribuidas) AS gmv,
    (SELECT SUM(pedidos)::int FROM vendas_atribuidas) AS pedidos,
    (SELECT count(*)::int FROM vendas_atribuidas) AS sales,
    (SELECT count(*)::int FROM lives WHERE uniao_desfeita_em IS NOT NULL) AS undone
`)).rows[0]
assert.deepEqual({ ...restored, gmv: Number(restored.gmv) }, { lives: 2, gmv: 5000, pedidos: 50, sales: 2, undone: 1 })
assert.deepEqual((await db.query('SELECT id FROM vendas_atribuidas ORDER BY id')).rows.map((row) => row.id), [saleA, saleB])
assert.deepEqual((await db.query('SELECT id,marca_condicao_id FROM vendas_atribuidas ORDER BY id')).rows, [
  { id: saleA, marca_condicao_id: conditionSeptember },
  { id: saleB, marca_condicao_id: conditionSeptember },
])
assert.equal((await getLiveMergeHistory(db, { tenantId: tenant, liveId: liveA })).ativo, false)
await assert.rejects(
  db.query('UPDATE lives SET manual_gmv=1 WHERE id=$1', [destinationId]),
  (error) => error.code === '23514' && error.constraint === 'live_uniao_protected',
)

console.log(JSON.stringify({
  passed: true,
  checks: [
    'real SQL preview and merge', 'strict conservation by presenter', 'presenter origin tag',
    'original manager preserved',
    'idempotent retry', 'stale preview', 'atomic rollback after failure injection',
    'frozen source and destination history', 'history lookup', 'undo and exact restoration',
    'management route permission', 'pending record excluded', 'direct billing link blocks undo',
  ],
}))

await app.close()
if (previousAllowlist === undefined) delete process.env.LIVE_MERGE_TENANT_ALLOWLIST
else process.env.LIVE_MERGE_TENANT_ALLOWLIST = previousAllowlist
await db.close()
