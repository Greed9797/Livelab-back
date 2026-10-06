import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import Fastify from 'fastify'

import { desfazerBaixaCusto, idVirtual, pagarCusto } from '../src/services/custos-plano.js'
import { darBaixaConciliacao, desfazerBaixaConciliacao } from '../src/services/conciliacao.js'
import { asaasRoutes } from '../src/routes/asaas.js'

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

// A conciliação já possui BEGIN externo. O comando canônico usa savepoint e
// só persiste quando o vínculo externo também confirma a transação.
const custoAsaas = id(70)
const transacaoAsaas = id(71)
await pg.query(
  `INSERT INTO custos (id, tenant_id, descricao, valor, competencia, data_vencimento)
   VALUES ($1::uuid, $2::uuid, 'Custo Asaas', 42.00, '2026-10-01', '2026-10-05')`,
  [custoAsaas, tenant],
)
const conciliacao = {
  tenantId: tenant, tipo: 'custo', alvoId: custoAsaas,
  transacao: { id: transacaoAsaas, valor: '42.00', data: '2026-10-05' },
  userId: ator,
}
await pg.query('BEGIN')
assert.equal((await darBaixaConciliacao(pg, conciliacao)).aplicada, true)
assert.equal((await pg.query('SELECT count(*)::int AS n FROM financeiro_liquidacoes WHERE origem_id = $1::uuid', [custoAsaas])).rows[0].n, 1)
await pg.query('ROLLBACK')
assert.equal((await pg.query('SELECT count(*)::int AS n FROM financeiro_liquidacoes WHERE origem_id = $1::uuid', [custoAsaas])).rows[0].n, 0)
assert.equal((await pg.query('SELECT valor_pago::text AS valor FROM custos WHERE id = $1::uuid', [custoAsaas])).rows[0].valor, null)
await pg.query('BEGIN')
assert.equal((await darBaixaConciliacao(pg, conciliacao)).aplicada, true)
await pg.query('COMMIT')
assert.equal((await pg.query('SELECT valor_pago::text AS valor FROM custos WHERE id = $1::uuid', [custoAsaas])).rows[0].valor, '42.00')
await pg.query('BEGIN')
assert.equal((await desfazerBaixaConciliacao(pg, {
  tenantId: tenant, tipo: 'custo', alvoId: custoAsaas, transacaoId: transacaoAsaas, userId: ator,
})).desfeita, true)
await pg.query('ROLLBACK')
assert.equal((await pg.query('SELECT valor_pago::text AS valor FROM custos WHERE id = $1::uuid', [custoAsaas])).rows[0].valor, '42.00')
await pg.query('BEGIN')
assert.equal((await desfazerBaixaConciliacao(pg, {
  tenantId: tenant, tipo: 'custo', alvoId: custoAsaas, transacaoId: transacaoAsaas, userId: ator,
})).desfeita, true)
await pg.query('COMMIT')
assert.equal((await pg.query('SELECT valor_pago::text AS valor FROM custos WHERE id = $1::uuid', [custoAsaas])).rows[0].valor, null)
assert.equal((await pg.query(`SELECT count(*)::int AS n FROM financeiro_estornos WHERE liquidacao_id IN (
  SELECT id FROM financeiro_liquidacoes WHERE origem_id = $1::uuid
)`, [custoAsaas])).rows[0].n, 1)

