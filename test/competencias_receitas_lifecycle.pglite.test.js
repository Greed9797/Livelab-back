import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { beforeAll, afterAll, expect, it } from 'vitest'
import { gerarTitulosReceita, perderTitulo, receberTitulo, listarTitulosReceita } from '../src/services/receitas-comercial.js'
import { reconcileCondicaoReceitas } from '../src/services/competencias-receitas.js'
import { limparTitulosFuturosMarca } from '../src/lib/marca-lifecycle-sql.js'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const tenant=id(1), marca=id(2), titulo=id(3)
let pg, db, charge = 0
beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(`CREATE TABLE marcas(id uuid,tenant_id uuid,nome text,tipo text,tipo_cobranca text,data_fim date);
    CREATE TABLE clientes(id uuid,tenant_id uuid,nome text);
    CREATE TABLE receita_titulos(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,marca_id uuid,cliente_id uuid,
      competencia date,componente text,valor_previsto numeric(15,2),valor_pago numeric(15,2),data_vencimento date,
      data_pagamento date,observacao text,perdido_em timestamptz,perdido_motivo text,perdido_por uuid,
      valor_perdido numeric(15,2),criado_por uuid,atualizado_em timestamptz,
      UNIQUE(tenant_id,marca_id,competencia,componente));
    CREATE TABLE financeiro_liquidacoes(tenant_id uuid,idempotencia_chave text,valor numeric(15,2),data_liquidacao date,idempotencia_payload jsonb);
    INSERT INTO marcas VALUES('${marca}','${tenant}','Alfa','cliente','fixo_mais_comissao','2026-08-01');
    INSERT INTO receita_titulos(id,tenant_id,marca_id,competencia,componente,valor_previsto,valor_pago,data_vencimento)
      VALUES('${titulo}','${tenant}','${marca}','2026-09-01','fixo',100,0,'2026-10-05');`)
  await pg.exec(await readFile(new URL('../migrations/184_receita_titulos_suspensao_comercial.sql',import.meta.url),'utf8'))
  db = { query(sql,params) {
    // Only the unrelated GMV calculator is stubbed; all lifecycle writes,
    // locks, title projections and guards execute against PostgreSQL.
    if (String(sql).includes('WITH comissao_marca')) return Promise.resolve({rows:charge ? [{marca_id:marca,marca_nome:'Alfa',
      marca_tipo:'cliente',competencia:'2026-09-01',fixo:String(charge),comissao:'0',tipo_cobranca:'fixo_mais_comissao'}] : []})
    return pg.query(sql,params)
  } }
},30000)
afterAll(async()=>pg.close())

it('suspensão sobrevive à geração e ao encerramento da marca; nova perda/baixa bloqueadas; recriação reusa ID', async()=>{
  const scope={tenantId:tenant,marcaId:marca,start:'2026-09-01',end:'2026-10-01'}
  await pg.exec('BEGIN')
  await reconcileCondicaoReceitas(db,{...scope,operacao:'excluir'})
  await pg.exec('COMMIT')
  const gerados=await gerarTitulosReceita(db,{tenantId:tenant,mes:'2026-09',hoje:'2026-10-07'})
  expect(gerados.removidos).toBe(0)
  expect(gerados.itens[0]).toMatchObject({id:titulo,status:'cancelado',valor_previsto:0,valor_previsto_original:100})
  await limparTitulosFuturosMarca(db,{tenantId:tenant,where:'m.id=$2::uuid',params:[marca]})
  expect((await pg.query('SELECT count(*)::int AS n FROM receita_titulos')).rows[0].n).toBe(1)
  await expect(perderTitulo(db,{tenantId:tenant,id:titulo,motivo:'Teste',hoje:'2026-10-07'}))
    .rejects.toMatchObject({code:'RECEITA_SUSPENSA_COMERCIAL'})
  await expect(receberTitulo(db,{tenantId:tenant,id:titulo,valorPago:'50',hoje:'2026-10-07'}))
    .rejects.toMatchObject({code:'RECEITA_SUSPENSA_COMERCIAL'})
  charge=120
  await pg.exec('BEGIN')
  await reconcileCondicaoReceitas(db,{...scope,operacao:'criar'})
  await pg.exec('COMMIT')
  const restored=await listarTitulosReceita(db,{tenantId:tenant,inicio:'2026-09',fim:'2026-09',hoje:'2026-10-07'})
  expect(restored[0]).toMatchObject({id:titulo,valor_previsto:120,suspensao_comercial:null})
  expect((await pg.query('SELECT count(*)::int AS n FROM receita_titulos')).rows[0].n).toBe(1)
})
