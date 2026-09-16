// SQL real isolado para a migration 151. Nunca aponta para produção.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')
const db = new PGlite()
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const migration = await readFile(new URL('../migrations/151_marca_condicoes_comerciais.sql', import.meta.url), 'utf8')

await db.exec(`
  CREATE TABLE tenants (id uuid PRIMARY KEY);
  CREATE TABLE users (id uuid PRIMARY KEY);
  CREATE TABLE clientes (id uuid PRIMARY KEY);
  CREATE TABLE marcas (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
    cliente_id uuid REFERENCES clientes(id), nome text NOT NULL,
    tipo text NOT NULL DEFAULT 'cliente', valor_fixo_minimo numeric(15,2),
    comissao_franquia_pct numeric(5,2), comissao_franqueadora_pct numeric(5,2),
    tipo_cobranca text, criado_em timestamptz DEFAULT now()
  );
  INSERT INTO tenants VALUES ('${id(1)}'), ('${id(2)}');
  INSERT INTO clientes VALUES ('${id(3)}'), ('${id(4)}');
  INSERT INTO marcas(id, tenant_id, cliente_id, nome, tipo, valor_fixo_minimo,
                     comissao_franquia_pct, comissao_franqueadora_pct, tipo_cobranca)
  VALUES ('${id(10)}','${id(1)}','${id(3)}','Marca A','cliente',1000,5,2,'fixo_mais_comissao'),
         ('${id(11)}','${id(2)}','${id(4)}','Marca B','cliente',0,0,0,'fixo_mais_comissao');
`)

await db.exec(migration)
await db.exec(migration)

const baseline = await db.query(`
  SELECT tenant_id, marca_id, inicio_vigencia::text, fixo_mensal,
         comissao_franquia_pct, fixo_confirmado, origem
    FROM marca_condicoes_comerciais
   ORDER BY tenant_id, marca_id
`)
assert.equal(baseline.rows.length, 2)
assert.deepEqual(baseline.rows[0], {
  tenant_id: id(1), marca_id: id(10), inicio_vigencia: '1900-01-01',
  fixo_mensal: '1000.00', comissao_franquia_pct: '5.00',
  fixo_confirmado: false, origem: 'legado_nao_verificado',
})

// Same active mark/month is unique, while a different tenant can use its own mark.
await assert.rejects(
  db.query(`INSERT INTO marca_condicoes_comerciais(tenant_id,marca_id,inicio_vigencia)
            VALUES ($1,$2,$3)`, [id(1), id(10), '1900-01-01']),
  (error) => error.code === '23505',
)
await db.query(`INSERT INTO marca_condicoes_comerciais(tenant_id,marca_id,inicio_vigencia)
                VALUES ($1,$2,$3)`, [id(2), id(11), '2026-09-01'])

// Composite FK rejects a mark from the other tenant even though the UUID is valid.
await assert.rejects(
  db.query(`INSERT INTO marca_condicoes_comerciais(tenant_id,marca_id,inicio_vigencia)
            VALUES ($1,$2,$3)`, [id(1), id(11), '2026-10-01']),
  (error) => error.code === '23503',
)

await db.query(`SELECT set_config('app.tenant_id',$1,false)`, [id(1)])
await db.exec('CREATE ROLE condition_reader; GRANT USAGE ON SCHEMA public TO condition_reader; GRANT SELECT ON marca_condicoes_comerciais TO condition_reader;')
await db.exec('SET ROLE condition_reader')
assert.equal((await db.query('SELECT count(*)::int AS total FROM marca_condicoes_comerciais')).rows[0].total, 1)
await db.exec('RESET ROLE')

console.log('PASS: migration 151 idempotent, baseline, unique, composite FK and tenant RLS')
await db.close()
