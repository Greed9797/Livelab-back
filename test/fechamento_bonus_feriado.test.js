import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'

import { remuneracaoApresentadorasRoutes } from '../src/routes/remuneracao_apresentadoras.js'
import { blocosBonusDoDia, buscarFechamentoApresentadoras } from '../src/services/remuneracao-apresentadoras.js'
import { feriadosDoPeriodo, tipoDiaEspecial } from '../src/services/feriados.js'
import { resolvePresenterCommissionPct } from '../src/services/presenter-commission.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const ana = '22222222-2222-4222-8222-222222222222'

// Responde cada leitura do fechamento pelo conteúdo do SQL (a ordem é detalhe).
function fechamentoDb({ fixos = [], comissoes = [], adicionais = [], horas = [], vendasDia = [], feriados = [] }) {
  return {
    query: vi.fn(async (sql) => {
      if (sql.includes('FROM feriados')) return { rows: feriados }
      if (sql.includes('FROM apresentadora_remuneracao_adicionais')) return { rows: adicionais }
      if (sql.includes('AS horas')) return { rows: horas }
      if (sql.includes("va.origem = 'live'") && sql.includes('AS gmv')) return { rows: vendasDia }
      if (sql.includes('FROM vendas_atribuidas')) return { rows: comissoes }
      if (sql.includes('FROM apresentadoras a')) return { rows: fixos }
      throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`)
    }),
  }
}

describe('bônus de fim de semana/feriado e meta de horas (a partir de 2026-10)', () => {
  it('conta blocos fechados de 4h, com tolerância de medição', () => {
    expect([0, 3.99, 3.9999, 4, 7.9, 8, 12.5].map(blocosBonusDoDia)).toEqual([0, 0, 1, 1, 1, 2, 3])
  })

  it('fecha novembro sem lançamento manual: bônus automático, meta de horas e diária manual fora do total', async () => {
    const db = fechamentoDb({
      fixos: [{ apresentadora_id: ana, nome: 'Ana', valor: '2700.00', data_inicio: null, data_fim: null }],
      comissoes: [{ apresentadora_id: ana, nome: 'Ana', valor: '1000.00' }],
      adicionais: [
        { id: 'a1', apresentadora_id: ana, nome: 'Ana', tipo: 'fim_de_semana', descricao: 'Sábado', data_referencia: '2026-11-07', valor: '100.00' },
        { id: 'a2', apresentadora_id: ana, nome: 'Ana', tipo: 'bonificacao', descricao: 'Ajuste: troca de cabine', data_referencia: null, valor: '50.00' },
      ],
      horas: [
        { apresentadora_id: ana, nome: 'Ana', dia: '2026-11-07', horas: '8.5000' }, // sábado: 2 blocos
        { apresentadora_id: ana, nome: 'Ana', dia: '2026-11-02', horas: '3.9000' }, // Finados: 0 bloco
        { apresentadora_id: ana, nome: 'Ana', dia: '2026-11-03', horas: '6.0000' },
        { apresentadora_id: ana, nome: 'Ana', dia: '2026-11-20', horas: '5.0000' }, // feriado desligado pela unidade
      ],
      vendasDia: [{ apresentadora_id: ana, dia: '2026-11-07', gmv: '5000.00', comissao: '100.00' }],
      feriados: [{ data: '2026-11-20', nome: 'Consciência Negra', ativo: false }],
    })
    const { apresentadoras: [row], totais } = await buscarFechamentoApresentadoras(db, { tenantId, mes: '2026-11' })

    expect(row.bonus_fim_de_semana).toBe(200)
    expect(row.adicionais).toBe(50)
    expect(row.total).toBe(2700 + 1000 + 200 + 50)
    expect(totais.total).toBe(row.total)
    expect(row.dias_especiais).toEqual([
      { data: '2026-11-02', tipo: 'feriado', feriado: 'Finados', horas: 3.9, blocos_4h: 0, bonus: 0, gmv: 0, comissao: 0 },
      { data: '2026-11-07', tipo: 'sabado', feriado: null, horas: 8.5, blocos_4h: 2, bonus: 200, gmv: 5000, comissao: 100 },
    ])
    // 21 dias seg–sex − Finados (20/11 desligado volta a ser útil) = 20 × 6h.
    expect(row.horas).toEqual({ dias_uteis: 20, meta: 120, realizadas_dias_uteis: 11, dias_especiais: 12.4, bateu_meta: false })
    expect(row.extras.find((e) => e.id === 'a1').substituido_por_bonus).toBe(true)
    expect(row.extras.find((e) => e.id === 'a2').substituido_por_bonus).toBe(false)
  })

  it('mês anterior ao bônus continua pagando a diária manual e não gera bônus', async () => {
    const db = fechamentoDb({
      fixos: [{ apresentadora_id: ana, nome: 'Ana', valor: '2700.00', data_inicio: null, data_fim: null }],
      adicionais: [{ id: 'a1', apresentadora_id: ana, nome: 'Ana', tipo: 'fim_de_semana', descricao: 'Sábado', data_referencia: '2026-09-05', valor: '100.00' }],
      horas: [{ apresentadora_id: ana, nome: 'Ana', dia: '2026-09-05', horas: '8' }],
    })
    const { apresentadoras: [row] } = await buscarFechamentoApresentadoras(db, { tenantId, mes: '2026-09' })
    expect(row).toMatchObject({ bonus_fim_de_semana: 0, adicionais: 100, total: 2800 })
  })

  it('outubro/2026 paga R$100 por dia de sábado, domingo ou feriado com live, sem contar blocos', async () => {
    const db = fechamentoDb({
      fixos: [{ apresentadora_id: ana, nome: 'Ana', valor: '2700.00', data_inicio: null, data_fim: null }],
      horas: [
        { apresentadora_id: ana, nome: 'Ana', dia: '2026-10-24', horas: '3.4667' }, // sábado
        { apresentadora_id: ana, nome: 'Ana', dia: '2026-10-11', horas: '8.9' }, // domingo
        { apresentadora_id: ana, nome: 'Ana', dia: '2026-10-12', horas: '4.0167' }, // Nossa Senhora Aparecida
      ],
    })
    const { apresentadoras: [row] } = await buscarFechamentoApresentadoras(db, { tenantId, mes: '2026-10' })
    expect(row.bonus_fim_de_semana).toBe(300)
    expect(row.dias_especiais.map((d) => [d.data, d.blocos_4h, d.bonus])).toEqual([['2026-10-11', null, 100], ['2026-10-12', null, 100], ['2026-10-24', null, 100]])
  })

  it('não lança diária manual de fim de semana a partir de novembro', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const app = Fastify()
    app.decorate('requirePapel', () => async (request) => { request.user = { tenant_id: tenantId, sub: ana, papel: 'financeiro' } })
    app.decorate('withTenant', async (_t, fn) => fn({ query }))
    app.register(remuneracaoApresentadorasRoutes)
    const res = await app.inject({ method: 'POST', url: '/v1/financeiro/adicionais-apresentadoras', payload: {
      mes: '2026-11', apresentadora_id: ana, tipo: 'fim_de_semana', descricao: 'Sábado', data_referencia: '2026-11-07',
    } })
    expect(res.statusCode).toBe(400)
    expect(query).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('feriados', () => {
  it('soma calendário embutido e ajustes da unidade', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [
      { data: '2026-11-20', nome: 'Consciência Negra', ativo: false },
      { data: '2026-11-24', nome: 'Aniversário da unidade', ativo: true },
    ] }) }
    const mapa = await feriadosDoPeriodo(db, tenantId, '2026-11-01', '2026-11-30')
    expect([...mapa.keys()]).toEqual(['2026-11-02', '2026-11-15', '2026-11-24'])
    expect(tipoDiaEspecial('2026-11-24', mapa)).toBe('feriado')
    expect(tipoDiaEspecial('2026-11-15', mapa)).toBe('feriado') // domingo + feriado → feriado
    expect(tipoDiaEspecial('2026-11-21', mapa)).toBe('sabado')
    expect(tipoDiaEspecial('2026-11-22', mapa)).toBe('domingo')
    expect(tipoDiaEspecial('2026-11-20', mapa)).toBeNull()
  })
})

describe('comissão de 2% em feriado (só live)', () => {
  const bandas = { presenterBands: [], defaultBands: [], gmvExcludingOrigin: 0 }
  const base = { tenantId, apresentadoraId: ana, origemId: null, gmv: 1000 }

  it('live em feriado paga 2%; vídeo no feriado segue a escada', async () => {
    const db = { query: vi.fn() }
    const feriados = new Map([['2026-11-02', 'Finados']])
    expect(await resolvePresenterCommissionPct(db, { ...base, origem: 'live', data: '2026-11-02', monthlyContext: { ...bandas, feriados } })).toBe(2)
    expect(await resolvePresenterCommissionPct(db, { ...base, origem: 'video', data: '2026-11-02', monthlyContext: { ...bandas, feriados } })).not.toBe(2)
    expect(await resolvePresenterCommissionPct(db, { ...base, origem: 'live', data: '2026-11-03', monthlyContext: { ...bandas, feriados } })).not.toBe(2)
    expect(db.query).not.toHaveBeenCalled()
  })

  it('feriado desligado pela unidade volta à escada', async () => {
    const db = { query: vi.fn() }
    expect(await resolvePresenterCommissionPct(db, { ...base, origem: 'live', data: '2026-11-20', monthlyContext: { ...bandas, feriados: new Map() } })).not.toBe(2)
  })

  it('sem contexto mensal consulta os feriados da unidade', async () => {
    const db = { query: vi.fn(async (sql) => (sql.includes('FROM feriados')
      ? { rows: [{ data: '2026-11-24', nome: 'Municipal', ativo: true }] }
      : { rows: [] })) }
    expect(await resolvePresenterCommissionPct(db, { ...base, origem: 'live', data: '2026-11-24' })).toBe(2)
  })
})
