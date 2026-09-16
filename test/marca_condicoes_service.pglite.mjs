// Fluxo transacional real em PGlite; não conecta em produção.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { confirmarCondicaoMarca, preverCondicaoMarca } from '../src/services/marca-condicoes.js'

const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')
const db = new PGlite()
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant = id(1)
const marca = id(2)
const proposal = {
  inicio_vigencia: '2026-09', fixo_mensal: 1200,
  comissao_franquia_pct: 8, comissao_franqueadora_pct: 2,
  tipo_cobranca: 'fixo_mais_comissao', fixo_confirmado: true,
  comissao_confirmada: true,
}

await db.exec(`
  CREATE TABLE tenants(id uuid PRIMARY KEY);
  CREATE TABLE users(id uuid PRIMARY KEY);
  CREATE TABLE clientes(id uuid PRIMARY KEY);
  CREATE TABLE marcas(
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
    cliente_id uuid REFERENCES clientes(id), nome text NOT NULL, tipo text NOT NULL,
    valor_fixo_minimo numeric(15,2), comissao_franquia_pct numeric(5,2),
    comissao_franqueadora_pct numeric(5,2), tipo_cobranca text, atualizado_em timestamptz
  );
  CREATE TABLE lives(
    id uuid PRIMARY KEY, tenant_id uuid, marca_id uuid, iniciado_em timestamptz,
    fat_gerado numeric(15,2), comissao_calculada numeric(15,2), atualizado_em timestamptz,
    faturado_em timestamptz, boleto_id uuid, uniao_destino_id uuid, uniao_desfeita_em timestamptz
  );
  CREATE TABLE vendas_atribuidas(
    id uuid PRIMARY KEY, tenant_id uuid, marca_id uuid, data date, gmv numeric(15,2),
    status_aprovacao text, comissao_franquia numeric(15,2),
    comissao_franqueadora numeric(15,2), marca_condicao_id uuid, atualizado_em timestamptz
  );
  CREATE TABLE audit_log(
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, user_id uuid,
    action text, entity_type text, entity_id uuid, metadata jsonb
  );
  INSERT INTO tenants VALUES ('${tenant}');
  INSERT INTO marcas(id,tenant_id,nome,tipo,valor_fixo_minimo,comissao_franquia_pct,comissao_franqueadora_pct,tipo_cobranca,atualizado_em)
    VALUES ('${marca}','${tenant}','Marca A','cliente',1000,5,2,'fixo_mais_comissao',NOW());
  INSERT INTO lives(id,tenant_id,marca_id,iniciado_em,fat_gerado,comissao_calculada)
    VALUES ('${id(3)}','${tenant}','${marca}','2026-09-15T12:00:00Z',10000,500),
           ('${id(5)}','${tenant}','${marca}','2026-10-15T12:00:00Z',2000,100),
           -- Historical origin of a union: it must not inflate preview or recalc.
           ('${id(7)}','${tenant}','${marca}','2026-09-20T12:00:00Z',999,50);
  UPDATE lives SET uniao_destino_id='${id(3)}' WHERE id='${id(7)}';
  INSERT INTO vendas_atribuidas(id,tenant_id,marca_id,data,gmv,status_aprovacao,comissao_franquia,comissao_franqueadora)
    VALUES ('${id(4)}','${tenant}','${marca}','2026-09-15',10000,'pendente_aprovacao',500,200),
           ('${id(6)}','${tenant}','${marca}','2026-10-15',2000,'pendente_aprovacao',100,40),
           ('${id(9)}','${tenant}','${marca}','2026-07-15',300,'fechada',15,6),
           ('${id(10)}','${tenant}','${marca}','2026-07-15',400,'faturada',20,8),
           -- Rejected financial movement: it must not be open or recalculated.
           ('${id(8)}','${tenant}','${marca}','2026-10-15',999,'reprovada',1,1);
`)
await db.exec(await readFile(new URL('../migrations/151_marca_condicoes_comerciais.sql', import.meta.url), 'utf8'))
await db.query(`SELECT set_config('app.tenant_id',$1,false)`, [tenant])

