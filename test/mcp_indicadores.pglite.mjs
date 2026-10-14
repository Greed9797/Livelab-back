import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { MCP_FACTS_SQL, aggregateFacts } from '../src/services/mcp-indicadores.js'
import Fastify from 'fastify'
import { financeiroRoutes } from '../src/routes/financeiro.js'
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')
const parser = await import(process.env.PG_QUERY_MODULE || 'libpg-query')
const db = new PGlite()
const t = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222'
const a = '33333333-3333-4333-8333-333333333333', b = '44444444-4444-4444-8444-444444444444'
const u = '55555555-5555-4555-8555-555555555555', m = '66666666-6666-4666-8666-666666666666', c = '77777777-7777-4777-8777-777777777777'
const l = '88888888-8888-4888-8888-888888888888', v = '99999999-9999-4999-8999-999999999999'
await db.exec(`
  SET TIME ZONE 'UTC';
  CREATE TABLE tenants (id uuid PRIMARY KEY);
  CREATE TABLE users (id uuid PRIMARY KEY);
  CREATE TABLE marcas (id uuid, tenant_id uuid, nome text);
  CREATE TABLE cabines (id uuid, tenant_id uuid, numero integer);
  CREATE TABLE apresentadoras (id uuid, user_id uuid, tenant_id uuid, nome text);
  CREATE TABLE agenda_eventos (id uuid, tenant_id uuid, apresentadora_id uuid);
  CREATE TABLE agenda_evento_apresentadoras (agenda_evento_id uuid, tenant_id uuid, apresentadora_id uuid, data_inicio timestamptz, data_fim timestamptz);
  CREATE TABLE live_apresentadores (live_id uuid, tenant_id uuid, apresentador_id uuid);
  CREATE TABLE live_apresentadoras_v2 (live_id uuid, tenant_id uuid, apresentadora_id uuid, gmv_rateado numeric, segundos_rateio integer, percentual_rateio numeric, papel text);
  CREATE TABLE lives (id uuid, tenant_id uuid, marca_id uuid, cabine_id uuid, apresentador_id uuid, agenda_evento_id uuid,
    iniciado_em timestamptz, encerrado_em timestamptz, previsto_fim timestamptz, status text,
    ads_gmv numeric, manual_gmv numeric, fat_gerado numeric, manual_orders integer, final_orders_count integer);
  CREATE TABLE vendas_atribuidas (origem_id uuid, tenant_id uuid, apresentadora_id uuid, marca_id uuid, origem text,
    data date, gmv numeric, pedidos integer, status_aprovacao text);
  ALTER TABLE lives ADD uniao_destino_id uuid, ADD uniao_desfeita_em timestamptz, ADD arquivada_em timestamptz;
  INSERT INTO tenants VALUES ('${t}'), ('${other}'); INSERT INTO users VALUES ('${u}');
  INSERT INTO marcas VALUES ('${m}', '${t}', 'Marca'); INSERT INTO cabines VALUES ('${c}', '${t}', 1);
  INSERT INTO apresentadoras VALUES ('${a}', '${u}', '${t}', 'Ana'), ('${b}', NULL, '${t}', 'Bia');
  INSERT INTO lives VALUES ('${l}', '${t}', '${m}', '${c}', '${u}', NULL,
    '2026-10-01 03:00Z', '2026-10-01 07:00Z', NULL, 'encerrada', 100, 900, 900, 2, 99);
  INSERT INTO live_apresentadoras_v2 VALUES ('${l}', '${t}', '${a}', 100, 10800, 100, 'principal'), ('${l}', '${t}', '${b}', 0, 3600, 0, 'apoio');
  INSERT INTO vendas_atribuidas VALUES ('${v}', '${t}', '${b}', '${m}', 'video', '2026-10-02', 50, 1, 'aprovada');
  INSERT INTO vendas_atribuidas VALUES ('${v}', '${other}', '${b}', '${m}', 'video', '2026-10-02', 50000, 50, 'aprovada');
  INSERT INTO vendas_atribuidas VALUES ('${v}', '${t}', '${b}', '${m}', 'video', '2026-10-02', 700, 50, 'reprovada');
`)
const params = [t, '2026-10-01', '2026-10-02', null, null, null, 'encerrada', 'ambos', null]
const parsed = await parser.parse(MCP_FACTS_SQL)
assert.ok(parsed)
let { rows } = await db.query(MCP_FACTS_SQL, params)
assert.equal(rows.length, 2)
assert.deepEqual(Object.fromEntries(Object.entries(aggregateFacts(rows)).filter(([k]) => ['gmv_total', 'gmv_lives', 'gmv_videos', 'horas_transmissao', 'pedidos', 'total_lives'].includes(k))),
  { gmv_total: 150, gmv_lives: 100, gmv_videos: 50, pedidos: 3, total_lives: 1, horas_transmissao: 4 })
