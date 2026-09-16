import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { calculateBillingAmount } from '../src/jobs/billing_engine.js'

const db = new PGlite()
const tenant = '00000000-0000-4000-8000-000000000001'
const client = '00000000-0000-4000-8000-000000000002'
const additive = '00000000-0000-4000-8000-000000000003'
const ou = '00000000-0000-4000-8000-000000000004'
const partial = '00000000-0000-4000-8000-000000000005'
const legacy = '00000000-0000-4000-8000-000000000006'

const billingSelection = `
  SELECT m.cliente_id, va.origem_id AS id, va.marca_id,
         CASE WHEN mc.condicao_comissao_autoritativa IS TRUE
              THEN va.gmv * COALESCE(mc.comissao_franquia_pct_efetiva, 0) / 100.0
              ELSE va.comissao_franquia END AS comissao,
         COALESCE(mc.tipo_cobranca_autoritativo, 'fixo_mais_comissao') AS tipo_cobranca
    FROM vendas_atribuidas va
    JOIN video_registros vr ON vr.tenant_id = va.tenant_id AND vr.id = va.origem_id
    JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
    LEFT JOIN LATERAL (
      SELECT (c.origem <> 'legado_nao_verificado' AND c.comissao_confirmada IS TRUE) AS condicao_comissao_autoritativa,
             CASE WHEN c.origem <> 'legado_nao_verificado' AND c.comissao_confirmada IS TRUE
                  THEN c.comissao_franquia_pct END AS comissao_franquia_pct_efetiva,
             CASE WHEN c.origem <> 'legado_nao_verificado'
                        AND c.comissao_confirmada IS TRUE AND c.fixo_confirmado IS TRUE
                  THEN c.tipo_cobranca END AS tipo_cobranca_autoritativo
        FROM marca_condicoes_comerciais c
       WHERE c.tenant_id = va.tenant_id AND c.marca_id = va.marca_id
         AND c.inicio_vigencia <= va.data AND c.cancelled_at IS NULL
       ORDER BY c.inicio_vigencia DESC LIMIT 1
    ) mc ON true
   WHERE va.tenant_id = $1 AND va.origem = 'video'
     AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') IN ('aprovada', 'fechada')
     AND (($4::int = 16 AND COALESCE(mc.tipo_cobranca_autoritativo, 'fixo_mais_comissao') <> 'fixo_ou_comissao')
          OR ($4::int = 1 AND (COALESCE(mc.tipo_cobranca_autoritativo, 'fixo_mais_comissao') = 'fixo_ou_comissao'
                               OR va.data >= ($2::date + 15))))
     AND va.data >= ($2::date - CASE WHEN $4::int = 1
                                          AND COALESCE(mc.tipo_cobranca_autoritativo, 'fixo_mais_comissao') = 'fixo_ou_comissao'
                                     THEN 15 ELSE 0 END)
     AND va.data <= $3::date
   ORDER BY va.origem_id, va.id
   FOR UPDATE OF va
`
const liveSelection = `
  SELECT l.cliente_id, l.id, l.marca_id,
         CASE WHEN mc.condicao_comissao_autoritativa IS TRUE
              THEN COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)
                   * COALESCE(mc.comissao_franquia_pct_efetiva, 0) / 100.0
              ELSE COALESCE(l.comissao_calculada, 0) END AS comissao,
         COALESCE(mc.tipo_cobranca_autoritativo, 'fixo_mais_comissao') AS tipo_cobranca
    FROM lives l
    JOIN marcas m ON m.id = l.marca_id AND m.tenant_id = l.tenant_id
    LEFT JOIN LATERAL (
      SELECT (c.origem <> 'legado_nao_verificado' AND c.comissao_confirmada IS TRUE) AS condicao_comissao_autoritativa,
             CASE WHEN c.origem <> 'legado_nao_verificado' AND c.comissao_confirmada IS TRUE
                  THEN c.comissao_franquia_pct END AS comissao_franquia_pct_efetiva,
             CASE WHEN c.origem <> 'legado_nao_verificado'
                        AND c.comissao_confirmada IS TRUE AND c.fixo_confirmado IS TRUE
                  THEN c.tipo_cobranca END AS tipo_cobranca_autoritativo
        FROM marca_condicoes_comerciais c
       WHERE c.tenant_id = l.tenant_id AND c.marca_id = l.marca_id
         AND c.inicio_vigencia <= (l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date
         AND c.cancelled_at IS NULL
       ORDER BY c.inicio_vigencia DESC LIMIT 1
    ) mc ON true
   WHERE l.tenant_id = $1 AND l.status = 'encerrada' AND l.faturado_em IS NULL
     AND (($4::int = 16 AND COALESCE(mc.tipo_cobranca_autoritativo, 'fixo_mais_comissao') <> 'fixo_ou_comissao')
          OR ($4::int = 1 AND (COALESCE(mc.tipo_cobranca_autoritativo, 'fixo_mais_comissao') = 'fixo_ou_comissao'
                               OR (l.encerrado_em AT TIME ZONE 'America/Sao_Paulo')::date >= ($2::date + 15))))
     AND (l.encerrado_em AT TIME ZONE 'America/Sao_Paulo')::date >=
         ($2::date - CASE WHEN $4::int = 1
                               AND COALESCE(mc.tipo_cobranca_autoritativo, 'fixo_mais_comissao') = 'fixo_ou_comissao'
                          THEN 15 ELSE 0 END)
     AND (l.encerrado_em AT TIME ZONE 'America/Sao_Paulo')::date <= $3::date
   ORDER BY l.id
   FOR UPDATE OF l
`

