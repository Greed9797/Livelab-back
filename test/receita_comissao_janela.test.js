import { describe, expect, it, vi } from 'vitest'

import { normalizarVencimentoCondicao, resolverVencimentoCondicao } from '../src/lib/marca-condicoes.js'
import { marcaResolveLateralSql } from '../src/lib/marca-sql.js'
import {
  comissaoMarcaMensalSql,
  marcaFixoVigenciaSql,
  marcasCondicaoVigenteMesSql,
  receitaMarcaMensalSql,
} from '../src/lib/receita-marca-sql.js'
import { calcularReceitasComerciais } from '../src/services/receitas-comercial.js'

const tenantId = '00000000-0000-4000-8000-000000000001'

describe('janela de apuração da comissão (SQL)', () => {
  it('expõe comissao_janela_inicio_dia na resolução da marca e na condição vigente', () => {
    expect(marcaResolveLateralSql('$3')).toContain('comissao_janela_inicio_dia')
    const sql = receitaMarcaMensalSql()
    expect(sql).toContain('c.comissao_janela_inicio_dia')
    expect(sql).toContain('AS comissao_janela_inicio_dia')
    expect(marcasCondicaoVigenteMesSql()).toContain('AS comissao_janela_inicio_dia')
  })

  it('competência = mês do início da janela, fatos ampliados em 27 dias e filtro por competência', () => {
    const sql = comissaoMarcaMensalSql()
    expect(sql).toContain('make_interval(days => mc.comissao_janela_inicio_dia - 1)')
    expect(sql).toContain('make_interval(days => COALESCE(vc.comissao_janela_inicio_dia, 1) - 1)')
    expect(sql).toContain('($2::date + 27)')
    expect(sql).toContain("mes::date BETWEEN date_trunc('month', $1::date)::date AND date_trunc('month', $2::date)::date")
  })
})

describe('filtro de status (clientes cancelados/arquivados)', () => {
  it('fixo por vigência exclui inativa/arquivada sem data_fim (pausada continua cobrando)', () => {
    const sql = marcaFixoVigenciaSql()
    expect(sql).toContain("(m.status NOT IN ('inativa','arquivada') OR m.data_fim IS NOT NULL)")
    expect(sql).not.toContain("m.status = 'ativa'")
  })
  it('em apuração exige status ativa', () => {
    expect(marcasCondicaoVigenteMesSql()).toContain("m.status = 'ativa'")
  })
})

describe('config da condição: comissao_janela_inicio_dia', () => {
  it('aceita 1..28 (inclusive texto) e rejeita 0 e 29', () => {
    expect(normalizarVencimentoCondicao({ comissao_janela_inicio_dia: 16 })).toEqual({ comissao_janela_inicio_dia: 16 })
    expect(normalizarVencimentoCondicao({ comissao_janela_inicio_dia: '28' })).toEqual({ comissao_janela_inicio_dia: 28 })
    expect(() => normalizarVencimentoCondicao({ comissao_janela_inicio_dia: 0 })).toThrow(/entre 1 e 28/)
    expect(() => normalizarVencimentoCondicao({ comissao_janela_inicio_dia: 29 })).toThrow(/entre 1 e 28/)
  })
  it('resolver herda da condição anterior ou usa 1', () => {
    expect(resolverVencimentoCondicao({}, null).comissao_janela_inicio_dia).toBe(1)
    expect(resolverVencimentoCondicao({}, { comissao_janela_inicio_dia: 16 }).comissao_janela_inicio_dia).toBe(16)
    expect(resolverVencimentoCondicao({ comissao_janela_inicio_dia: 10 }, { comissao_janela_inicio_dia: 16 }).comissao_janela_inicio_dia).toBe(10)
  })
})

describe('calcularReceitasComerciais com janela', () => {
  it('janela 16 e vencimento dia 20: competência set vence 20/out', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      marca_id: 'm1', cliente_id: 'c1', marca_nome: 'Pure Up', cliente_nome: 'Pure Up', marca_tipo: 'cliente',
      competencia: '2026-09-01', comissao: '300', gmv: '3000', fixo: '0', fixo_cheio: '0', fator_meses: '0',
      tipo_cobranca: 'fixo_mais_comissao', comissao_franquia_pct: '10', condicao_id: 'k1',
      fixo_vencimento_dia: 5, fixo_vencimento_mes_offset: 1,
      comissao_vencimento_dia: 20, comissao_vencimento_mes_offset: 1, comissao_janela_inicio_dia: 16,
    }] })
    const itens = await calcularReceitasComerciais({ query }, { tenantId, inicio: '2026-09', fim: '2026-09' })
    expect(itens).toEqual([expect.objectContaining({ componente: 'comissao', competencia: '2026-09-01', data_vencimento: '2026-10-20' })])
  })
})
