// Real PostgreSQL semantics in an isolated in-memory database; no production connection.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')
const db = new PGlite()
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
await db.exec(`
  CREATE TABLE tenants(id uuid PRIMARY KEY);
  CREATE TABLE users(id uuid PRIMARY KEY);
  CREATE TABLE lives(id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
    fat_gerado numeric, comissao_calculada numeric, atualizado_em timestamptz);
  CREATE TABLE live_apresentadoras_v2(id uuid PRIMARY KEY, tenant_id uuid, live_id uuid REFERENCES lives(id));
  CREATE TABLE live_apresentadores(id uuid PRIMARY KEY, tenant_id uuid, live_id uuid REFERENCES lives(id));
  CREATE TABLE vendas_atribuidas(id uuid PRIMARY KEY, tenant_id uuid, origem text, origem_id uuid,
    apresentadora_id uuid, gmv numeric, pedidos integer, comissao_apresentadora numeric, status_aprovacao text);
`)
await db.exec(await readFile(new URL('../migrations/150_live_unioes.sql', import.meta.url), 'utf8'))
await db.query('INSERT INTO tenants VALUES ($1),($2)', [id(1), id(2)])
await db.query('INSERT INTO users VALUES ($1)', [id(3)])
await db.query(`INSERT INTO lives(id,tenant_id,fat_gerado) VALUES ($1,$4,100),($2,$4,200),($3,$5,400)`, [id(10), id(11), id(12), id(1), id(2)])
await db.query(`INSERT INTO live_apresentadoras_v2 VALUES ($1,$2,$3,NULL)`, [id(20),id(1),id(10)])
await assert.rejects(db.query(`UPDATE lives SET uniao_destino_id=$1 WHERE id=$2`, [id(11),id(10)]), /união/i)
await db.query('BEGIN')
await db.query(`SELECT set_config('livelab.live_merge_write','on',true)`)
await db.query(`INSERT INTO live_unioes(id,tenant_id,live_destino_id,request_id,request_hash,preview_token,origens,resultado,motivo,criado_por)
  VALUES ($1,$2,$3,$4,'hash','token','[]','{}','teste',$5)`, [id(30),id(1),id(11),id(40),id(3)])
await db.query(`UPDATE lives SET uniao_id=$1 WHERE id=$2`, [id(30), id(11)])
await db.query(`UPDATE lives SET uniao_destino_id=$1 WHERE id=$2`, [id(11),id(10)])
await db.query(`INSERT INTO vendas_atribuidas VALUES ($1,$2,'live',$3,$4,300,30,10,'pendente_aprovacao')`, [id(50),id(1),id(11),id(60)])
await db.query('COMMIT')
for (const live of [id(10), id(11)]) {
  await assert.rejects(db.query('UPDATE lives SET fat_gerado=999 WHERE id=$1',[live]), /união/i)
  await assert.rejects(db.query('DELETE FROM lives WHERE id=$1',[live]), /união/i)
}
await assert.rejects(db.query('DELETE FROM live_apresentadoras_v2 WHERE id=$1',[id(20)]), /união/i)
await assert.rejects(db.query(`INSERT INTO vendas_atribuidas VALUES ($1,$2,'live',$3,$4,100,10,1,'pendente_aprovacao')`,[id(51),id(1),id(10),id(60)]), /união/i)
await assert.rejects(db.query('UPDATE vendas_atribuidas SET gmv=999 WHERE id=$1',[id(50)]), /união/i)
await db.query('UPDATE vendas_atribuidas SET comissao_apresentadora=12 WHERE id=$1',[id(50)])
await db.query(`UPDATE vendas_atribuidas SET status_aprovacao='aprovada' WHERE id=$1`,[id(50)])
await db.query('UPDATE lives SET comissao_calculada=12 WHERE id=$1',[id(11)])
await db.query('UPDATE lives SET fat_gerado=450 WHERE id=$1',[id(12)])

// Even the internal bypass cannot create a cross-tenant union reference.
await db.query('BEGIN')
await db.query(`SELECT set_config('livelab.live_merge_write','on',true)`)
await assert.rejects(db.query(`UPDATE lives SET uniao_destino_id=$1 WHERE id=$2`,[id(12),id(10)]), error => error.code === '23503')
await db.query('ROLLBACK')

// Tenant isolation on audit rows, using a non-owner role.
await db.exec(`CREATE ROLE merge_reader; GRANT USAGE ON SCHEMA public TO merge_reader; GRANT SELECT ON live_unioes TO merge_reader;`)
await db.query(`SELECT set_config('app.tenant_id',$1,false)`,[id(2)])
await db.exec('SET ROLE merge_reader')
assert.equal((await db.query('SELECT * FROM live_unioes')).rows.length,0)
await db.exec('RESET ROLE')
await db.query(`SELECT set_config('app.tenant_id',$1,false)`,[id(1)])
await db.exec('SET ROLE merge_reader')
assert.equal((await db.query('SELECT * FROM live_unioes')).rows.length,1)
await db.exec('RESET ROLE')
console.log('PASS: mutation guards, financial recalculation, approval, tenant FK and audit RLS (real SQL)')
await db.close()
