import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { listarEventosPerdaDre, montarDre } from '../src/services/financeiro-agregador.js'

const db = new PGlite()
await db.exec(`
  CREATE TABLE receitas_avulsas (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    grupo text NOT NULL
  );
  CREATE TABLE financeiro_perdas_eventos (
    id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    tipo text NOT NULL,
    origem_tipo text NOT NULL,
    origem_id uuid NOT NULL,
    valor numeric(15,2) NOT NULL,
    competencia_obrigacao date NOT NULL,
    registrado_em timestamptz NOT NULL
  );
`)

const tenant = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const outro = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const titulo = '11111111-1111-1111-1111-111111111111'
const avulsa = '22222222-2222-2222-2222-222222222222'
const aporte = '33333333-3333-3333-3333-333333333333'
const ausente = '44444444-4444-4444-4444-444444444444'

await db.query(`INSERT INTO receitas_avulsas VALUES ($1,$2,'servico'),($3,$2,'aporte')`, [avulsa, tenant, aporte])
await db.query(`
  INSERT INTO financeiro_perdas_eventos
    (id, tenant_id, tipo, origem_tipo, origem_id, valor, competencia_obrigacao, registrado_em)
  VALUES
    ('90000000-0000-0000-0000-000000000001',$1,'perda','receita_titulo',$2,800,'2026-09-01','2026-10-01 02:30:00+00'),
    ('90000000-0000-0000-0000-000000000002',$1,'reversao','receita_titulo',$2,300,'2026-09-01','2026-11-15 12:00:00+00'),
    ('90000000-0000-0000-0000-000000000003',$1,'perda','receita_avulsa',$3,100,'2026-10-01','2026-10-20 12:00:00+00'),
    ('90000000-0000-0000-0000-000000000004',$1,'perda','receita_avulsa',$4,50,'2026-10-01','2026-10-20 12:00:00+00'),
    ('90000000-0000-0000-0000-000000000005',$5,'perda','receita_titulo',$2,999,'2026-09-01','2026-10-20 12:00:00+00'),
    ('90000000-0000-0000-0000-000000000006',$1,'perda','receita_avulsa',$6,40,'2026-10-01','2026-10-20 12:00:00+00')
`, [tenant, titulo, avulsa, aporte, outro, ausente])

const rows = await listarEventosPerdaDre(db, { tenantId: tenant, inicio: '2026-09', fim: '2026-10' })
assert.equal(rows.length, 3)
assert.deepEqual(rows.map((r) => [r.tipo, r.valor, r.mes_registro]), [
  ['perda', '800.00', '2026-09'],
  ['perda', '100.00', '2026-10'],
  ['reversao', '300.00', '2026-11'],
])
assert.equal(rows.some((r) => r.origem_id === aporte || r.origem_id === ausente), false)
assert.equal(new Set(rows.map((r) => r.origem_id)).size, 2)

const tituloItem = (valorPerdido) => ({ natureza: 'receita', origem: 'marca_fixo', id: titulo,
  competencia: '2026-09-01', valor_previsto: 1000, valor_pago: 200,
  valor_perdido: valorPerdido, virtual: false })
const antesReversao = montarDre({
  meses: ['2026-09', '2026-10'], itens: [tituloItem(800)],
  eventosPerda: rows.filter((r) => r.tipo !== 'reversao'),
})
const historico = montarDre({
  meses: ['2026-09', '2026-10'], itens: [tituloItem(500)], eventosPerda: rows,
})
assert.deepEqual(historico.meses, antesReversao.meses)
assert.equal(historico.meses[0].resultado.previsto, 200)
assert.equal(historico.meses[1].perdas.receita.valor, 100)
assert.equal(historico.meses[1].resultado.previsto, -100)

const projecaoComEvento = montarDre({
  meses: ['2026-10'],
  itens: [{ natureza: 'receita', origem: 'avulsa', id: avulsa, grupo: 'servico',
    competencia: '2026-10-01', valor_previsto: 500, valor_pago: 0, valor_perdido: 300, virtual: false }],
  eventosPerda: rows.filter((r) => r.origem_id === avulsa),
})
assert.equal(projecaoComEvento.meses[0].perdas.receita.valor, 100)
assert.equal(projecaoComEvento.meses[0].resultado.previsto, 400)

await db.close()
console.log('financeiro_dre_perdas_eventos.pglite: ok')
