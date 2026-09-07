// Run with PGLITE_MODULE pointing to a disposable PGlite install. No production connection.
import assert from 'node:assert/strict'

const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')
const { getOwnPortalPerformance } = await import('../src/services/portal-apresentadora-performance.js')

const db = new PGlite()
const tenantA = '11111111-1111-4111-8111-111111111111'
const tenantB = '22222222-2222-4222-8222-222222222222'
const presenter = '33333333-3333-4333-8333-333333333333'
const user = '44444444-4444-4444-8444-444444444444'
const brand = '55555555-5555-4555-8555-555555555555'
const cabine = '66666666-6666-4666-8666-666666666666'
const splitLive = '77777777-7777-4777-8777-777777777777'
const zeroLive = '88888888-8888-4888-8888-888888888888'

await db.exec(`
  SET TIME ZONE 'UTC';
  CREATE TABLE apresentadoras (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid, nome text);
  CREATE TABLE lives (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, apresentador_id uuid, cabine_id uuid, marca_id uuid,
    status text NOT NULL, iniciado_em timestamptz NOT NULL, encerrado_em timestamptz, previsto_fim timestamptz,
    ads_gmv numeric, manual_gmv numeric, fat_gerado numeric, manual_orders int, final_orders_count int
  );
  CREATE TABLE live_apresentadores (tenant_id uuid NOT NULL, live_id uuid NOT NULL, apresentador_id uuid);
  CREATE TABLE live_apresentadoras_v2 (
    tenant_id uuid NOT NULL, live_id uuid NOT NULL, apresentadora_id uuid NOT NULL,
    gmv_rateado numeric, segundos_rateio numeric, percentual_rateio numeric, papel text
  );
  CREATE TABLE cabines (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, nome text);
  CREATE TABLE marcas (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, nome text);
  CREATE TABLE vendas_atribuidas (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, origem text, origem_id uuid, apresentadora_id uuid,
    marca_id uuid, data date, gmv numeric, pedidos int, comissao_apresentadora numeric,
    status_aprovacao text, criado_em timestamptz NOT NULL DEFAULT NOW()
  );
  CREATE TABLE apresentadora_comissao_faixas (
    tenant_id uuid NOT NULL, apresentadora_id uuid NOT NULL, ativo boolean, gmv_inicio numeric,
    gmv_fim numeric, comissao_pct numeric
  );
`)
await db.query(`INSERT INTO apresentadoras VALUES ($1,$2,$3,'Ana'), ('99999999-9999-4999-8999-999999999999',$4,NULL,'Outra')`, [presenter, tenantA, user, tenantB])
await db.query(`INSERT INTO cabines VALUES ($1,$2,'Cabine 1')`, [cabine, tenantA])
await db.query(`INSERT INTO marcas VALUES ($1,$2,'Marca A')`, [brand, tenantA])
await db.query(`
  INSERT INTO lives VALUES
    ($1,$2,$3,$4,$5,'encerrada','2026-09-06 12:00:00+00','2026-09-06 16:00:00+00',NULL,1000,NULL,NULL,10,NULL),
    ($6,$2,$3,$4,$5,'encerrada','2026-09-05 12:00:00+00','2026-09-05 14:00:00+00',NULL,0,NULL,NULL,0,NULL),
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$2,$3,$4,$5,'cancelada','2026-09-07 12:00:00+00','2026-09-07 14:00:00+00',NULL,999,NULL,NULL,9,NULL),
    ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',$2,$3,$4,$5,'encerrada','2026-08-31 12:00:00+00','2026-08-31 14:00:00+00',NULL,999,NULL,NULL,9,NULL),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',$7,$3,$4,$5,'encerrada','2026-09-06 12:00:00+00','2026-09-06 14:00:00+00',NULL,999,NULL,NULL,9,NULL)
`, [splitLive, tenantA, user, cabine, brand, zeroLive, tenantB])
// A mesma pessoa aparece pelas três rotas de compatibilidade; UNION precisa
// devolver uma única linha para a live splitada.
await db.query(`INSERT INTO live_apresentadores VALUES ($1,$2,$3)`, [tenantA, splitLive, user])
await db.query(`INSERT INTO live_apresentadoras_v2 VALUES ($1,$2,$3,500,7200,50,'principal')`, [tenantA, splitLive, presenter])
await db.query(`
  INSERT INTO vendas_atribuidas VALUES
    ('dddddddd-dddd-4ddd-8ddd-dddddddddddd',$1,'live',$2,$3,$4,'2026-09-06',500,5,20.25,'pendente_aprovacao',NOW()),
    ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',$1,'live',$2,$3,$4,'2026-09-06',500,5,999,'reprovada',NOW()),
    ('ffffffff-ffff-4fff-8fff-ffffffffffff',$1,'video',NULL,$3,$4,'2026-09-07',50,1,2.75,'pendente_aprovacao',NOW()),
    ('12121212-1212-4212-8212-121212121212',$5,'live','cccccccc-cccc-4ccc-8ccc-cccccccccccc',$3,$4,'2026-09-06',999,9,999,'pendente_aprovacao',NOW())
`, [tenantA, splitLive, presenter, brand, tenantB])


