// Integração com Postgres real (SPEC perdas, frente B2): receita PERDIDA e custo CANCELADO
// na agregação — lançamentos/totais, DRE (anual e /dre/mes), caixa, fluxo, projeção do
// imposto, conciliação e corte. Só roda com TEST_PG_URL num banco com o schema completo
// (scripts/setup_fresh_schema.js + apply_migrations.js, incluindo a 173).
// O estado perdido/cancelado é gravado direto nas colunas da migration 173 (contrato de
// persistência), independente das rotas do B1.
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import '../src/lib/pg-date-string.js'
import {
  atualizarConfigFinanceiro, calcularCaixa, calcularDre, calcularDreMes, calcularFluxoCaixa, calcularImpostos,
  consultarLancamentos, listarLancamentos,
} from '../src/services/financeiro-agregador.js'
import { criarReceitaAvulsa, listarReceitasAvulsas } from '../src/services/receitas-avulsas.js'
import { consultarReceitaMensal, listarTitulosReceita, receberTitulo } from '../src/services/receitas-comercial.js'
import { listarCustos, materializarVirtual } from '../src/services/custos-plano.js'
import { candidatoDeLancamento, darBaixaConciliacao } from '../src/services/conciliacao.js'

const url = process.env.TEST_PG_URL
const HOJE = '2026-10-15'

