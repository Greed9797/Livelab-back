import assert from 'node:assert/strict'

import { ensureClienteMarca } from '../src/services/client-brand.js'

const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')
const db = new PGlite()
const tenant = '00000000-0000-4000-8000-000000000001'
const cancelled = '00000000-0000-4000-8000-000000000002'
const archived = '00000000-0000-4000-8000-000000000003'
const active = '00000000-0000-4000-8000-000000000004'
const configured = '00000000-0000-4000-8000-000000000005'

try {
  await db.exec(`
    CREATE TABLE clientes (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, nome text, site text, logo_url text, status text NOT NULL);
    CREATE TABLE marcas (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, cliente_id uuid NOT NULL,
      nome text, tipo text, status text, tiktok_username text, site text, logo_url text,
      observacoes text, origem_dados text, criado_em timestamptz DEFAULT now(), atualizado_em timestamptz DEFAULT now()
    );
    CREATE TABLE marca_condicoes_comerciais (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      marca_id uuid NOT NULL, inicio_vigencia date NOT NULL,
      fixo_mensal numeric DEFAULT 0, comissao_franquia_pct numeric DEFAULT 0,
      comissao_franqueadora_pct numeric DEFAULT 0, tipo_cobranca text DEFAULT 'fixo_mais_comissao',
      fixo_confirmado boolean DEFAULT false, comissao_confirmada boolean DEFAULT false,
      origem text DEFAULT 'legado_nao_verificado', motivo text, cancelled_at timestamptz,
      UNIQUE (tenant_id, marca_id, inicio_vigencia)
    );
  `)
  await db.query(`INSERT INTO clientes(id, tenant_id, nome, status) VALUES
    ($1,$5,'Cancelado','cancelado'), ($2,$5,'Arquivado','arquivado'), ($3,$5,'Ativo','ativo'), ($4,$5,'Configurado','ativo')`, [cancelled, archived, active, configured, tenant])

  await ensureClienteMarca(db, { tenantId: tenant, clienteId: cancelled })
  await ensureClienteMarca(db, { tenantId: tenant, clienteId: archived })
  const inserted = await db.query(`SELECT cliente_id::text, status FROM marcas ORDER BY cliente_id`)
  assert.deepEqual(inserted.rows, [
    { cliente_id: cancelled, status: 'inativa' },
    { cliente_id: archived, status: 'arquivada' },
  ])
  assert.equal((await db.query(`SELECT count(*)::int AS total FROM marca_condicoes_comerciais`)).rows[0].total, 2)
  await ensureClienteMarca(db, { tenantId: tenant, clienteId: archived, activateExisting: true })
  assert.equal((await db.query(`SELECT status FROM marcas WHERE cliente_id=$1`, [archived])).rows[0].status, 'arquivada')

  await db.query(`INSERT INTO marcas(tenant_id, cliente_id, nome, tipo, status) VALUES ($1,$2,'Ativo','cliente','inativa')`, [tenant, active])
  await ensureClienteMarca(db, { tenantId: tenant, clienteId: active })
  assert.equal((await db.query(`SELECT status FROM marcas WHERE cliente_id=$1`, [active])).rows[0].status, 'inativa')
  await ensureClienteMarca(db, { tenantId: tenant, clienteId: active, activateExisting: true })
  assert.equal((await db.query(`SELECT status FROM marcas WHERE cliente_id=$1`, [active])).rows[0].status, 'ativa')
  await ensureClienteMarca(db, {
    tenantId: tenant, clienteId: configured,
    baseline: { valor_fixo_minimo: 1200, comissao_franquia_pct: 8, comissao_franqueadora_pct: 2, tipo_cobranca: 'fixo_ou_comissao' },
  })
  assert.deepEqual((await db.query(`
    SELECT fixo_mensal, comissao_franquia_pct, tipo_cobranca, fixo_confirmado, comissao_confirmada, origem
      FROM marca_condicoes_comerciais c
     JOIN marcas m ON m.id = c.marca_id
     WHERE m.cliente_id=$1`, [configured])).rows[0], {
    fixo_mensal: '1200', comissao_franquia_pct: '8', tipo_cobranca: 'fixo_ou_comissao',
    fixo_confirmado: false, comissao_confirmada: false, origem: 'legado_nao_verificado',
  })
  assert.equal((await db.query(`SELECT count(*)::int AS total FROM marca_condicoes_comerciais`)).rows[0].total, 4)
  console.log(JSON.stringify({ passed: true, checks: ['cancelled insert inactive', 'archived insert archived', 'archived parent cannot reactivate', 'normal call preserves inactive', 'explicit active reactivates'] }))
} finally {
  await db.close()
}
