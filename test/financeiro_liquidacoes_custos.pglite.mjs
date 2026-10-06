import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

import { desfazerBaixaCusto, idVirtual, pagarCusto } from '../src/services/custos-plano.js'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const [tenant, outroTenant, custo, legado, cancelado, multi, ator, recorrente] = [1, 2, 3, 4, 5, 6, 7, 8].map(id)
const pg = new PGlite()

await pg.exec(`
  CREATE TABLE tenants (id uuid PRIMARY KEY);
  CREATE TABLE custos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
    descricao text NOT NULL, valor numeric(15,2) NOT NULL, tipo text NOT NULL DEFAULT 'outros',
    grupo text NOT NULL DEFAULT 'diversos', competencia date NOT NULL, data_vencimento date,
    valor_pago numeric(15,2), data_pagamento date, observacao text,
    parcela_grupo_id uuid, parcela_num integer, parcelas_total integer, recorrente_id uuid,
    classe_custo text, cancelado_em timestamptz, cancelado_motivo text, cancelado_por uuid,
    atualizado_em timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX custos_recorrente_competencia_test ON custos (recorrente_id, competencia);
  CREATE TABLE custos_recorrentes (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
    nome text NOT NULL, descricao text, grupo text NOT NULL, valor numeric(15,2) NOT NULL,
    dia_vencimento integer NOT NULL, mes_offset integer NOT NULL DEFAULT 0,
    inicio date NOT NULL, fim date, ativo boolean NOT NULL DEFAULT true, classe_custo text
  );
  INSERT INTO tenants VALUES ('${tenant}'), ('${outroTenant}');
  INSERT INTO custos (id, tenant_id, descricao, valor, competencia, data_vencimento) VALUES
    ('${custo}', '${tenant}', 'Custo canônico', 100.00, '2026-10-01', '2026-10-05'),
    ('${legado}', '${tenant}', 'Custo legado', 100.00, '2026-10-01', '2026-10-05'),
    ('${multi}', '${tenant}', 'Custo multi-fato', 100.00, '2026-10-01', '2026-10-05');
  UPDATE custos SET valor_pago = 10.00, data_pagamento = '2026-10-05' WHERE id = '${legado}';
  INSERT INTO custos (id, tenant_id, descricao, valor, competencia, data_vencimento, cancelado_em) VALUES
    ('${cancelado}', '${tenant}', 'Custo cancelado', 100.00, '2026-10-01', '2026-10-05', now());
  INSERT INTO custos_recorrentes (id, tenant_id, nome, grupo, valor, dia_vencimento, inicio)
  VALUES ('${recorrente}', '${tenant}', 'Aluguel', 'estrutural', 3000.00, 30, '2026-01-01');
`)
await pg.exec(await readFile(new URL('../migrations/180_financeiro_liquidacoes_estornos.sql', import.meta.url), 'utf8'))
await pg.exec(`
  ALTER TABLE custos ENABLE ROW LEVEL SECURITY;
  ALTER TABLE custos FORCE ROW LEVEL SECURITY;
  CREATE POLICY custos_tenant_test ON custos
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  ALTER TABLE custos_recorrentes ENABLE ROW LEVEL SECURITY;
  ALTER TABLE custos_recorrentes FORCE ROW LEVEL SECURITY;
  CREATE POLICY recorrentes_tenant_test ON custos_recorrentes
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  CREATE ROLE fin03_custos;
  GRANT USAGE ON SCHEMA public TO fin03_custos;
  GRANT SELECT, INSERT, UPDATE ON custos TO fin03_custos;
  GRANT SELECT ON custos_recorrentes TO fin03_custos;
  GRANT SELECT, INSERT, UPDATE ON financeiro_liquidacoes TO fin03_custos;
  GRANT SELECT, INSERT, UPDATE ON financeiro_estornos TO fin03_custos;
  SELECT set_config('app.tenant_id', '${tenant}', false);
  SET ROLE fin03_custos;
`)

const base = {
  tenantId: tenant,
  id: custo,
  hoje: '2026-10-05',
  ator: { tipo: 'usuario', id: ator },
}

const parcial = await pagarCusto(pg, { ...base, valorPago: '30.01', chaveOperacao: id(10) })
assert.equal(parcial.valor_pago, 30.01)
assert.equal((await pagarCusto(pg, { ...base, valorPago: '30.01', chaveOperacao: id(10) })).valor_pago, 30.01)
assert.equal((await pg.query(`SELECT count(*)::int AS n FROM financeiro_liquidacoes WHERE origem_id = $1::uuid`, [custo])).rows[0].n, 1)