const preview = await preverCondicaoMarca(db, { tenantId: tenant, marcaId: marca, proposta: proposal })
assert.equal(preview.bloqueada, false)
assert.equal(preview.fim_vigencia_exclusivo, '2026-11-01')
assert.equal(preview.impacto.movimentos_abertos, 4)
assert.equal(preview.impacto.movimentos_fechados, 0)
assert.equal((await db.query('SELECT count(*)::int AS total FROM marca_condicoes_comerciais')).rows[0].total, 1)

const confirmed = await confirmarCondicaoMarca(db, {
  tenantId: tenant, marcaId: marca, proposta: proposal,
  expectedRevision: 1, idempotencyKey: 'pglite-contract-1', actorUserId: null,
})
const protectedPreview = await preverCondicaoMarca(db, {
  tenantId: tenant, marcaId: marca,
  proposta: { ...proposal, inicio_vigencia: '2026-07' },
})
assert.equal(protectedPreview.bloqueada, true)
assert.equal(protectedPreview.impacto.movimentos_fechados, 2)
assert.equal(confirmed.idempotent, false)
const conditionId = confirmed.condition.id
assert.equal((await db.query(`SELECT marca_condicao_id FROM vendas_atribuidas WHERE id=$1`, [id(4)])).rows[0].marca_condicao_id, conditionId)
assert.equal((await db.query(`SELECT marca_condicao_id FROM vendas_atribuidas WHERE id=$1`, [id(6)])).rows[0].marca_condicao_id, conditionId)
assert.equal((await db.query(`SELECT comissao_franquia,comissao_franqueadora FROM vendas_atribuidas WHERE id=$1`, [id(4)])).rows[0].comissao_franquia, '800.00')
assert.equal((await db.query(`SELECT comissao_calculada FROM lives WHERE id=$1`, [id(3)])).rows[0].comissao_calculada, '800.00')
assert.equal((await db.query(`SELECT comissao_calculada FROM lives WHERE id=$1`, [id(5)])).rows[0].comissao_calculada, '160.00')
assert.equal((await db.query(`SELECT comissao_franquia FROM vendas_atribuidas WHERE id=$1`, [id(6)])).rows[0].comissao_franquia, '160.00')
assert.equal((await db.query(`SELECT comissao_franquia FROM vendas_atribuidas WHERE id=$1`, [id(9)])).rows[0].comissao_franquia, '15.00')
assert.equal((await db.query(`SELECT comissao_franquia FROM vendas_atribuidas WHERE id=$1`, [id(10)])).rows[0].comissao_franquia, '20.00')
assert.equal((await db.query(`SELECT comissao_franquia FROM vendas_atribuidas WHERE id=$1`, [id(8)])).rows[0].comissao_franquia, '1.00')
assert.equal((await db.query(`SELECT comissao_calculada FROM lives WHERE id=$1`, [id(7)])).rows[0].comissao_calculada, '50.00')
assert.equal((await db.query(`SELECT valor_fixo_minimo,comissao_franquia_pct FROM marcas WHERE id=$1`, [marca])).rows[0].valor_fixo_minimo, '1200.00')

// A second confirmation with the same key is a read-only idempotent retry.
const retry = await confirmarCondicaoMarca(db, {
  tenantId: tenant, marcaId: marca, proposta: proposal,
  expectedRevision: 2, idempotencyKey: 'pglite-contract-1', actorUserId: null,
})
assert.equal(retry.idempotent, true)

// Closed live is detected before insertion and rolls back.
await db.query(`UPDATE lives SET faturado_em=NOW() WHERE id=$1`, [id(5)])
await assert.rejects(
  confirmarCondicaoMarca(db, {
    tenantId: tenant, marcaId: marca,
    proposta: { ...proposal, inicio_vigencia: '2026-10' },
    expectedRevision: 2, idempotencyKey: 'pglite-contract-closed',
  }),
  (error) => error.code === 'FINANCIAL_PERIOD_CLOSED' && error.statusCode === 409,
)
assert.equal((await db.query(`SELECT count(*)::int AS total FROM marca_condicoes_comerciais WHERE inicio_vigencia='2026-10-01'`)).rows[0].total, 0)

console.log('PASS: real preview/confirm, open recalc, projection, idempotent retry and closed rollback')
await db.close()
