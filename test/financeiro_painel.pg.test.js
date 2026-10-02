// Painel do mês ponta a ponta com Postgres real. Só roda com TEST_PG_URL (ex.: postgres://postgres@127.0.0.1:55492/fin)
// num banco com o schema completo (scripts/setup_fresh_schema.js + apply_migrations.js).
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import '../src/lib/pg-date-string.js'
import { atualizarConfigFinanceiro, calcularCaixa, calcularPainelMes } from '../src/services/financeiro-agregador.js'
import { criarReceitaAvulsa } from '../src/services/receitas-avulsas.js'
import { receberTitulo } from '../src/services/receitas-comercial.js'

const url = process.env.TEST_PG_URL
const HOJE = '2026-10-15'

describe.skipIf(!url)('financeiro: painel do mês (Postgres real)', () => {
  let pool
  let t
  let t2
  const q = (sql, params) => pool.query(sql, params)

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 })
    t = (await q(`INSERT INTO tenants (nome) VALUES ('t-painel') RETURNING id`)).rows[0].id
    t2 = (await q(`INSERT INTO tenants (nome) VALUES ('t-painel-outro') RETURNING id`)).rows[0].id
    const cliente = (await q(
      `INSERT INTO clientes (tenant_id, nome, celular, status) VALUES ($1, 'Cliente P', '47999999997', 'ativo') RETURNING id`, [t],
    )).rows[0].id
    const marcaId = (await q(
      `INSERT INTO marcas (tenant_id, cliente_id, nome, tipo, data_inicio) VALUES ($1, $2, 'Marca P', 'cliente', '2026-06-01') RETURNING id`,
      [t, cliente],
    )).rows[0].id
    await q(
      `INSERT INTO marca_condicoes_comerciais (tenant_id, marca_id, inicio_vigencia, fixo_mensal, comissao_franquia_pct,
         tipo_cobranca, fixo_confirmado, comissao_confirmada, origem)
       VALUES ($1, $2, '2026-06-01', 1000, 10, 'fixo_mais_comissao', true, true, 'gestao')`, [t, marcaId],
    )
    await atualizarConfigFinanceiro(pool, t, { data_corte: '2026-09-01', saldo_abertura: 1000 })
    // Fixo de setembro (vence 05/10) recebido em 03/10. O de agosto (vence 05/09) fica em aberto e atrasado.
    await receberTitulo(pool, { tenantId: t, id: `calc:${marcaId}:2026-09:fixo`, dataPagamento: '2026-10-03', hoje: HOJE })
    await q(
      `INSERT INTO custos (tenant_id, descricao, valor, tipo, grupo, competencia, data_vencimento, valor_pago, data_pagamento)
       VALUES ($1, 'Luz', 80, 'outros', 'estrutural', '2026-09-01', '2026-09-20', 0, NULL),
              ($1, 'Internet', 150, 'outros', 'ferramentas', '2026-10-01', '2026-10-25', 0, NULL),
              ($1, 'Frete pago', 60, 'outros', 'diversos', '2026-10-01', '2026-10-10', 60, '2026-10-10')`, [t],
    )
    const avulsa = (dados) => criarReceitaAvulsa(pool, { tenantId: t, dados, hoje: HOJE })
    await avulsa({ descricao: 'Aporte sócio', grupo: 'aporte', valor_previsto: 5000, data_vencimento: '2026-10-01', valor_pago: 5000, data_pagamento: '2026-10-01' })
    await avulsa({ descricao: 'Consultoria B', grupo: 'servico', valor_previsto: 800, data_vencimento: '2026-10-20' })
    await avulsa({ descricao: 'Perdida', grupo: 'servico', valor_previsto: 400, data_vencimento: '2026-10-08' })
    await q(`UPDATE receitas_avulsas SET perdido_em = NOW(), perdido_motivo = 'inadimplente' WHERE tenant_id = $1 AND descricao = 'Perdida'`, [t])
  })

  afterAll(async () => {
    if (!pool) return
    for (const tb of ['receitas_avulsas', 'receita_titulos', 'custos', 'marca_condicoes_comerciais', 'marcas', 'clientes']) {
      await q(`DELETE FROM ${tb} WHERE tenant_id = ANY($1::uuid[])`, [[t, t2]]).catch(() => {})
    }
    await q('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[t, t2]]).catch(() => {})
    await pool.end()
  })

  it('painel de outubro: caixa, recebido/pago, a receber/a pagar com atrasados e projetado', async () => {
    const p = await calcularPainelMes(pool, { tenantId: t, mes: '2026-10', hoje: HOJE })
    expect(p).toMatchObject({
      mes: '2026-10', hoje: HOJE, fim_mes: '2026-10-31', mes_relativo: 'corrente', configurado: true,
      data_corte: '2026-09-01', saldo_abertura: 1000,
      // 1000 + (1000 fixo + 5000 aporte) − 60
      caixa: { saldo_atual: 6940, ate: HOJE },
      recebido_mes: { total: 6000, receitas: 1000, aportes: 5000 },
      pago_mes: { total: 60 },
      // fixo de agosto (1000, venceu 05/09) + consultoria B (800, vence 20/10); a perdida fica de fora
      a_receber: { no_mes: 800, atrasado_anterior: 1000, total: 1800, qtd: 2, atrasados: { qtd: 1, valor: 1000 } },
      a_pagar: { no_mes: 150, atrasado_anterior: 80, total: 230, qtd: 2, atrasados: { qtd: 1, valor: 80 } },
      projetado_fim_mes: 8510,
      projecao_comissao: null,
      projetado_fim_mes_ritmo: null,
    })
    // competência (referência, perdida conta cheia): fixo de outubro (vence em novembro, fora do a receber) + 800 + 400
    expect(p.competencia.receita).toEqual({ previsto: 1000 + 800 + 400, realizado: 0 }) // o fixo pago em 03/10 é competência de setembro
    const caixa = await calcularCaixa(pool, { tenantId: t, hoje: HOJE })
    expect(p.projetado_fim_mes).toBe(caixa.saldo_projetado_fim_mes)
    expect(p.caixa.saldo_atual).toBe(caixa.saldo_atual)
  })

  it('mês passado e mês futuro', async () => {
    const set = await calcularPainelMes(pool, { tenantId: t, mes: '2026-09', hoje: HOJE })
    expect(set).toMatchObject({ mes_relativo: 'passado', fim_mes: '2026-09-30', caixa: { ate: '2026-09-30', saldo_atual: 1000 }, projecao_comissao: null })
    expect(set.a_receber).toMatchObject({ no_mes: 1000, atrasado_anterior: 0 }) // fixo de agosto venceu 05/09
    const nov = await calcularPainelMes(pool, { tenantId: t, mes: '2026-11', hoje: HOJE })
    expect(nov).toMatchObject({ mes_relativo: 'futuro', caixa: { ate: HOJE, saldo_atual: 6940 } })
    expect(nov.a_receber.atrasado_anterior).toBe(1800) // tudo que ficou aberto até outubro, + fixo de outubro vence 05/11 (no mês)
    expect(nov.a_receber.no_mes).toBe(1000)
  })

  it('tenant explícito: outro tenant sem corte → zeros e configurado=false', async () => {
    const p = await calcularPainelMes(pool, { tenantId: t2, mes: '2026-10', hoje: HOJE })
    expect(p).toMatchObject({
      configurado: false, caixa: { saldo_atual: 0 }, projetado_fim_mes: 0,
      a_receber: { total: 0, qtd: 0 }, a_pagar: { total: 0, qtd: 0 },
    })
  })
})
