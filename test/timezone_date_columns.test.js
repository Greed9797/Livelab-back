// Regressão do bug 01/06: coluna DATE do Postgres era parseada pelo node-pg
// como Date JS à meia-noite UTC (Railway); convertida para America/Sao_Paulo
// voltava um dia — vendas_atribuidas.data de SEGUNDA era tratada como DOMINGO
// no recálculo e gravava 2% de fim de semana em dia útil.
//
// Fix: pg.types.setTypeParser(1082, v => v) em src/plugins/db.js — DATE volta
// como string 'YYYY-MM-DD' e os helpers de timezone.js tratam como
// data-calendário de SP. Estes testes cravam esse contrato.

import { describe, expect, it, vi } from 'vitest'

import { isWeekendInSaoPaulo, saoPauloDateInput } from '../src/lib/timezone.js'
import { isFimDeSemanaSP } from '../src/services/comissao.js'
import { calcularComissoesAtribuidas } from '../src/routes/vendas_atribuidas.js'

const TENANT = 'tenant-uuid-1'

describe('timezone.js com string DATE (YYYY-MM-DD)', () => {
  it('2026-06-01 (segunda) NÃO é fim de semana', () => {
    expect(isWeekendInSaoPaulo('2026-06-01')).toBe(false)
  })

  it('2026-06-06 (sábado) é fim de semana', () => {
    expect(isWeekendInSaoPaulo('2026-06-06')).toBe(true)
  })

  it('2026-06-07 (domingo) é fim de semana', () => {
    expect(isWeekendInSaoPaulo('2026-06-07')).toBe(true)
  })

  it('saoPauloDateInput não shifta data-calendário', () => {
    expect(saoPauloDateInput('2026-06-01')).toBe('2026-06-01')
  })

  it('isFimDeSemanaSP (services/comissao.js) segue o mesmo contrato', () => {
    expect(isFimDeSemanaSP('2026-06-01')).toBe(false)
    expect(isFimDeSemanaSP('2026-06-06')).toBe(true)
  })
})

// Mock roteado por trecho de SQL, padrão dos testes de comissão: o recálculo
// consulta marcas, GMV do mês, faixas próprias e faixas default do tenant.
function buildRoutedQueryMock({ faixaPct = 5 } = {}) {
  return vi.fn(async (sql) => {
    const s = String(sql)
    if (s.includes('FROM marcas')) {
      return { rows: [{ comissao_franquia_pct: '10', comissao_franqueadora_pct: '5' }] }
    }
    if (s.includes('FROM vendas_atribuidas')) {
      return { rows: [{ gmv_mes: '0' }] }
    }
    if (s.includes('FROM apresentadora_comissao_faixas')) {
      return { rows: [{ comissao_pct: String(faixaPct) }] }
    }
    if (s.includes('FROM tenant_comissao_faixas_default')) {
      return { rows: [] }
    }
    return { rows: [] }
  })
}

describe('recálculo com venda.data string (caminho do bug 01/06)', () => {
  it('segunda-feira 2026-06-01 usa a faixa, NÃO o override de 2% de fim de semana', async () => {
    const query = buildRoutedQueryMock({ faixaPct: 5 })
    const comissoes = await calcularComissoesAtribuidas({ query }, {
      tenantId: TENANT,
      marcaId: 'marca-1',
      apresentadoraId: 'apresentadora-1',
      origem: 'live',
      origemId: 'live-1',
      data: '2026-06-01',
      gmv: 1000,
    })

    // 5% da faixa — se o bug voltar (segunda lida como domingo), vira 20 (2%).
    expect(comissoes.comissao_apresentadora).toBe(50)
    // O caminho de faixa foi consultado (não curto-circuitou no override de fds).
    expect(query.mock.calls.some(([sql]) => String(sql).includes('apresentadora_comissao_faixas'))).toBe(true)
  })

  it('sábado 2026-06-06 aplica o override de 2% e nem consulta faixas', async () => {
    const query = buildRoutedQueryMock({ faixaPct: 5 })
    const comissoes = await calcularComissoesAtribuidas({ query }, {
      tenantId: TENANT,
      marcaId: 'marca-1',
      apresentadoraId: 'apresentadora-1',
      origem: 'live',
      origemId: 'live-1',
      data: '2026-06-06',
      gmv: 1000,
    })

    expect(comissoes.comissao_apresentadora).toBe(20)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('apresentadora_comissao_faixas'))).toBe(false)
  })
})
