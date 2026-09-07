import assert from 'node:assert/strict'
import { marcaStatusOperacionalSql } from '../src/lib/entity-status.js'
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')
const db = new PGlite()
try {
  await db.exec(`CREATE TABLE clientes(id int,tenant_id int,status text);
    CREATE TABLE marcas(id int,tenant_id int,cliente_id int,tipo text,status text);
    CREATE TABLE lives(id int,marca_id int,gmv numeric);
    INSERT INTO clientes VALUES (1,1,'arquivado'),(2,1,'cancelado'),(3,1,'ativo'),(4,1,'inadimplente'),(1,2,'ativo'),(5,1,'reprovado');
    INSERT INTO marcas VALUES (1,1,1,'cliente','ativa'),(2,1,2,'cliente','ativa'),(3,1,3,'cliente','ativa'),(4,1,4,'cliente','ativa'),(5,1,NULL,'afiliada','ativa'),(6,1,3,'cliente','inativa'),(7,1,3,'cliente','pausada'),(8,2,1,'cliente','ativa'),(9,1,5,'cliente','ativa');
    INSERT INTO lives VALUES (1,1,100),(2,2,200);`)
  const status = marcaStatusOperacionalSql()
  const base = `FROM marcas m LEFT JOIN clientes c ON c.id=m.cliente_id AND c.tenant_id=m.tenant_id WHERE m.tenant_id=$1`
  const active = await db.query(`SELECT m.id ${base} AND ${status}='ativa' ORDER BY m.id`,[1])
  assert.deepEqual(active.rows.map(x=>x.id),[3,4,5])
  const all = await db.query(`SELECT m.id,${status} AS status ${base} ORDER BY m.id`,[1])
  assert.equal(all.rows.find(x=>x.id===1).status,'arquivada')
  assert.equal(all.rows.find(x=>x.id===2).status,'inativa')
  assert.equal(all.rows.find(x=>x.id===6).status,'inativa')
  assert.equal(all.rows.find(x=>x.id===7).status,'pausada')
  assert.equal(all.rows.find(x=>x.id===9).status,'inativa')
  const other = await db.query(`SELECT m.id ${base} AND ${status}='ativa'`,[2])
  assert.deepEqual(other.rows,[{id:8}])
  assert.equal(Number((await db.query('SELECT SUM(l.gmv) AS total FROM lives l JOIN marcas m ON m.id=l.marca_id WHERE m.tenant_id=1')).rows[0].total),300)
  console.log(JSON.stringify({passed:true,checks:['archived client hides active mirror','cancelled client hides active mirror','explicit inactive preserved','paused preserved','tenant join isolated','historical live revenue preserved']}))
} finally {await db.close()}
