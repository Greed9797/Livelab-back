import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { desfazerRecebimento, receberTitulo } from '../src/services/receitas-comercial.js'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const [tenant, outro, marca, titulo, ator] = [1, 2, 3, 4, 5].map(id)
const pg = new PGlite()
await pg.exec(`
  CREATE TABLE tenants (id uuid PRIMARY KEY);
  CREATE TABLE marcas (id uuid PRIMARY KEY, tenant_id uuid, nome text, tipo text, tipo_cobranca text);
  CREATE TABLE clientes (id uuid PRIMARY KEY, tenant_id uuid, nome text);
  CREATE TABLE receita_titulos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, marca_id uuid NOT NULL, cliente_id uuid,
    competencia date NOT NULL, componente text NOT NULL, valor_previsto numeric(15,2) NOT NULL,
    valor_pago numeric(15,2) NOT NULL DEFAULT 0, valor_perdido numeric(15,2),
    data_vencimento date NOT NULL, data_pagamento date, observacao text,
    perdido_em timestamptz, perdido_motivo text, perdido_por uuid, criado_por uuid,
    atualizado_em timestamptz, UNIQUE (tenant_id, marca_id, competencia, componente)
  );
  INSERT INTO tenants VALUES ('${tenant}'), ('${outro}');
  INSERT INTO marcas VALUES ('${marca}', '${tenant}', 'Alfa', 'cliente', 'fixo');
  INSERT INTO receita_titulos (id, tenant_id, marca_id, competencia, componente, valor_previsto, data_vencimento)
    VALUES ('${titulo}', '${tenant}', '${marca}', '2026-09-01', 'fixo', 100.00, '2026-10-05');
`)
await pg.exec(await readFile(new URL('../migrations/180_financeiro_liquidacoes_estornos.sql', import.meta.url), 'utf8'))
await pg.exec(`
  ALTER TABLE receita_titulos ENABLE ROW LEVEL SECURITY;
  ALTER TABLE receita_titulos FORCE ROW LEVEL SECURITY;
  CREATE POLICY titulo_tenant ON receita_titulos
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  CREATE ROLE fin03_comercial;
  GRANT USAGE ON SCHEMA public TO fin03_comercial;
  GRANT SELECT, INSERT, UPDATE ON receita_titulos TO fin03_comercial;
  GRANT SELECT, INSERT, UPDATE ON financeiro_liquidacoes TO fin03_comercial;
  GRANT SELECT, INSERT ON financeiro_estornos TO fin03_comercial;
  GRANT SELECT ON marcas, clientes TO fin03_comercial;
  SELECT set_config('app.tenant_id', '${tenant}', false);
  SET ROLE fin03_comercial;
`)
const db = {
  query(sql, params) {
    // Só a consulta comercial de apresentação depende do restante do schema.
    if (String(sql).includes('WITH comissao_marca')) return Promise.resolve({ rows: params?.[0] === '2026-08-01' ? [{
      marca_id: marca, competencia: '2026-08-01', fixo: '40.00', comissao: '0',
      marca_nome: 'Alfa', marca_tipo: 'cliente', tipo_cobranca: 'fixo_mais_comissao',
    }] : [] })
    return pg.query(sql, params)
  },
}
const opts = { tenantId: tenant, id: titulo, hoje: '2026-10-05', actorId: ator, actorType: 'usuario' }

assert.equal((await receberTitulo(db, { ...opts, valorPago: '30.01', chaveOperacao: id(10) })).valor_pago, 30.01)
assert.equal((await receberTitulo(db, { ...opts, valorPago: '30.01', chaveOperacao: id(10) })).valor_pago, 30.01)
assert.equal((await receberTitulo(db, { ...opts, hoje: '2026-10-06', valorPago: '30.01', chaveOperacao: id(10) })).valor_pago, 30.01)
await assert.rejects(receberTitulo(db, { ...opts, valorPago: '31.01', chaveOperacao: id(10) }),
  (error) => error.code === 'FINANCEIRO_IDEMPOTENCIA_CONFLITO')
assert.equal((await desfazerRecebimento(db, { ...opts, chaveOperacao: id(20) })).valor_pago, 0)
assert.equal((await receberTitulo(db, { ...opts, valorPago: '100.00', chaveOperacao: id(11) })).valor_pago, 100)
await assert.rejects(receberTitulo(db, { ...opts, valorPago: '100.01', chaveOperacao: id(12) }),
  (error) => error.statusCode === 409)
await assert.rejects(receberTitulo(db, { ...opts, tenantId: outro, chaveOperacao: id(13) }),
  (error) => error.statusCode === 404 || error.code === 'FINANCEIRO_ORIGEM_INVALIDA')
assert.equal((await db.query(`SELECT SUM(valor)::text AS total FROM financeiro_liquidacoes
  WHERE origem_id = $1::uuid`, [titulo])).rows[0].total, '130.01')

assert.equal((await desfazerRecebimento(db, { ...opts, chaveOperacao: id(21) })).valor_pago, 0)
assert.equal((await db.query(`SELECT SUM(valor)::text AS total FROM financeiro_estornos`)).rows[0].total, '130.01')
assert.equal((await receberTitulo(db, { ...opts, valorPago: '10.00', chaveOperacao: id(22) })).valor_pago, 10)
await assert.rejects(desfazerRecebimento(db, { ...opts, chaveOperacao: id(21) }),
  (error) => error.code === 'FINANCEIRO_IDEMPOTENCIA_CONFLITO')
assert.equal((await receberTitulo(db, { ...opts, valorPago: '20.00', chaveOperacao: id(23) })).valor_pago, 20)
await assert.rejects(desfazerRecebimento(db, { ...opts, chaveOperacao: id(24) }),
  (error) => error.code === 'RECEITA_ESTORNO_GRANULAR_NECESSARIO')
assert.equal((await db.query(`SELECT valor_pago::text AS valor FROM receita_titulos WHERE id = $1::uuid`, [titulo])).rows[0].valor, '20.00')
assert.equal((await db.query(`SELECT SUM(valor)::text AS total FROM financeiro_estornos`)).rows[0].total, '130.01')
assert.equal((await db.query(`SELECT COUNT(*)::int AS count FROM financeiro_liquidacoes`)).rows[0].count, 4)
const virtual = await receberTitulo(db, {
  tenantId: tenant, id: `calc:${marca}:2026-08:fixo`, hoje: '2026-10-05', actorId: ator,
})
assert.equal(virtual.valor_pago, 40)
assert.match(virtual.id, /^[0-9a-f-]{36}$/)
assert.equal((await db.query(`SELECT COUNT(*)::int AS count FROM financeiro_liquidacoes
  WHERE origem_id = $1::uuid`, [virtual.id])).rows[0].count, 1)
console.log('financeiro_liquidacoes_comercial PGlite ok')