// A rota real escreve vínculo + fato na mesma conexão. Uma falha do vínculo
// depois da baixa precisa devolver ambos ao estado anterior.
const custoRota = id(72)
const txRota = id(73)
const custoFalha = id(74)
const txFalha = id(75)
await pg.exec(`
  RESET ROLE;
  CREATE TABLE gateway_transacoes (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
    tipo text NOT NULL, valor numeric(15,2) NOT NULL, data date NOT NULL,
    conciliado_com_tipo text, conciliado_com_id uuid, conciliado_em timestamptz,
    conciliado_por uuid, conciliado_baixa boolean NOT NULL DEFAULT false,
    CONSTRAINT falha_vinculo_teste CHECK (id <> '${txFalha}'::uuid OR conciliado_com_id IS NULL)
  );
  ALTER TABLE gateway_transacoes ENABLE ROW LEVEL SECURITY;
  ALTER TABLE gateway_transacoes FORCE ROW LEVEL SECURITY;
  CREATE POLICY gateway_tenant_test ON gateway_transacoes
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  GRANT SELECT, UPDATE ON gateway_transacoes TO fin03_custos;
  INSERT INTO gateway_transacoes (id, tenant_id, tipo, valor, data) VALUES
    ('${txRota}', '${tenant}', 'saida', 19.00, '2026-10-05'),
    ('${txFalha}', '${tenant}', 'saida', 19.00, '2026-10-05');
  INSERT INTO custos (id, tenant_id, descricao, valor, competencia, data_vencimento) VALUES
    ('${custoRota}', '${tenant}', 'Rota Asaas', 19.00, '2026-10-01', '2026-10-05'),
    ('${custoFalha}', '${tenant}', 'Rota falha', 19.00, '2026-10-01', '2026-10-05');
  SET ROLE fin03_custos;
`)
const app = Fastify()
app.decorate('authenticate', async (request) => {
  request.user = { tenant_id: tenant, papel: 'franqueado', sub: ator }
})
app.decorate('requirePapel', () => async () => {})
app.decorate('withTenant', async (_tenantId, work) => work(pg))
await app.register(asaasRoutes)
const respostaRota = await app.inject({
  method: 'POST', url: '/v1/asaas/conciliar',
  payload: { transacao_id: txRota, tipo: 'custo', id: custoRota },
})
assert.equal(respostaRota.statusCode, 200, respostaRota.body)
assert.equal((await pg.query('SELECT count(*)::int AS n FROM financeiro_liquidacoes WHERE origem_id = $1::uuid', [custoRota])).rows[0].n, 1)
assert.equal((await pg.query('SELECT conciliado_com_id FROM gateway_transacoes WHERE id = $1::uuid', [txRota])).rows[0].conciliado_com_id, custoRota)
const desfazerRota = await app.inject({ method: 'DELETE', url: `/v1/asaas/conciliacao/${txRota}` })
assert.equal(desfazerRota.statusCode, 200, desfazerRota.body)
assert.equal((await pg.query('SELECT conciliado_com_id FROM gateway_transacoes WHERE id = $1::uuid', [txRota])).rows[0].conciliado_com_id, null)
assert.equal((await pg.query(`SELECT count(*)::int AS n FROM financeiro_estornos e
  JOIN financeiro_liquidacoes l ON l.id = e.liquidacao_id WHERE l.origem_id = $1::uuid`, [custoRota])).rows[0].n, 1)
const respostaFalha = await app.inject({
  method: 'POST', url: '/v1/asaas/conciliar',
  payload: { transacao_id: txFalha, tipo: 'custo', id: custoFalha },
})
assert.equal(respostaFalha.statusCode, 500)
assert.equal((await pg.query('SELECT valor_pago::text AS valor FROM custos WHERE id = $1::uuid', [custoFalha])).rows[0].valor, null)
assert.equal((await pg.query('SELECT count(*)::int AS n FROM financeiro_liquidacoes WHERE origem_id = $1::uuid', [custoFalha])).rows[0].n, 0)
assert.equal((await pg.query('SELECT conciliado_com_id FROM gateway_transacoes WHERE id = $1::uuid', [txFalha])).rows[0].conciliado_com_id, null)
await app.close()

await pg.exec(`SELECT set_config('app.tenant_id', '${outroTenant}', false)`)
assert.equal((await pg.query(`SELECT count(*)::int AS n FROM financeiro_liquidacoes WHERE origem_id = $1::uuid`, [custo])).rows[0].n, 0)
await assert.rejects(
  pagarCusto(pg, { ...base, chaveOperacao: id(50) }),
  (error) => error.code === 'CUSTO_NAO_ENCONTRADO',
)

await pg.close()
console.log('PASS financeiro_liquidacoes_custos: parcial, replay, conflito, overshoot, RLS, estorno, legado, cancelado e virtual')