try {
  await db.exec(`
    CREATE TABLE marcas (id uuid PRIMARY KEY, tenant_id uuid, cliente_id uuid, tipo_cobranca text);
    CREATE TABLE lives (
      id uuid PRIMARY KEY, tenant_id uuid, cliente_id uuid, marca_id uuid, status text,
      iniciado_em timestamptz, encerrado_em timestamptz, fat_gerado numeric,
      ads_gmv numeric, manual_gmv numeric, comissao_calculada numeric, faturado_em timestamptz
    );
    CREATE TABLE video_registros (id uuid PRIMARY KEY, tenant_id uuid, marca_id uuid, data date, gmv_atribuido numeric);
    CREATE TABLE vendas_atribuidas (
      id uuid PRIMARY KEY, tenant_id uuid, origem text, origem_id uuid, marca_id uuid,
      data date, gmv numeric, comissao_franquia numeric, status_aprovacao text
    );
    CREATE TABLE marca_condicoes_comerciais (
      id uuid PRIMARY KEY, tenant_id uuid, marca_id uuid, inicio_vigencia date,
      fixo_mensal numeric, comissao_franquia_pct numeric, tipo_cobranca text,
      origem text, fixo_confirmado boolean DEFAULT false, comissao_confirmada boolean DEFAULT false,
      cancelled_at timestamptz
    );
    INSERT INTO marcas VALUES
      ('${additive}', '${tenant}', '${client}', 'fixo_mais_comissao'),
      ('${ou}', '${tenant}', '${client}', 'fixo_ou_comissao'),
      ('${partial}', '${tenant}', '${client}', 'fixo_ou_comissao'),
      ('${legacy}', '${tenant}', '${client}', 'fixo_ou_comissao');
    INSERT INTO marca_condicoes_comerciais VALUES
      ('00000000-0000-4000-8000-000000000011', '${tenant}', '${additive}', '2026-08-01', 1000, 10, 'fixo_mais_comissao', 'confirmada', true, true, NULL),
      ('00000000-0000-4000-8000-000000000012', '${tenant}', '${additive}', '2026-09-01', 1200, 10, 'fixo_mais_comissao', 'confirmada', true, true, NULL),
      ('00000000-0000-4000-8000-000000000021', '${tenant}', '${ou}', '2026-08-01', 1000, 10, 'fixo_ou_comissao', 'confirmada', true, true, NULL),
      ('00000000-0000-4000-8000-000000000031', '${tenant}', '${partial}', '2026-08-01', 900, 99, 'fixo_ou_comissao', 'confirmada', true, false, NULL),
      ('00000000-0000-4000-8000-000000000041', '${tenant}', '${legacy}', '2026-08-01', 900, 99, 'fixo_ou_comissao', 'legado_nao_verificado', true, true, NULL);
    INSERT INTO video_registros VALUES
      ('00000000-0000-4000-8000-000000000101', '${tenant}', '${additive}', '2026-08-10', 4000),
      ('00000000-0000-4000-8000-000000000104', '${tenant}', '${additive}', '2026-08-20', 2000),
      ('00000000-0000-4000-8000-000000000102', '${tenant}', '${additive}', '2026-09-10', 2000),
      ('00000000-0000-4000-8000-000000000103', '${tenant}', '${ou}', '2026-08-10', 6000),
      ('00000000-0000-4000-8000-000000000105', '${tenant}', '${partial}', '2026-08-10', 10000),
      ('00000000-0000-4000-8000-000000000106', '${tenant}', '${legacy}', '2026-08-10', 10000);
    INSERT INTO vendas_atribuidas VALUES
      ('00000000-0000-4000-8000-000000000201', '${tenant}', 'video', '00000000-0000-4000-8000-000000000101', '${additive}', '2026-08-10', 4000, 0, 'aprovada'),
      ('00000000-0000-4000-8000-000000000204', '${tenant}', 'video', '00000000-0000-4000-8000-000000000104', '${additive}', '2026-08-20', 2000, 0, 'aprovada'),
      ('00000000-0000-4000-8000-000000000202', '${tenant}', 'video', '00000000-0000-4000-8000-000000000102', '${additive}', '2026-09-10', 2000, 0, 'aprovada'),
      ('00000000-0000-4000-8000-000000000203', '${tenant}', 'video', '00000000-0000-4000-8000-000000000103', '${ou}', '2026-08-10', 6000, 0, 'aprovada'),
      ('00000000-0000-4000-8000-000000000205', '${tenant}', 'video', '00000000-0000-4000-8000-000000000105', '${partial}', '2026-08-10', 10000, 77, 'aprovada'),
      ('00000000-0000-4000-8000-000000000206', '${tenant}', 'video', '00000000-0000-4000-8000-000000000106', '${legacy}', '2026-08-10', 10000, 88, 'aprovada');
    INSERT INTO lives VALUES
      ('00000000-0000-4000-8000-000000000301', '${tenant}', '${client}', '${additive}', 'encerrada', '2026-08-10T10:00:00Z', '2026-08-10T11:00:00Z', 6000, NULL, NULL, 0, NULL),
      ('00000000-0000-4000-8000-000000000302', '${tenant}', '${client}', '${ou}', 'encerrada', '2026-08-10T12:00:00Z', '2026-08-10T13:00:00Z', 6000, NULL, NULL, 0, NULL);
  `)

  async function select(day, start, end) {
    await db.exec('BEGIN')
    const lives = await db.query(liveSelection, [tenant, `${start}T00:00:00Z`, `${end}T23:59:59Z`, day])
    const videos = await db.query(billingSelection, [tenant, `${start}T00:00:00Z`, `${end}T23:59:59Z`, day])
    await db.exec('ROLLBACK')
    return [...lives.rows, ...videos.rows]
  }

  // On day 16 the OU brand is deferred; its complete monthly variable amount
  // is evaluated with the fixed amount on day 1.
  const firstHalf = await select(16, '2026-08-01', '2026-08-15')
  assert.equal(firstHalf.length, 4)
  assert.deepEqual(firstHalf.map((row) => Number(row.comissao)).sort((a, b) => a - b), [77, 88, 400, 600])
  assert.equal(firstHalf.find((row) => row.marca_id === partial).tipo_cobranca, 'fixo_mais_comissao')
  assert.equal(firstHalf.find((row) => row.marca_id === legacy).comissao, '88')
  await db.query(`UPDATE lives SET faturado_em = NOW() WHERE id = '00000000-0000-4000-8000-000000000301'`)

  const month = await select(1, '2026-08-01', '2026-08-31')
  assert.equal(month.length, 3)
  const byBrand = month.reduce((map, row) => {
    const key = row.marca_id
    map[key] ??= { totalFixo: 0, totalComissao: 0, tipoCobranca: row.tipo_cobranca }
    map[key].totalComissao += Number(row.comissao)
    return map
  }, {})
  byBrand[additive].totalFixo = 1000
  byBrand[ou].totalFixo = 1000
  assert.equal(calculateBillingAmount([byBrand[additive]]), 1200)
  assert.equal(calculateBillingAmount([byBrand[ou]]), 1200)

  const september = await select(16, '2026-09-01', '2026-09-15')
  const sep = { totalFixo: 1200, totalComissao: Number(september[0].comissao), tipoCobranca: 'fixo_mais_comissao' }
  assert.equal(calculateBillingAmount([sep]), 1400)
  console.log(JSON.stringify({ passed: true, checks: ['competência temporal de vídeo', 'OU adiado para fechamento mensal', 'fixo mais comissão agosto/setembro'] }))
} finally {
  await db.close()
}