describe.skipIf(!url)('financeiro: perdas e cancelamentos na agregação (Postgres real)', () => {
  let pool
  let t
  let marcaId
  let tituloSet
  let tituloAgo
  let avulsaPerdida
  let internet
  let aluguelOut
  let recId
  const q = (sql, params) => pool.query(sql, params)

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 })
    t = (await q(`INSERT INTO tenants (nome) VALUES ('t-perdas-b2') RETURNING id`)).rows[0].id
    const cliente = (await q(
      `INSERT INTO clientes (tenant_id, nome, celular, status) VALUES ($1, 'Cliente P', '47999999911', 'ativo') RETURNING id`, [t],
    )).rows[0].id
    marcaId = (await q(
      `INSERT INTO marcas (tenant_id, cliente_id, nome, tipo, data_inicio) VALUES ($1, $2, 'Marca P', 'cliente', '2026-06-01') RETURNING id`,
      [t, cliente],
    )).rows[0].id
    await q(
      `INSERT INTO marca_condicoes_comerciais (tenant_id, marca_id, inicio_vigencia, fixo_mensal, comissao_franquia_pct,
         tipo_cobranca, fixo_confirmado, comissao_confirmada, origem)
       VALUES ($1, $2, '2026-06-01', 1000, 0, 'fixo_mais_comissao', true, true, 'gestao')`, [t, marcaId],
    )
    // Fixo de setembro (vence 05/10): pagou 400 em 06/10 e foi dado como PERDIDO (perda parcial: 600).
    tituloSet = (await receberTitulo(pool, { tenantId: t, id: `calc:${marcaId}:2026-09:fixo`, valorPago: 400, dataPagamento: '2026-10-06', hoje: HOJE })).id
    // Fixo de agosto (vence 05/09): PERDIDO sem pagamento — antes do corte (01/10) quando houver corte.
    tituloAgo = (await q(
      `INSERT INTO receita_titulos (tenant_id, marca_id, componente, competencia, data_vencimento, valor_previsto, valor_pago)
       VALUES ($1, $2, 'fixo', '2026-08-01', '2026-09-05', 1000, 0) RETURNING id`, [t, marcaId],
    )).rows[0].id
    await q(
      `UPDATE receita_titulos SET perdido_em = NOW(), perdido_motivo = $3
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [t, [tituloSet, tituloAgo], 'Cliente encerrou'],
    )
    // Avulsa 800 (vence 20/10) PERDIDA; avulsa 200 normal em aberto (vence 22/10).
    avulsaPerdida = (await criarReceitaAvulsa(pool, { tenantId: t, dados: { descricao: 'Consultoria X', grupo: 'servico', valor_previsto: 800, data_vencimento: '2026-10-20' }, hoje: HOJE })).id
    await criarReceitaAvulsa(pool, { tenantId: t, dados: { descricao: 'Consultoria Y', grupo: 'servico', valor_previsto: 200, data_vencimento: '2026-10-22' }, hoje: HOJE })
    await q(`UPDATE receitas_avulsas SET perdido_em = NOW(), perdido_motivo = 'Não vai pagar' WHERE tenant_id = $1 AND id = $2`, [t, avulsaPerdida])
    // Custos de outubro: Internet 150 CANCELADO; Frete 100 normal; Aluguel recorrente 300 cancelado SÓ em outubro.
    internet = (await q(
      `INSERT INTO custos (tenant_id, descricao, valor, tipo, grupo, competencia, data_vencimento, cancelado_em, cancelado_motivo)
       VALUES ($1, 'Internet', 150, 'outros', 'ferramentas', '2026-10-01', '2026-10-25', NOW(), 'Duplicado') RETURNING id`, [t],
    )).rows[0].id
    await q(
      `INSERT INTO custos (tenant_id, descricao, valor, tipo, grupo, competencia, data_vencimento)
       VALUES ($1, 'Frete', 100, 'outros', 'operacional', '2026-10-01', '2026-10-20')`, [t],
    )
    recId = (await q(
      `INSERT INTO custos_recorrentes (tenant_id, nome, grupo, valor, dia_vencimento, inicio)
       VALUES ($1, 'Aluguel', 'estrutural', 300, 10, '2026-10-01') RETURNING id`, [t],
    )).rows[0].id
    aluguelOut = await materializarVirtual(pool, { tenantId: t, recorrente_id: recId, mes: '2026-10' })
    await q(`UPDATE custos SET cancelado_em = NOW(), cancelado_motivo = 'Perdoado' WHERE tenant_id = $1 AND id = $2`, [t, aluguelOut])
  })

  afterAll(async () => {
    if (!pool) return
    for (const tb of ['receitas_avulsas', 'receita_titulos', 'custos', 'custos_recorrentes', 'marca_condicoes_comerciais', 'marcas', 'clientes']) {
      await q(`DELETE FROM ${tb} WHERE tenant_id = $1`, [t]).catch(() => {})
    }
    await q('DELETE FROM tenants WHERE id = $1', [t]).catch(() => {})
    await pool.end()
  })

  it('lançamentos: status/motivo; totais com perdido/cancelado fora de pendente/atrasado', async () => {
    const { itens, totais } = await consultarLancamentos(pool, { tenantId: t, inicio: '2026-09', fim: '2026-10', hoje: HOJE })
    const porId = (id) => itens.find((i) => i.id === id)
    expect(porId(tituloSet)).toMatchObject({ status: 'perdido', perdido_motivo: 'Cliente encerrou', valor_pago: 400 })
    expect(porId(avulsaPerdida)).toMatchObject({ status: 'perdido', perdido_motivo: 'Não vai pagar' })
    expect(porId(internet)).toMatchObject({ status: 'cancelado', cancelado_motivo: 'Duplicado' })
    expect(porId(aluguelOut)).toMatchObject({ status: 'cancelado', cancelado_motivo: 'Perdoado', recorrente_id: recId })
    // recorrente cancelado no mês não gera virtual duplicado
    expect(itens.filter((i) => i.recorrente_id === recId).map((i) => i.id)).toEqual([aluguelOut])
    expect(totais.receita.perdido).toBe(600 + 800)
    expect(totais.custo.cancelado).toBe(150 + 300)
    expect(totais.receita.atrasado).toBe(0)
    // em aberto não encerrado: fixo de outubro (1000, vence 05/11 → previsto) + avulsa Y 200 (pendente)
    expect(totais.receita.pendente).toBe(1200)
    expect(totais.custo.pendente).toBe(100)
    expect(totais.saldo_previsto).toBe((totais.receita.previsto - 1400) - (totais.custo.previsto - 450))

    const soPerdidos = await consultarLancamentos(pool, { tenantId: t, inicio: '2026-09', fim: '2026-10', hoje: HOJE, filtros: { status: 'perdido' } })
    expect(soPerdidos.itens.map((i) => i.id).sort()).toEqual([tituloSet, avulsaPerdida].sort())
    expect(soPerdidos.totais.receita).toMatchObject({ perdido: 1400, pendente: 0, atrasado: 0 })
  })

  it('DRE: receita.previsto inalterado, linha perdas, custos sem cancelados, resultado previsto desconta', async () => {
    const dre = await calcularDre(pool, { tenantId: t, inicio: '2026-08', fim: '2026-10', hoje: HOJE })
    const [ago, set, out] = dre.meses
    expect(ago.receita.previsto).toBe(1000)
    expect(ago.perdas.receita.valor).toBe(1000)
    expect(set.receita).toEqual({ previsto: 1000, realizado: 400 })
    expect(set.perdas.receita.valor).toBe(600)
    expect(set.resultado.previsto).toBe(400)
    expect(set.resultado.realizado).toBe(400)
    // outubro: fixo 1000 + avulsas 800 (perdida) + 200 = 2000; perdas 800
    expect(out.receita.previsto).toBe(2000)
    expect(out.perdas.receita.valor).toBe(800)
    expect(out.custos.previsto).toBe(100)
    expect(out.custos.por_grupo).toMatchObject({ ferramentas: { previsto: 0 }, estrutural: { previsto: 0 }, operacional: { previsto: 100 } })
    expect(out.custos_fixos.previsto + out.custos_variaveis.previsto).toBe(100 + out.imposto.previsto + out.apresentadoras.previsto)
    expect(out.resultado.previsto).toBe(2000 - 800 - out.custos_fixos.previsto - out.custos_variaveis.previsto)
    expect(dre.totais.perdas.receita.valor).toBe(2400)

    // invariante com a aba Receita: competencia.total.previsto == DRE.receita.previsto
    for (const [mes, linha] of [['2026-09', set], ['2026-10', out]]) {
      const r = await consultarReceitaMensal(pool, { tenantId: t, mes, hoje: HOJE })
      expect(r.competencia.total.previsto).toBe(linha.receita.previsto)
      expect(r.competencia.total.pago).toBe(linha.receita.realizado)
    }
  })

  it('/dre/mes: perdidos e cancelados no detalhe com status e motivo', async () => {
    const d = await calcularDreMes(pool, { tenantId: t, mes: '2026-10', hoje: HOJE })
    expect(d.atual.perdas.receita.valor).toBe(800)
    expect(d.anterior.perdas.receita.valor).toBe(600)
    expect(d.receita.perdas).toEqual({ valor: 800 })
    expect(d.receita.perdidos).toEqual([expect.objectContaining({
      id: avulsaPerdida, status: 'perdido', perdido_motivo: 'Não vai pagar', valor_encerrado: 800, previsto: 800,
    })])
    const custosItens = [...d.custos_fixos.por_grupo, ...d.custos_variaveis.por_grupo].flatMap((g) => g.itens)
    expect(custosItens.find((i) => i.id === internet)).toMatchObject({ status: 'cancelado', cancelado_motivo: 'Duplicado', previsto: 0, valor_encerrado: 150 })
    expect(custosItens.find((i) => i.id === aluguelOut)).toMatchObject({ status: 'cancelado', cancelado_motivo: 'Perdoado', previsto: 0 })
    expect(d.atual.resultado.previsto).toBe(
      Math.round((d.atual.receita.previsto - d.atual.perdas.receita.valor - d.atual.custos_fixos.previsto - d.atual.custos_variaveis.previsto) * 100) / 100,
    )
  })

  it('imposto: base realizada inalterada; projeção sem perdidos', async () => {
    const [out, nov] = await calcularImpostos(pool, { tenantId: t, inicio: '2026-10', fim: '2026-11', hoje: HOJE })
    // outubro: base = recebido em setembro (0); novembro: projeção sobre vencimentos de outubro:
    // fixo set (perdido, conta só 400 pagos) + avulsa X perdida (0) + avulsa Y 200 = 600
    expect(out).toMatchObject({ base_tipo: 'realizado', base: 0 })
    expect(nov).toMatchObject({ base_tipo: 'projetado', base: 600, valor: 60 })
  })

  it('fluxo: previsto sem perdidos/cancelados; realizado inalterado', async () => {
    const f = await calcularFluxoCaixa(pool, { tenantId: t, mes: '2026-10', saldoInicial: 0, hoje: HOJE })
    expect(f.totais.entradas).toEqual({ previsto: 600, realizado: 400 })
    expect(f.totais.saidas.previsto).toBe(100)
    // aba Receita (visão vencimento): previsto − perdido == entradas previstas do fluxo
    const r = await consultarReceitaMensal(pool, { tenantId: t, mes: '2026-10', hoje: HOJE })
    expect(Math.round((r.vencimento.total.previsto - (r.vencimento.total.perdido ?? 0)) * 100) / 100).toBe(f.totais.entradas.previsto)
  })

  it('conciliação: perdido/cancelado fora dos candidatos e baixa → 409', async () => {
    const base = { tenantId: t, inicio: '2026-09', fim: '2026-10', hoje: HOJE }
    const itens = [
      ...(await listarTitulosReceita(pool, base)), ...(await listarReceitasAvulsas(pool, base)), ...(await listarCustos(pool, base)),
    ]
    const ids = itens.filter((l) => l.status !== 'pago').map((l) => candidatoDeLancamento(l)).filter(Boolean).map((c) => c.id)
    for (const id of [tituloSet, avulsaPerdida, internet, aluguelOut]) expect(ids).not.toContain(id)
    expect(ids.length).toBeGreaterThan(0)

    const client = await pool.connect()
    try {
      const casos = [
        ['receita', tituloSet, 'entrada'], ['receita', `calc:${marcaId}:2026-09:fixo`, 'entrada'], ['avulsa', avulsaPerdida, 'entrada'],
        ['custo', internet, 'saida'], ['custo', `rec:${recId}:2026-10`, 'saida'],
      ]
      for (const [tipo, alvoId] of casos) {
        await client.query('BEGIN')
        try {
          await expect(darBaixaConciliacao(client, { tenantId: t, transacao: { valor: 100, data: '2026-10-12' }, tipo, alvoId }))
            .rejects.toMatchObject({ status: 409, message: 'Desfaça a perda/cancelamento antes' })
        } finally {
          await client.query('ROLLBACK')
        }
      }
    } finally {
      client.release()
    }
    const intacto = await q('SELECT valor_pago FROM receita_titulos WHERE id = $1', [tituloSet])
    expect(Number(intacto.rows[0].valor_pago)).toBe(400)
  })

  it('caixa e corte: a_receber sem perdidos, a_pagar sem cancelados; perdido antes do corte some', async () => {
    await atualizarConfigFinanceiro(pool, t, { data_corte: '2026-10-01', saldo_abertura: 10000 })
    try {
      const c = await calcularCaixa(pool, { tenantId: t, ate: HOJE, hoje: HOJE })
      // recebido desde o corte: 400 (fixo set, 06/10). A receber: só avulsa Y 200. A pagar: Frete 100.
      expect(c).toMatchObject({ saldo_atual: 10400, a_receber: 200, a_pagar: 100, saldo_projetado_fim_mes: 10500 })
      // fixo de agosto (perdido, vencido 05/09 < corte) fica fora de tudo
      const itens = await listarLancamentos(pool, { tenantId: t, inicio: '2026-08', fim: '2026-10', hoje: HOJE })
      expect(itens.some((i) => i.id === tituloAgo)).toBe(false)
      const dre = await calcularDre(pool, { tenantId: t, inicio: '2026-08', fim: '2026-10', hoje: HOJE })
      expect(dre.meses[0].perdas.receita.valor).toBe(0)
      // fixo set: pagamento 06/10 >= corte → fica, com a perda parcial
      expect(dre.meses[1].perdas.receita.valor).toBe(600)
      expect(dre.totais.perdas.receita.valor).toBe(1400)
      const { totais } = await consultarLancamentos(pool, { tenantId: t, inicio: '2026-08', fim: '2026-10', hoje: HOJE })
      expect(totais.receita.perdido).toBe(1400)
      expect(totais.custo.cancelado).toBe(450)
    } finally {
      await atualizarConfigFinanceiro(pool, t, { data_corte: null, saldo_abertura: 0 })
    }
  })
})
