import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const { calculate } = vi.hoisted(() => ({ calculate: vi.fn() }))
vi.mock('../src/services/receitas-comercial.js', () => ({ calcularReceitasComerciais: calculate }))
import { reconcileCondicaoReceitas } from '../src/services/competencias-receitas.js'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant = id(1), other = id(2), brand = id(3), title = id(4)
let db
const options = { tenantId: tenant, marcaId: brand, start: '2026-09-01', end: '2026-11-01', operacao: 'delete' }
const current = async () => (await db.query(`SELECT *, valor_previsto::text AS bruto, valor_pago::text AS pago,
  valor_perdido::text AS perdido, to_char(data_vencimento,'YYYY-MM-DD') AS vencimento,
  to_char(data_pagamento,'YYYY-MM-DD') AS pagamento FROM receita_titulos WHERE id=$1`, [title])).rows[0]
const correction = (value) => calculate.mockResolvedValue([{
  marca_id: brand, competencia: '2026-09-01', componente: 'fixo', valor: value, data_vencimento: '2026-10-15',
}])

beforeEach(async () => {
  calculate.mockReset().mockResolvedValue([])
  db = new PGlite()
  await db.exec(`CREATE TABLE receita_titulos (
    id uuid PRIMARY KEY, tenant_id uuid, marca_id uuid, competencia date, componente text,
    valor_previsto numeric(15,2), valor_pago numeric(15,2), valor_perdido numeric(15,2),
    perdido_em timestamptz, data_pagamento date, data_vencimento date, atualizado_em timestamptz);
    CREATE TABLE financeiro_liquidacoes (id uuid PRIMARY KEY, origem_id uuid, valor numeric(15,2), data_liquidacao date);
    CREATE TABLE snapshots_fechados (id uuid, dados jsonb);
    INSERT INTO receita_titulos VALUES
      ('${title}','${tenant}','${brand}','2026-09-01','fixo',100,30,10,NULL,'2026-10-05','2026-10-05',NULL),
      ('${id(5)}','${other}','${brand}','2026-09-01','fixo',777,0,NULL,NULL,NULL,'2026-10-05',NULL),
      ('${id(6)}','${tenant}','${brand}','2026-11-01','fixo',999,0,NULL,NULL,NULL,'2026-12-05',NULL);
    INSERT INTO financeiro_liquidacoes VALUES ('${id(7)}','${title}',30,'2026-10-05');
    INSERT INTO snapshots_fechados VALUES ('${title}','{"receita":100}');`)
  await db.exec(await readFile(new URL('../migrations/184_receita_titulos_suspensao_comercial.sql', import.meta.url), 'utf8'))
  await db.exec('BEGIN')
})
afterEach(async () => { await db.exec('ROLLBACK'); await db.close() })

describe('reconcileCondicaoReceitas SQL real', () => {
  it('suspende só saldo aberto, preservando bruto, perda, fatos, snapshot e escopo', async () => {
    const result = await reconcileCondicaoReceitas(db, options)
    expect(result).toMatchObject({ titulos: 1, saldo_aberto_antes: '60.00', saldo_aberto_depois: '0.00',
      valor_previsto_depois: '40.00', valor_pago_preservado: '30.00', valor_perdido_preservado: '10.00' })
    expect(await current()).toMatchObject({ bruto: '100.00', pago: '30.00', perdido: '10.00',
      pagamento: '2026-10-05', suspensao_comercial: { ativa: true, saldo_suspenso: '60.00' } })
    expect((await db.query('SELECT valor::text FROM financeiro_liquidacoes')).rows).toEqual([{ valor: '30.00' }])
    expect((await db.query('SELECT dados FROM snapshots_fechados')).rows).toEqual([{ dados: { receita: 100 } }])
    expect((await db.query('SELECT count(*)::int AS n FROM receita_titulos WHERE suspensao_comercial IS NOT NULL')).rows[0].n).toBe(1)
  })

  it('preview não escreve e rollback desfaz uma suspensão', async () => {
    const preview = await reconcileCondicaoReceitas(db, { ...options, previewOnly: true })
    expect((await current()).suspensao_comercial).toBeNull()
    await db.exec('SAVEPOINT change')
    const actual = await reconcileCondicaoReceitas(db, options)
    expect(actual).toEqual(preview)
    await db.exec('ROLLBACK TO SAVEPOINT change')
    expect((await current()).suspensao_comercial).toBeNull()
  })

  it('recriação reusa identidade e pagamentos e só restaura saldo esperado', async () => {
    await reconcileCondicaoReceitas(db, options)
    correction('120.01')
    const result = await reconcileCondicaoReceitas(db, { ...options, operacao: 'create' })
    expect(result).toMatchObject({ titulos_restaurados: 1, saldo_aberto_antes: '0.00', saldo_aberto_depois: '80.01' })
    expect(await current()).toMatchObject({ id: title, bruto: '120.01', pago: '30.00', perdido: '10.00',
      vencimento: '2026-10-05', suspensao_comercial: null })
    expect((await db.query('SELECT count(*)::int AS n FROM financeiro_liquidacoes')).rows[0].n).toBe(1)
  })

  it('redução abaixo do já pago informa excesso e não estorna nem reabre perda', async () => {
    correction('20.00')
    const result = await reconcileCondicaoReceitas(db, { ...options, operacao: 'update' })
    expect(result).toMatchObject({ excesso_recebido: '10.00', valor_previsto_depois: '40.00', saldo_aberto_depois: '0.00' })
    expect(await current()).toMatchObject({ bruto: '40.00', pago: '30.00', perdido: '10.00' })
  })

  it('conserva perda legada e vencimento já pago; atualizado sem pagamento pode mudar data', async () => {
    await db.query('UPDATE receita_titulos SET valor_perdido=NULL, perdido_em=NOW() WHERE id=$1', [title])
    correction('500.00')
    const result = await reconcileCondicaoReceitas(db, { ...options, operacao: 'update' })
    expect(result.saldo_aberto_depois).toBe('0.00')
    expect((await current()).bruto).toBe('100.00')
    await db.query('UPDATE receita_titulos SET valor_pago=0,data_pagamento=NULL,perdido_em=NULL WHERE id=$1', [title])
    await reconcileCondicaoReceitas(db, { ...options, operacao: 'update' })
    expect((await current()).vencimento).toBe('2026-10-15')
  })

  it('recusa intervalo inválido antes de tocar títulos', async () => {
    await expect(reconcileCondicaoReceitas(db, { ...options, end: options.start })).rejects.toMatchObject({ statusCode: 400 })
    expect((await current()).suspensao_comercial).toBeNull()
  })
})
