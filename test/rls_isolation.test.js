// Teste de INTEGRAÇÃO de isolamento RLS (L4-9).
//
// Este é o pré-requisito de confiança pra virar a chave da RLS em produção: hoje
// o role do Supabase tem BYPASSRLS, então as policies existem mas nunca são
// exercidas. Aqui criamos um role NOBYPASSRLS de verdade e provamos, contra um
// banco real com todas as migrations aplicadas, que o tenant A não enxerga nada
// do tenant B (e vice-versa) em lives, vendas_atribuidas e boletos.
//
// COMO RODAR
// ----------
// Precisa de um Postgres descartável — NUNCA aponte pra produção: o teste cria
// role, insere fixtures e limpa depois. Por isso NÃO usa DATABASE_URL: exige a
// variável dedicada RLS_TEST_DATABASE_URL, e é pulado (skip) quando ela falta.
// A credencial precisa ser superuser/CREATEROLE e dona das tabelas.
//
//   createdb livelab_rls_test
//   DATABASE_URL=postgresql://localhost:5432/livelab_rls_test \
//     ALLOW_FRESH_SCHEMA_SETUP=true node scripts/setup_fresh_schema.js
//   DATABASE_URL=postgresql://localhost:5432/livelab_rls_test node apply_migrations.js
//   RLS_TEST_DATABASE_URL=postgresql://localhost:5432/livelab_rls_test npx vitest run test/rls_isolation.test.js
//
// No CI a variável já é setada em .github/workflows/backend-ci.yml, então o teste
// roda a cada push. Localmente, `npx vitest run` sem a variável apenas o pula.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'

const ADMIN_URL = process.env.RLS_TEST_DATABASE_URL
const PROBE_ROLE = 'rls_probe_nobypass'
const PROBE_PASSWORD = 'rls_probe_pw'

// Sem banco descartável configurado o teste é pulado — explicitamente, não
// silenciosamente: o describe.skip aparece como "skipped" no relatório.
const suite = ADMIN_URL ? describe : describe.skip

function probeUrl() {
  const u = new URL(ADMIN_URL)
  u.username = PROBE_ROLE
  u.password = PROBE_PASSWORD
  // localhost via TCP: o role de teste não tem entrada de peer auth.
  if (!u.hostname) u.hostname = 'localhost'
  return u.toString()
}

