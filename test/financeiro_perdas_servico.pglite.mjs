import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { applyMigration } from '../apply_migrations.js'
import {
  desperderReceitaAvulsa, perderReceitaAvulsa, receberReceitaAvulsa,
} from '../src/services/receitas-avulsas.js'

const db = new PGlite()
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenantId = id(1)
const avulsaId = id(2)
const actorId = id(3)
const legacyId = id(4)
const client = {
  async query(sql, params) {
    if (params?.length) return db.query(sql, params)
    await db.exec(sql)
    return { rows: [] }
  },
}

try {
  await db.exec(`
    CREATE TABLE tenants (id uuid PRIMARY KEY);
    CREATE TABLE schema_migrations (version varchar(255) PRIMARY KEY, applied_at timestamptz DEFAULT now());
    CREATE TABLE receita_titulos (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, competencia date NOT NULL,
      valor_previsto numeric(15,2) NOT NULL
    );
    CREATE TABLE receitas_avulsas (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, descricao text NOT NULL, grupo text NOT NULL,
      valor_previsto numeric(15,2) NOT NULL, valor_pago numeric(15,2) NOT NULL DEFAULT 0,
      observacao text, data_vencimento date NOT NULL, data_pagamento date, competencia date NOT NULL,
      perdido_em timestamptz, perdido_motivo text, perdido_por uuid, atualizado_em timestamptz
    );
    INSERT INTO tenants(id) VALUES ('${tenantId}');
    INSERT INTO receitas_avulsas
      (id, tenant_id, descricao, grupo, valor_previsto, data_vencimento, competencia)
    VALUES ('${avulsaId}', '${tenantId}', 'Serviço', 'servico', 100.00, '2026-09-10', '2026-09-01');
    INSERT INTO receitas_avulsas
      (id, tenant_id, descricao, grupo, valor_previsto, data_vencimento, competencia,
       perdido_em, perdido_motivo)
    VALUES ('${legacyId}', '${tenantId}', 'Legado', 'servico', 20.00, '2026-09-10',
            '2026-09-01', now(), 'perda anterior');
  `)
  await applyMigration(client, '181_financeiro_perdas_reversoes.sql')
  await db.exec(`SET app.tenant_id = '${tenantId}'`)

  const common = { tenantId, id: avulsaId, actorId, actorUserId: actorId, hoje: '2026-10-05' }
  const lost = await perderReceitaAvulsa(db, { ...common, motivo: 'incobrável', valorPerda: '12.34', chaveOperacao: id(11) })
  assert.equal(lost.item.valor_perdido, 12.34)
  assert.equal(lost.item.perdido_em, null)
  assert.equal((await db.query('SELECT valor_perdido::text AS v FROM receitas_avulsas WHERE id = $1', [avulsaId])).rows[0].v, '12.34')

  const paid = await receberReceitaAvulsa(db, { tenantId, id: avulsaId, hoje: '2026-10-05' })
  assert.equal(paid.valor_pago, 87.66)
  assert.equal(paid.status, 'perdido')
  assert.equal(paid.perdido_em, null)

  const reversed = await desperderReceitaAvulsa(db, { ...common, motivo: 'acordo retomado', valorReversao: '2.34', chaveOperacao: id(12) })
  assert.equal(reversed.item.valor_perdido, 10)
  assert.equal(reversed.item.status, 'atrasado')
  const events = (await db.query(`SELECT tipo, valor::text AS valor, perda_original_id
    FROM financeiro_perdas_eventos WHERE origem_id = $1 ORDER BY registrado_em, tipo`, [avulsaId])).rows
  assert.equal(events.length, 2)
  assert.deepEqual(events.map((e) => [e.tipo, e.valor]), [['perda', '12.34'], ['reversao', '2.34']])
  assert.ok(events[1].perda_original_id)

  await assert.rejects(
    desperderReceitaAvulsa(db, { ...common, valorReversao: '10.01', motivo: 'valor excessivo', chaveOperacao: id(13) }),
    (e) => e.statusCode === 409 && e.code === 'REVERSAO_MAIOR_QUE_PERDA',
  )
  await assert.rejects(
    desperderReceitaAvulsa(db, { ...common, id: legacyId, motivo: 'tentativa' }),
    (e) => e.statusCode === 409 && e.code === 'RECEITA_PERDA_LEGADA',
  )
  assert.equal((await db.query('SELECT count(*)::int AS n FROM financeiro_perdas_eventos WHERE origem_id = $1', [avulsaId])).rows[0].n, 2)
  console.log('PASS: FIN-02 avulsa service, exact partial loss/reversal, payment, immutable events and legacy guard')
} finally {
  await db.close()
}