assert.equal(aggregateFacts(rows, 'apresentadora').find(r => r.id === b).horas_presenca, 1)
assert.equal(aggregateFacts(rows, 'apresentadora').find(r => r.id === b).gmv_lives, 0)
const filtered = await db.query(MCP_FACTS_SQL, params.map((p, i) => i === 5 ? b : p))
assert.equal(aggregateFacts(filtered.rows, null, b).gmv_total, 50)
assert.equal(aggregateFacts(filtered.rows, null, b).horas_presenca, 1)
// Co-apresentação: os turnos sobrepostos dão 4h a cada pessoa, e só 4h à unidade.
await db.exec(`
  INSERT INTO agenda_eventos VALUES ('${v}', '${t}', '${a}'); UPDATE lives SET agenda_evento_id='${v}';
  INSERT INTO agenda_evento_apresentadoras VALUES
    ('${v}', '${t}', '${a}', '2026-10-01 03:00Z', '2026-10-01 07:00Z'),
    ('${v}', '${t}', '${b}', '2026-10-01 03:00Z', '2026-10-01 07:00Z');
  UPDATE live_apresentadoras_v2 SET gmv_rateado=NULL, segundos_rateio=NULL, percentual_rateio=50;
`)
rows = (await db.query(MCP_FACTS_SQL, params)).rows
assert.equal(aggregateFacts(rows).horas_transmissao, 4)
assert.equal(aggregateFacts(rows, 'apresentadora').find(r => r.id === b).horas_presenca, 4)
assert.equal(aggregateFacts(rows, 'apresentadora').find(r => r.id === b).horas_produtividade, 2)
await db.exec(`UPDATE live_apresentadoras_v2 SET
  gmv_rateado=CASE WHEN apresentadora_id='${a}' THEN 100 ELSE 0 END,
  segundos_rateio=CASE WHEN apresentadora_id='${a}' THEN 10800 ELSE 3600 END,
  percentual_rateio=CASE WHEN apresentadora_id='${a}' THEN 100 ELSE 0 END;`)