suite('RLS: isolamento entre tenants com role NOBYPASSRLS', () => {
  /** @type {pg.Client} */ let admin
  /** @type {pg.Client} */ let probe
  const ids = {}

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL })
    await admin.connect()

    // 1. Role NOBYPASSRLS — o ponto do teste. O DONO das tabelas ignora RLS por
    // padrão, então as asserções só têm valor a partir de um role separado.
    await admin.query(`DROP OWNED BY ${PROBE_ROLE}`).catch(() => {})
    await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`).catch(() => {})
    await admin.query(
      `CREATE ROLE ${PROBE_ROLE} LOGIN NOBYPASSRLS PASSWORD '${PROBE_PASSWORD}'`,
    )
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`)
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PROBE_ROLE}`,
    )
    await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${PROBE_ROLE}`)

    // 2. Dois tenants com dados nas três tabelas sensíveis.
    for (const t of ['a', 'b']) {
      const tenant = await admin.query(
        `INSERT INTO tenants (nome) VALUES ($1) RETURNING id`,
        [`RLS Test ${t.toUpperCase()}`],
      )
      const tenantId = tenant.rows[0].id

      const user = await admin.query(
        `INSERT INTO users (tenant_id, nome, email, senha_hash, papel)
         VALUES ($1, 'RLS Probe', $2, 'x', 'franqueado') RETURNING id`,
        [tenantId, `rls-${t}-${Date.now()}@test.local`],
      )
      const cliente = await admin.query(
        `INSERT INTO clientes (tenant_id, nome, celular)
         VALUES ($1, 'Cliente RLS', '11999999999') RETURNING id`,
        [tenantId],
      )
      const cabine = await admin.query(
        `INSERT INTO cabines (tenant_id, numero) VALUES ($1, 901) RETURNING id`,
        [tenantId],
      )
      const marca = await admin.query(
        `INSERT INTO marcas (tenant_id, nome, tipo, cliente_id)
         VALUES ($1, $2, 'cliente', $3) RETURNING id`,
        [tenantId, `Marca RLS ${t.toUpperCase()}`, cliente.rows[0].id],
      )
      const live = await admin.query(
        `INSERT INTO lives (tenant_id, cabine_id, cliente_id, apresentador_id, marca_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [tenantId, cabine.rows[0].id, cliente.rows[0].id, user.rows[0].id, marca.rows[0].id],
      )
      const venda = await admin.query(
        `INSERT INTO vendas_atribuidas (tenant_id, origem, origem_id, marca_id, data, gmv)
         VALUES ($1, 'live', $2, $3, CURRENT_DATE, 1000) RETURNING id`,
        [tenantId, live.rows[0].id, marca.rows[0].id],
      )
      const boleto = await admin.query(
        `INSERT INTO boletos (tenant_id, cliente_id, tipo, valor, vencimento, competencia, idempotency_key)
         VALUES ($1, $2, 'royalties', 500, CURRENT_DATE, CURRENT_DATE, $3) RETURNING id`,
        [tenantId, cliente.rows[0].id, `rls-test-${t}-${Date.now()}`],
      )

      ids[t] = {
        tenantId,
        liveId: live.rows[0].id,
        vendaId: venda.rows[0].id,
        boletoId: boleto.rows[0].id,
        marcaId: marca.rows[0].id,
      }
    }

    probe = new pg.Client({ connectionString: probeUrl() })
    await probe.connect()
  }, 60_000)

  afterAll(async () => {
    await probe?.end().catch(() => {})
    if (!admin) return
    for (const t of ['a', 'b']) {
      if (!ids[t]) continue
      await admin.query(`DELETE FROM vendas_atribuidas WHERE tenant_id = $1`, [ids[t].tenantId])
      await admin.query(`DELETE FROM boletos WHERE tenant_id = $1`, [ids[t].tenantId])
      await admin.query(`DELETE FROM lives WHERE tenant_id = $1`, [ids[t].tenantId])
      await admin.query(`DELETE FROM marcas WHERE tenant_id = $1`, [ids[t].tenantId])
      await admin.query(`DELETE FROM cabines WHERE tenant_id = $1`, [ids[t].tenantId])
      await admin.query(`DELETE FROM clientes WHERE tenant_id = $1`, [ids[t].tenantId])
      await admin.query(`DELETE FROM users WHERE tenant_id = $1`, [ids[t].tenantId])
      await admin.query(`DELETE FROM tenants WHERE id = $1`, [ids[t].tenantId])
    }
    await admin.query(`DROP OWNED BY ${PROBE_ROLE}`).catch(() => {})
    await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`).catch(() => {})
    await admin.end()
  }, 60_000)

  // Pré-condição: se o role tivesse BYPASSRLS, tudo abaixo passaria por acidente.
  it('o role de teste realmente NÃO tem BYPASSRLS', async () => {
    const r = await probe.query(
      `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`,
    )
    expect(r.rows[0].rolbypassrls).toBe(false)
    expect(r.rows[0].rolsuper).toBe(false)
  })

  it('RLS está habilitada nas três tabelas sensíveis', async () => {
    const r = await probe.query(
      `SELECT tablename, rowsecurity FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN ('lives', 'vendas_atribuidas', 'boletos')`,
    )
    expect(r.rows).toHaveLength(3)
    for (const row of r.rows) expect(row.rowsecurity).toBe(true)
  })

  for (const [self, other] of [['a', 'b'], ['b', 'a']]) {
    it(`tenant ${self.toUpperCase()} enxerga só os próprios dados (nunca os de ${other.toUpperCase()})`, async () => {
      await probe.query(`SELECT set_config('app.tenant_id', $1, false)`, [ids[self].tenantId])

      for (const [tabela, campo] of [
        ['lives', 'liveId'],
        ['vendas_atribuidas', 'vendaId'],
        ['boletos', 'boletoId'],
      ]) {
        const visiveis = await probe.query(`SELECT id, tenant_id FROM ${tabela}`)

        // Nenhuma linha de OUTRO tenant vaza — nem a semeada em ${other}, nem
        // qualquer outra que exista no banco.
        const vazamentos = visiveis.rows.filter((r) => r.tenant_id !== ids[self].tenantId)
        expect(vazamentos).toEqual([])
        expect(visiveis.rows.map((r) => r.id)).not.toContain(ids[other][campo])

        // E a própria linha continua visível (a policy não é um DENY ALL).
        expect(visiveis.rows.map((r) => r.id)).toContain(ids[self][campo])

        // Acesso direto por PK ao registro do outro tenant também não retorna.
        const direto = await probe.query(`SELECT id FROM ${tabela} WHERE id = $1`, [
          ids[other][campo],
        ])
        expect(direto.rows).toHaveLength(0)
      }
    })
  }

  it('UPDATE/DELETE não alcançam linhas de outro tenant', async () => {
    await probe.query(`SELECT set_config('app.tenant_id', $1, false)`, [ids.a.tenantId])

    const upd = await probe.query(`UPDATE boletos SET valor = 1 WHERE id = $1`, [ids.b.boletoId])
    expect(upd.rowCount).toBe(0)

    const del = await probe.query(`DELETE FROM lives WHERE id = $1`, [ids.b.liveId])
    expect(del.rowCount).toBe(0)

    // Confirma via admin que a linha do tenant B seguiu intacta.
    const check = await admin.query(`SELECT valor FROM boletos WHERE id = $1`, [ids.b.boletoId])
    expect(Number(check.rows[0].valor)).toBe(500)
  })

  it('INSERT com tenant_id de outro tenant é rejeitado (WITH CHECK)', async () => {
    await probe.query(`SELECT set_config('app.tenant_id', $1, false)`, [ids.a.tenantId])
    await expect(
      probe.query(
        `INSERT INTO vendas_atribuidas (tenant_id, origem, origem_id, marca_id, data, gmv)
         VALUES ($1, 'live', $2, $3, CURRENT_DATE, 999)`,
        [ids.b.tenantId, ids.b.liveId, ids.b.marcaId],
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  // Este é o modo de falha dos crons (ver src/jobs/tenant_scan.js): sem tenant
  // no contexto a policy compara com NULL e filtra TUDO — falha fechada, em
  // silêncio. O teste congela esse comportamento pra ninguém "consertar" com uma
  // policy que aceite NULL como "ver tudo".
  it('sem app.tenant_id no contexto, nenhuma linha é visível (fail-closed)', async () => {
    // Conexão nova: nunca recebeu set_config, igual a um cron pegando conexão
    // limpa do pool de sistema.
    const virgem = new pg.Client({ connectionString: probeUrl() })
    await virgem.connect()
    try {
      for (const tabela of ['lives', 'vendas_atribuidas', 'boletos']) {
        const r = await virgem.query(`SELECT COUNT(*)::int AS n FROM ${tabela}`)
        expect(r.rows[0].n).toBe(0)
      }
    } finally {
      await virgem.end()
    }
  })
})