const otherPresenter='13131313-1313-4313-8313-131313131313', otherUser='14141414-1414-4414-8414-141414141414'
const legacyLive='15151515-1515-4515-8515-151515151515', boundaryLive='16161616-1616-4616-8616-161616161616', noDuration='17171717-1717-4717-8717-171717171717'
await db.query(`INSERT INTO apresentadoras VALUES ($1,$2,$3,'Bia')`,[otherPresenter,tenantA,otherUser])
await db.query(`INSERT INTO lives (id,tenant_id,apresentador_id,cabine_id,marca_id,status,iniciado_em,encerrado_em,manual_gmv,manual_orders) VALUES
 ($1,$2,$3,$4,$5,'encerrada','2026-09-10 12:00Z','2026-09-10 16:00Z',1000,8),
 ($6,$2,$7,$4,$5,'encerrada','2026-10-01 01:00Z','2026-10-01 02:00Z',100,1),
 ($8,$2,$7,$4,$5,'encerrada','2026-09-09 12:00Z','2026-09-09 12:00Z',100,1)`,[legacyLive,tenantA,otherUser,cabine,brand,boundaryLive,user,noDuration])
await db.query(`INSERT INTO live_apresentadores VALUES ($1,$2,$3)`,[tenantA,legacyLive,user])
const result=await getOwnPortalPerformance(db,{tenantId:tenantA,apresentadoraId:presenter,range:{start:'2026-09-01',end:'2026-10-01'}})
assert.equal(result.items.length,5)
assert.deepEqual(result.desempenho,{total_lives:5,gmv_lives:1200,horas_live:7,gmv_por_hora:171.43,pedidos:7})
assert.deepEqual(result.items.filter(r=>r.id===legacyLive).map(r=>[r.gmv,r.horas,r.pedidos]),[[500,2,0]])
assert.equal(result.items.filter(r=>r.id===splitLive).length,1)
assert.equal(result.items.find(r=>r.id===noDuration).horas,0)
assert.equal(result.items.some(r=>r.id===boundaryLive),true)
const wrongTenant=await getOwnPortalPerformance(db,{tenantId:tenantB,apresentadoraId:presenter,range:{start:'2026-09-01',end:'2026-10-01'}})
assert.deepEqual(wrongTenant.items,[])
const other=await getOwnPortalPerformance(db,{tenantId:tenantA,apresentadoraId:otherPresenter,range:{start:'2026-09-01',end:'2026-10-01'}})
assert.equal(other.items.length,1)
assert.equal(other.items[0].gmv,500)
assert.equal(other.items[0].horas,2)
await db.close()
console.log(JSON.stringify({passed:true,checks:['own-only','tenant-isolation','v2-deduplication','zero-GMV','legacy-shares','Sao-Paulo-month-boundary','zero-duration','safe-DTO'],performance:result.desempenho}))
