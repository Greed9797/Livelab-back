import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

import { desfazerPagamentoApresentadora, registrarPagamentoApresentadora } from '../src/services/apresentadoras-pagamentos.js'
import { darBaixaConciliacao, desfazerBaixaConciliacao } from '../src/services/conciliacao.js'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const [tenant, outroTenant, apresentadora, legado, multi, ator] = [1, 2, 3, 4, 5, 6].map(id)
const mes = '2026-10'
const pg = new PGlite()

await pg.exec(`
  CREATE TABLE tenants (id uuid PRIMARY KEY);
  CREATE TABLE apresentadoras (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), nome text NOT NULL);
  CREATE TABLE apresentadora_pagamentos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
    apresentadora_id uuid NOT NULL REFERENCES apresentadoras(id), competencia date NOT NULL,
    componente text NOT NULL DEFAULT 'fixo', valor_pago numeric(15,2) NOT NULL DEFAULT 0,
    data_pagamento date, observacao text, criado_por uuid, cancelado_em timestamptz,
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, apresentadora_id, competencia, componente)
  );
  INSERT INTO tenants VALUES ('${tenant}'), ('${outroTenant}');
  INSERT INTO apresentadoras VALUES
    ('${apresentadora}', '${tenant}', 'Canônica'),
    ('${legado}', '${tenant}', 'Legada'),
    ('${multi}', '${tenant}', 'Multi');
  INSERT INTO apresentadora_pagamentos (tenant_id, apresentadora_id, competencia, componente, valor_pago, data_pagamento)
    VALUES ('${tenant}', '${legado}', '${mes}-01', 'fixo', 10.00, '2026-10-05');
`)
await pg.exec(await readFile(new URL('../migrations/180_financeiro_liquidacoes_estornos.sql', import.meta.url), 'utf8'))
await pg.exec(`
  ALTER TABLE apresentadora_pagamentos ENABLE ROW LEVEL SECURITY;
  ALTER TABLE apresentadora_pagamentos FORCE ROW LEVEL SECURITY;
  CREATE POLICY apresentadora_pagamentos_tenant_test ON apresentadora_pagamentos
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  CREATE ROLE fin03_apresentadoras;
  GRANT USAGE ON SCHEMA public TO fin03_apresentadoras;
  GRANT SELECT, INSERT, UPDATE ON apresentadora_pagamentos TO fin03_apresentadoras;
  GRANT SELECT ON apresentadoras TO fin03_apresentadoras;
  GRANT SELECT, INSERT, UPDATE ON financeiro_liquidacoes TO fin03_apresentadoras;
  GRANT SELECT, INSERT, UPDATE ON financeiro_estornos TO fin03_apresentadoras;
  SELECT set_config('app.tenant_id', '${tenant}', false);
  SET ROLE fin03_apresentadoras;
`)

const base = {
  tenantId: tenant, apresentadoraId: apresentadora, mes, componente: 'fixo',
  dataPagamento: '2026-10-05', userId: ator,
}

const parcial = await registrarPagamentoApresentadora(pg, { ...base, valorPago: '30.01', chaveOperacao: id(10) })
assert.equal(parcial.valor_pago, '30.01')
assert.equal((await registrarPagamentoApresentadora(pg, { ...base, valorPago: '30.01', chaveOperacao: id(10) })).valor_pago, '30.01')
assert.equal((await pg.query('SELECT count(*)::int AS n FROM financeiro_liquidacoes WHERE origem_id = $1::uuid', [parcial.id])).rows[0].n, 1)
await assert.rejects(
  registrarPagamentoApresentadora(pg, { ...base, valorPago: '31.01', chaveOperacao: id(10) }),
  (error) => error.code === 'FINANCEIRO_IDEMPOTENCIA_CONFLITO' && error.statusCode === 409,
)

