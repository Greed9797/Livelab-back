import assert from 'node:assert/strict'

import { ensureClienteMarca } from '../src/services/client-brand.js'

const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')
const db = new PGlite()
const tenant = '00000000-0000-4000-8000-000000000001'
const cancelled = '00000000-0000-4000-8000-000000000002'
const archived = '00000000-0000-4000-8000-000000000003'
const active = '00000000-0000-4000-8000-000000000004'

try {
  await db.exec(`
    CREATE TABLE clientes (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, nome text, site text, logo_url text, status text NOT NULL);
    CREATE TABLE marcas (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, cliente_id uuid NOT NULL,
      nome text, tipo text, status text, tiktok_username text, site text, logo_url text,
      observacoes text, origem_dados text, criado_em timestamptz DEFAULT now(), atualizado_em timestamptz DEFAULT now()
    );
  `)
  await db.query(`INSERT INTO clientes(id, tenant_id, nome, status) VALUES
    ($1,$4,'Cancelado','cancelado'), ($2,$4,'Arquivado','arquivado'), ($3,$4,'Ativo','ativo')`, [cancelled, archived, active, tenant])

  await ensureClienteMarca(db, { tenantId: tenant, clienteId: cancelled })
  await ensureClienteMarca(db, { tenantId: tenant, clienteId: archived })
  const inserted = await db.query(`SELECT cliente_id::text, status FROM marcas ORDER BY cliente_id`)
  assert.deepEqual(inserted.rows, [
    { cliente_id: cancelled, status: 'inativa' },
    { cliente_id: archived, status: 'arquivada' },
  ])
  await ensureClienteMarca(db, { tenantId: tenant, clienteId: archived, activateExisting: true })
  assert.equal((await db.query(`SELECT status FROM marcas WHERE cliente_id=$1`, [archived])).rows[0].status, 'arquivada')

  await db.query(`INSERT INTO marcas(tenant_id, cliente_id, nome, tipo, status) VALUES ($1,$2,'Ativo','cliente','inativa')`, [tenant, active])
  await ensureClienteMarca(db, { tenantId: tenant, clienteId: active })
  assert.equal((await db.query(`SELECT status FROM marcas WHERE cliente_id=$1`, [active])).rows[0].status, 'inativa')
  await ensureClienteMarca(db, { tenantId: tenant, clienteId: active, activateExisting: true })
  assert.equal((await db.query(`SELECT status FROM marcas WHERE cliente_id=$1`, [active])).rows[0].status, 'ativa')
  console.log(JSON.stringify({ passed: true, checks: ['cancelled insert inactive', 'archived insert archived', 'archived parent cannot reactivate', 'normal call preserves inactive', 'explicit active reactivates'] }))
} finally {
  await db.close()
}