// Horas inválidas não recebem as 24h que LEAST(NULL,24) inventaria.
await db.exec(`UPDATE lives SET encerrado_em = NULL; UPDATE live_apresentadoras_v2 SET segundos_rateio = NULL;`)
rows = (await db.query(MCP_FACTS_SQL, params)).rows
assert.equal(aggregateFacts(rows).horas_transmissao, 0)
assert.equal(aggregateFacts(rows, 'apresentadora').find(r => r.id === b).horas_presenca, 0)
// Rateio financeiro zero sem tempo medido conserva presença estimada inteira, não falta.
await db.exec(`UPDATE lives SET encerrado_em = '2026-10-01 07:00Z';`)
rows = (await db.query(MCP_FACTS_SQL, params)).rows
assert.equal(aggregateFacts(rows, 'apresentadora').find(r => r.id === b).horas_presenca, 4)
assert.equal(aggregateFacts(rows, 'apresentadora').find(r => r.id === b).presenca_estimada, true)
await db.exec('UPDATE lives SET ads_gmv=NULL, manual_gmv=NULL, fat_gerado=NULL;')
rows = (await db.query(MCP_FACTS_SQL, params)).rows
assert.equal(aggregateFacts(rows).gmv_total, null)
assert.equal(aggregateFacts(rows).gmv_conhecido, 50)
await db.exec('UPDATE lives SET ads_gmv=100;')
// Última noite local inclusiva e exclusão do dia anterior; atravessar meia-noite não troca a competência.
await db.exec(`UPDATE lives SET iniciado_em = '2026-10-03 02:30Z', encerrado_em = '2026-10-03 04:30Z';`)
rows = (await db.query(MCP_FACTS_SQL, params)).rows
assert.equal(rows.find(r => r.origem === 'live').dia, '2026-10-02')
await db.exec(`UPDATE lives SET iniciado_em = '2026-10-01 02:59:59Z';`)
rows = (await db.query(MCP_FACTS_SQL, params)).rows
assert.equal(rows.filter(r => r.origem === 'live').length, 0)
const migration = await readFile(new URL('../migrations/185_mcp_oauth.sql', import.meta.url), 'utf8')
await parser.parse(migration)
await db.exec(migration)
await db.exec(migration) // idempotente
// Executa as fontes financeiras reutilizadas pelo MCP, sem mocks de SQL.
await db.exec(`
  ALTER TABLE marcas ADD tipo text DEFAULT 'cliente', ADD valor_fixo_minimo numeric DEFAULT 300,
    ADD tipo_cobranca text DEFAULT 'fixo_mais_comissao', ADD data_inicio date, ADD data_fim date;
  ALTER TABLE apresentadoras ADD ativo boolean DEFAULT true, ADD arquivada boolean DEFAULT false,
    ADD fixo numeric DEFAULT 500, ADD data_inicio date, ADD data_fim date;
  ALTER TABLE vendas_atribuidas ADD comissao_franquia numeric DEFAULT 0, ADD comissao_apresentadora numeric DEFAULT 0;
  ALTER TABLE marcas ADD sistema boolean DEFAULT false, ADD status text DEFAULT 'ativa', ADD criado_em timestamptz DEFAULT '2026-10-01 03:00Z';
  CREATE TABLE marca_condicoes_comerciais (id uuid, tenant_id uuid, marca_id uuid, inicio_vigencia date, fixo_mensal numeric, tipo_cobranca text, comissao_franquia_pct numeric, revision integer, cancelled_at timestamptz, fixo_vencimento_dia integer, fixo_vencimento_mes_offset integer, comissao_vencimento_dia integer, comissao_vencimento_mes_offset integer, comissao_janela_inicio_dia integer);
  CREATE TABLE apresentadora_fixo_historico (id uuid, tenant_id uuid, apresentadora_id uuid, valor numeric, vigencia_inicio date);
  CREATE TABLE video_registros (marca_id uuid, tenant_id uuid, data date, gmv_atribuido numeric, pedidos_atribuidos integer);
  CREATE TABLE custos (id uuid, tenant_id uuid, descricao text, tipo text, competencia date, valor numeric);
  ALTER TABLE custos ADD grupo text, ADD data_vencimento date, ADD valor_pago numeric, ADD data_pagamento date, ADD parcela_grupo_id uuid, ADD parcela_num integer, ADD parcelas_total integer, ADD recorrente_id uuid, ADD observacao text, ADD classe_custo text, ADD cancelado_em timestamptz, ADD cancelado_motivo text, ADD cancelado_por uuid, ADD criado_em timestamptz;
  CREATE TABLE custos_recorrentes (id uuid, tenant_id uuid, nome text, descricao text, grupo text, valor numeric, dia_vencimento integer, mes_offset integer, inicio date, fim date, ativo boolean, classe_custo text);
  CREATE TABLE apresentadora_remuneracao_adicionais (id uuid, tenant_id uuid, apresentadora_id uuid,
    tipo text, descricao text, data_referencia date, competencia date, valor numeric, cancelado_em timestamptz, criado_em timestamptz);
  UPDATE lives SET iniciado_em='2026-10-01 03:00Z', encerrado_em='2026-10-01 07:00Z';
  INSERT INTO vendas_atribuidas (origem_id, tenant_id, apresentadora_id, marca_id, origem, data, gmv, pedidos, status_aprovacao, comissao_franquia, comissao_apresentadora)
    VALUES ('${l}', '${t}', '${a}', '${m}', 'live', '2026-10-01', 100, 2, 'aprovada', 250, 100);
  INSERT INTO custos (id, tenant_id, descricao, tipo, competencia, valor) VALUES ('${v}', '${t}', 'Material', 'outros', '2026-10-01', 50);
  INSERT INTO apresentadora_remuneracao_adicionais VALUES ('${v}', '${t}', '${b}', 'bonificacao', 'Extra', '2026-10-01', '2026-10-01', 30, NULL, NOW());
  SELECT set_config('app.tenant_id', '${t}', false);
`)
const app = Fastify()
app.decorate('requirePapel', () => async request => { request.user = { tenant_id: t, papel: 'franqueado' } })
app.decorate('withTenant', async (tenant, fn) => { assert.equal(tenant, t); return fn({ query: async (sql, params) => { await parser.parse(sql); return db.query(sql, params) } }) })
await app.register(financeiroRoutes)
const operational = async () => {
  const response = await app.inject('/v1/financeiro/operacional?inicio=2026-10&fim=2026-10')
  assert.equal(response.statusCode, 200, response.body)
  return response.json()
}
let financial = await operational()
assert.equal(financial.totais.entradas, 550)
assert.equal(financial.totais.resultado, -630)
await db.exec(`UPDATE marcas SET tipo_cobranca='fixo_ou_comissao';`)
financial = await operational()
assert.equal(financial.totais.entradas, 300)
assert.equal(financial.totais.resultado, -880)
assert.equal(financial.entradas.length, 1)
await db.exec(`UPDATE vendas_atribuidas SET comissao_franquia=500 WHERE origem='live';`)
financial = await operational()
assert.equal(financial.totais.entradas, 500)
assert.equal(financial.totais.resultado, -680)
assert.equal(financial.entradas[0].memoria.fixo_comparado, 300)
await app.close()
await db.close()
console.log('MCP SQL: parser + PGlite; GMV/rateio/zero/NULL/fuso/tenant/migration, contratos financeiros, custos, adicionais e prejuízo verificados')