const estornado = await desfazerPagamentoApresentadora(pg, { ...base, chaveOperacao: id(20), hoje: '2026-10-06' })
assert.equal(estornado, true)
assert.equal(await desfazerPagamentoApresentadora(pg, { ...base, chaveOperacao: id(20), hoje: '2026-10-06' }), true)
assert.equal((await pg.query('SELECT valor_pago::text AS valor FROM apresentadora_pagamentos WHERE id = $1::uuid', [parcial.id])).rows[0].valor, '0.00')
assert.equal((await pg.query('SELECT count(*)::int AS n FROM financeiro_estornos')).rows[0].n, 1)

await assert.rejects(
  registrarPagamentoApresentadora(pg, { tenantId: tenant, apresentadoraId: legado, mes, componente: 'fixo', valorPago: '20.00', chaveOperacao: id(30), userId: ator }),
  (error) => error.code === 'APRESENTADORA_LIQUIDACAO_DIVERGENTE' && error.statusCode === 409,
)
await assert.rejects(
  desfazerPagamentoApresentadora(pg, { tenantId: tenant, apresentadoraId: legado, mes, componente: 'fixo', chaveOperacao: id(31), hoje: '2026-10-06', userId: ator }),
  (error) => error.code === 'APRESENTADORA_LIQUIDACAO_DIVERGENTE' && error.statusCode === 409,
)

await registrarPagamentoApresentadora(pg, { ...base, apresentadoraId: multi, valorPago: '30.00', chaveOperacao: id(40) })
await registrarPagamentoApresentadora(pg, { ...base, apresentadoraId: multi, valorPago: '100.00', chaveOperacao: id(41) })
await assert.rejects(
  desfazerPagamentoApresentadora(pg, { ...base, apresentadoraId: multi, chaveOperacao: id(42), hoje: '2026-10-06' }),
  (error) => error.code === 'APRESENTADORA_ESTORNO_GRANULAR_NECESSARIO' && error.statusCode === 409,
)

const txAsaas = id(70)
const refAsaas = `apresentadora:${apresentadora}:${mes}:variavel`
const conciliarAsaas = {
  tenantId: tenant, tipo: 'apresentadora', alvoId: refAsaas, userId: ator,
  transacao: { id: txAsaas, valor: '12.00', data: '2026-10-05' },
}
await pg.query('BEGIN')
assert.equal((await darBaixaConciliacao(pg, conciliarAsaas)).aplicada, true)
await pg.query('ROLLBACK')
assert.equal((await pg.query(`SELECT count(*)::int AS n FROM financeiro_liquidacoes
  WHERE idempotencia_chave LIKE $1`, [`asaas:${txAsaas}:%`])).rows[0].n, 0)
await pg.query('BEGIN')
const baixaAsaas = await darBaixaConciliacao(pg, conciliarAsaas)
await pg.query('COMMIT')
assert.equal(baixaAsaas.aplicada, true)
assert.equal((await pg.query('SELECT valor_pago::text AS valor FROM apresentadora_pagamentos WHERE id = $1::uuid', [baixaAsaas.alvo_id])).rows[0].valor, '12.00')
await pg.query('BEGIN')
assert.equal((await desfazerBaixaConciliacao(pg, {
  tenantId: tenant, tipo: 'apresentadora', alvoId: baixaAsaas.alvo_id, transacaoId: txAsaas, userId: ator,
})).desfeita, true)
await pg.query('COMMIT')
assert.equal((await pg.query('SELECT valor_pago::text AS valor FROM apresentadora_pagamentos WHERE id = $1::uuid', [baixaAsaas.alvo_id])).rows[0].valor, '0.00')

await pg.exec(`SELECT set_config('app.tenant_id', '${outroTenant}', false)`)
await assert.rejects(
  registrarPagamentoApresentadora(pg, { ...base, valorPago: '30.01', chaveOperacao: id(50) }),
  (error) => error.code === '42501',
)

await pg.close()
console.log('PASS financeiro_liquidacoes_apresentadoras: parcial, replay, conflito, estorno, legado, multi-fato e RLS')