await assert.rejects(
  pagarCusto(pg, { ...base, valorPago: '31.01', chaveOperacao: id(10) }),
  (error) => error.code === 'FINANCEIRO_IDEMPOTENCIA_CONFLITO' && error.statusCode === 409,
)
await assert.rejects(
  pagarCusto(pg, { ...base, valorPago: '100.01', chaveOperacao: id(11) }),
  (error) => error.code === 'CUSTO_VALOR_EXCEDENTE' && error.statusCode === 409,
)
assert.equal((await pg.query(`SELECT valor_pago::text AS valor FROM custos WHERE id = $1::uuid`, [custo])).rows[0].valor, '30.01')

const estornado = await desfazerBaixaCusto(pg, { ...base, chaveOperacao: id(20) })
assert.equal(estornado.valor_pago, null)
assert.equal((await desfazerBaixaCusto(pg, { ...base, chaveOperacao: id(20) })).valor_pago, null)
assert.equal((await pg.query(`SELECT count(*)::int AS n FROM financeiro_estornos`)).rows[0].n, 1)

const integral = await pagarCusto(pg, { ...base, chaveOperacao: id(12) })
assert.equal(integral.valor_pago, 100)
await assert.rejects(
  pagarCusto(pg, { ...base, valorPago: '100.01', chaveOperacao: id(13) }),
  (error) => error.code === 'CUSTO_VALOR_EXCEDENTE' && error.statusCode === 409,
)

await pagarCusto(pg, { ...base, id: multi, valorPago: '30.00', chaveOperacao: id(14) })
await pagarCusto(pg, { ...base, id: multi, valorPago: '100.00', chaveOperacao: id(15) })
await assert.rejects(
  desfazerBaixaCusto(pg, { ...base, id: multi, chaveOperacao: id(21) }),
  (error) => error.code === 'CUSTO_ESTORNO_GRANULAR_NECESSARIO' && error.statusCode === 409,
)
assert.equal((await pg.query(`SELECT count(*)::int AS n FROM financeiro_estornos WHERE liquidacao_id IN (
  SELECT id FROM financeiro_liquidacoes WHERE origem_id = $1::uuid
)`, [multi])).rows[0].n, 0)

await assert.rejects(
  pagarCusto(pg, { ...base, id: legado, chaveOperacao: id(30) }),
  (error) => error.code === 'CUSTO_LIQUIDACAO_DIVERGENTE' && error.statusCode === 409,
)
await assert.rejects(
  desfazerBaixaCusto(pg, { ...base, id: legado, chaveOperacao: id(31) }),
  (error) => error.code === 'CUSTO_LIQUIDACAO_DIVERGENTE' && error.statusCode === 409,
)
await assert.rejects(
  pagarCusto(pg, { ...base, id: cancelado, chaveOperacao: id(40) }),
  (error) => error.code === 'CUSTO_CANCELADO' && error.statusCode === 409,
)
assert.equal((await pg.query(`SELECT count(*)::int AS n FROM financeiro_liquidacoes WHERE origem_id = $1::uuid`, [cancelado])).rows[0].n, 0)

const virtual = await pagarCusto(pg, {
  ...base, id: idVirtual(recorrente, '2026-10'), dataPagamento: '2026-10-05', chaveOperacao: id(41),
})
assert.equal(virtual.valor_pago, 3000)
assert.equal(virtual.virtual, false)
assert.equal((await pg.query(`SELECT count(*)::int AS n FROM custos WHERE recorrente_id = $1::uuid`, [recorrente])).rows[0].n, 1)
assert.equal((await pg.query(`SELECT count(*)::int AS n FROM financeiro_liquidacoes WHERE origem_id = $1::uuid`, [virtual.id])).rows[0].n, 1)

await pg.exec(`SELECT set_config('app.tenant_id', '${outroTenant}', false)`)
assert.equal((await pg.query(`SELECT count(*)::int AS n FROM financeiro_liquidacoes WHERE origem_id = $1::uuid`, [custo])).rows[0].n, 0)
await assert.rejects(
  pagarCusto(pg, { ...base, chaveOperacao: id(50) }),
  (error) => error.code === 'CUSTO_NAO_ENCONTRADO',
)

await pg.close()
console.log('PASS financeiro_liquidacoes_custos: parcial, replay, conflito, overshoot, RLS, estorno, legado, cancelado e virtual')
