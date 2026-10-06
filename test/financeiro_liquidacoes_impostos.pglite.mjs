import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

import { desfazerImposto, pagarImposto } from '../src/services/financeiro-agregador.js'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const [tenant, outroTenant, ator] = [1, 2, 3].map(id)
const pg = new PGlite()

await pg.exec(`
  CREATE TABLE tenants (
    id uuid PRIMARY KEY,
    aliquota_imposto_pct numeric NOT NULL DEFAULT 10,
    financeiro_data_corte date,
    financeiro_saldo_abertura numeric NOT NULL DEFAULT 0
  );
  CREATE TABLE custos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
    descricao text NOT NULL, valor numeric(15,2) NOT NULL, tipo text NOT NULL,
    grupo text NOT NULL, competencia date NOT NULL, data_vencimento date,
    valor_pago numeric(15,2), data_pagamento date, observacao text,
    cancelado_em timestamptz, cancelado_motivo text, cancelado_por uuid,
    atualizado_em timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX custos_imposto_competencia ON custos (tenant_id, competencia) WHERE tipo = 'imposto';
  CREATE TABLE receita_titulos (tenant_id uuid NOT NULL, data_pagamento date, valor_pago numeric(15,2));
  CREATE TABLE receitas_avulsas (tenant_id uuid NOT NULL, grupo text, data_pagamento date, valor_pago numeric(15,2));
  INSERT INTO tenants (id) VALUES ('${tenant}'), ('${outroTenant}');
  INSERT INTO receita_titulos VALUES ('${tenant}', '2026-08-10', 1000.00);
`)
await pg.exec(await readFile(new URL('../migrations/180_financeiro_liquidacoes_estornos.sql', import.meta.url), 'utf8'))
await pg.exec(`
  ALTER TABLE custos ENABLE ROW LEVEL SECURITY;
  ALTER TABLE custos FORCE ROW LEVEL SECURITY;
  CREATE POLICY custos_tenant_test ON custos
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  CREATE ROLE fin03_impostos;
  GRANT USAGE ON SCHEMA public TO fin03_impostos;
  GRANT SELECT, INSERT, UPDATE, DELETE ON custos TO fin03_impostos;
  GRANT SELECT, INSERT, UPDATE ON financeiro_liquidacoes TO fin03_impostos;
  GRANT SELECT, INSERT ON financeiro_estornos TO fin03_impostos;
  GRANT SELECT ON tenants, receita_titulos, receitas_avulsas TO fin03_impostos;
  SELECT set_config('app.tenant_id', '${tenant}', false);
  SET ROLE fin03_impostos;
`)

const base = {
  tenantId: tenant, mes: '2026-09', hoje: '2026-10-15',
  ator: { tipo: 'usuario', id: ator },
}

const parcial = await pagarImposto(pg, { ...base, valorPago: '30.00', dataPagamento: '2026-09-19', chaveOperacao: id(10) })
assert.equal(parcial.valor_pago, 30)
assert.equal((await pagarImposto(pg, { ...base, valorPago: '30.0', dataPagamento: '2026-09-19', chaveOperacao: id(10) })).valor_pago, 30)
assert.equal((await pg.query(`SELECT count(*)::int AS n FROM financeiro_liquidacoes WHERE tenant_id = $1::uuid`, [tenant])).rows[0].n, 1)

await assert.rejects(
  pagarImposto(pg, { ...base, valorPago: '31.00', dataPagamento: '2026-09-19', chaveOperacao: id(10) }),
  (error) => error.code === 'FINANCEIRO_IDEMPOTENCIA_CONFLITO' && error.statusCode === 409,
)

const pagoParaEstorno = await pagarImposto(pg, { ...base, mes: '2026-06', valorPago: '30.00', chaveOperacao: id(12) })
assert.equal(pagoParaEstorno.valor_pago, 30)
const estornado = await desfazerImposto(pg, { ...base, mes: '2026-06', chaveOperacao: id(13) })
assert.equal(estornado.valor_pago, 0)
assert.equal((await desfazerImposto(pg, { ...base, mes: '2026-06', chaveOperacao: id(13) })).valor_pago, 0)
assert.equal((await pg.query(`SELECT count(*)::int AS n FROM financeiro_estornos WHERE tenant_id = $1::uuid`, [tenant])).rows[0].n, 1)

const integral = await pagarImposto(pg, { ...base, valorPago: '100.00', dataPagamento: '2026-09-20', chaveOperacao: id(11) })
assert.equal(integral.valor_pago, 100)
assert.equal((await pg.query(`SELECT count(*)::int AS n FROM financeiro_liquidacoes WHERE tenant_id = $1::uuid`, [tenant])).rows[0].n, 3)

await assert.rejects(
  desfazerImposto(pg, { ...base, chaveOperacao: id(20) }),
  (error) => error.code === 'IMPOSTO_ESTORNO_GRANULAR_NECESSARIO' && error.statusCode === 409,
)

await pg.exec(`
  INSERT INTO custos (tenant_id, descricao, valor, tipo, grupo, competencia, data_vencimento, valor_pago, data_pagamento)
  VALUES ('${tenant}', 'Imposto legado', 100, 'imposto', 'outros', '2026-10-01', '2026-10-20', 10, '2026-10-20');
`)
await assert.rejects(
  pagarImposto(pg, { ...base, mes: '2026-10', valorPago: '20.00', chaveOperacao: id(30) }),
  (error) => error.code === 'IMPOSTO_LIQUIDACAO_DIVERGENTE' && error.statusCode === 409,
)
await assert.rejects(
  desfazerImposto(pg, { ...base, mes: '2026-10', chaveOperacao: id(31) }),
  (error) => error.code === 'IMPOSTO_LIQUIDACAO_DIVERGENTE' && error.statusCode === 409,
)

// A projeção falha sob uma restrição real: o fato inserido pelo comando deve
// ser desfeito junto, sem deixar baixa canônica parcial.
await pg.exec(`
  RESET ROLE;
  ALTER TABLE custos ADD CONSTRAINT imposto_rollback_test
    CHECK (competencia <> DATE '2026-07-01' OR COALESCE(valor_pago, 0) <= 20);
  SET ROLE fin03_impostos;
`)
await assert.rejects(
  pagarImposto(pg, { ...base, mes: '2026-07', valorPago: '30.00', chaveOperacao: id(35) }),
  /imposto_rollback_test/,
)
assert.equal((await pg.query(`SELECT count(*)::int AS n FROM financeiro_liquidacoes WHERE idempotencia_chave = $1`, [id(35)])).rows[0].n, 0)

await pg.exec(`SELECT set_config('app.tenant_id', '${outroTenant}', false)`)
assert.equal((await pg.query(`SELECT count(*)::int AS n FROM financeiro_liquidacoes WHERE tenant_id = $1::uuid`, [tenant])).rows[0].n, 0)
await assert.rejects(
  pagarImposto(pg, { ...base, chaveOperacao: id(40) }),
  (error) => error.code === 'IMPOSTO_NAO_ENCONTRADO' || error.code === 'IMPOSTO_LIQUIDACAO_DIVERGENTE' || error.code === '42501',
)

await pg.close()
console.log('PASS FIN-03A imposto: parcial, replay, conflito, estorno granular, legado, rollback e tenant')
