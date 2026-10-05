import { describe, expect, it, vi } from 'vitest'
import {
  listarEventosPerdaDre,
  montarDre,
  montarDreDetalhe,
  totalizarLancamentos,
  valorEncerrado,
} from '../src/services/financeiro-agregador.js'

const receita = (overrides = {}) => ({
  natureza: 'receita',
  origem: 'marca_fixo',
  id: '11111111-1111-1111-1111-111111111111',
  competencia: '2026-09-01',
  valor_previsto: 1000,
  valor_pago: 200,
  status: 'perdido',
  perdido_em: '2026-10-10T12:00:00.000Z',
  virtual: false,
  valor_perdido: 800,
  ...overrides,
})

const evento = (overrides = {}) => ({
  tipo: 'perda',
  origem_tipo: 'receita_titulo',
  origem_id: '11111111-1111-1111-1111-111111111111',
  valor: '800.00',
  competencia_obrigacao: '2026-09-01',
  mes_registro: '2026-10',
  ...overrides,
})

describe('FIN-02 no DRE', () => {
  it('reconhece perda no mês do registro sem reescrever a competência de origem', () => {
    const { meses } = montarDre({
      meses: ['2026-09', '2026-10'],
      itens: [receita()],
      eventosPerda: [evento()],
    })
    expect(meses[0].perdas.receita.valor).toBe(0)
    expect(meses[0].resultado.previsto).toBe(1000)
    expect(meses[1].perdas.receita.valor).toBe(800)
    expect(meses[1].resultado.previsto).toBe(-800)
  })

  it('reversão produz o efeito inverso no próprio mês', () => {
    const { meses } = montarDre({
      meses: ['2026-10', '2026-11'],
      itens: [],
      eventosPerda: [
        evento(),
        evento({ tipo: 'reversao', mes_registro: '2026-11', valor: '300.00' }),
      ],
    })
    expect(meses[0].perdas.receita.valor).toBe(800)
    expect(meses[1].perdas.receita.valor).toBe(-300)
    expect(meses[1].resultado.previsto).toBe(300)
  })

  it('mantém semântica legada quando não há evento', () => {
    const { meses: [setembro] } = montarDre({ meses: ['2026-09'], itens: [receita({ valor_perdido: null })] })
    expect(setembro.perdas.receita.valor).toBe(800)
    expect(setembro.resultado.previsto).toBe(200)
  })

  it('perda parcial reduz o aberto e entra na margem do mês de registro', () => {
    const item = receita({ status: 'atrasado', perdido_em: null, valor_perdido: 300 })
    expect(valorEncerrado(item)).toBe(300)
    const totais = totalizarLancamentos([item])
    expect(totais.receita).toMatchObject({ perdido: 300, atrasado: 500 })
    const detalhe = montarDreDetalhe({
      mes: '2026-10', itens: [item], eventosPerda: [evento({ valor: '300.00' })],
    })
    expect(detalhe.anterior.resultado.previsto).toBe(1000)
    expect(detalhe.atual.resultado.previsto).toBe(-300)
    expect(detalhe.margem.contribuicao.previsto).toBe(-300)
  })

  it('projeção FIN-02 nunca é contada como perda legada', () => {
    const item = receita({ valor_perdido: 500, perdido_em: null })
    const eventos = [evento({ valor: '200.00' })]
    const { meses: [setembro, outubro] } = montarDre({
      meses: ['2026-09', '2026-10'], itens: [item], eventosPerda: eventos,
    })
    expect(setembro.perdas.receita.valor).toBe(0)
    expect(setembro.resultado.previsto).toBe(1000)
    expect(outubro.perdas.receita.valor).toBe(200)
    expect(outubro.resultado.previsto).toBe(-200)
  })

  it('reversão posterior preserva o resultado histórico', () => {
    const antes = montarDre({
      meses: ['2026-09', '2026-10'], itens: [receita({ valor_perdido: 800 })],
      eventosPerda: [evento()],
    })
    const depois = montarDre({
      meses: ['2026-09', '2026-10', '2026-11'],
      itens: [receita({ valor_perdido: 500 })],
      eventosPerda: [evento(), evento({ tipo: 'reversao', mes_registro: '2026-11', valor: '300.00' })],
    })
    expect(depois.meses.slice(0, 2)).toEqual(antes.meses)
    expect(depois.meses[2].resultado.previsto).toBe(300)
  })

  it('evento evita dupla contagem do encerramento legado e preserva a trilha de origem', () => {
    const detalhe = montarDreDetalhe({
      mes: '2026-10',
      itens: [receita()],
      eventosPerda: [evento()],
    })
    expect(detalhe.atual.perdas.receita.valor).toBe(800)
    expect(detalhe.receita.eventos_perda).toEqual([evento()])
    expect(detalhe.receita.eventos_perda[0].competencia_obrigacao).toBe('2026-09-01')
  })

  it('consulta é tenant-scoped e cobre registro ou competência da obrigação', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    await listarEventosPerdaDre({ query }, {
      tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      inicio: '2026-09',
      fim: '2026-10',
    })
    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain('e.tenant_id = $1::uuid')
    expect(sql).toContain("AT TIME ZONE 'America/Sao_Paulo'")
    expect(sql).toContain('e.competencia_obrigacao >= $2::date')
    expect(sql).toContain("a.id IS NOT NULL AND a.grupo <> 'aporte'")
    expect(params).toEqual([
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '2026-09-01',
      '2026-10-01',
    ])
  })
})
