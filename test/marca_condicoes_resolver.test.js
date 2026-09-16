import { describe, expect, it } from 'vitest'
import {
  calcularCobrancaCondicao,
  marcaCondicaoAtSql,
  resolveMarcaCondicao,
  somarCobrancasCondicao,
} from '../src/lib/marca-condicoes.js'

const baseline = {
  inicio_vigencia: '1900-01-01', fixo_mensal: '900.00',
  comissao_franquia_pct: '4.00', tipo_cobranca: 'fixo_mais_comissao',
}
const agosto = {
  inicio_vigencia: '2026-08-01', fixo_mensal: '1000.00',
  comissao_franquia_pct: '5.00', tipo_cobranca: 'fixo_mais_comissao',
}
const setembro = {
  inicio_vigencia: '2026-09-01', fixo_mensal: '1200.00',
  comissao_franquia_pct: '8.00', tipo_cobranca: 'fixo_mais_comissao',
}

describe('marca-condicoes temporal resolver', () => {
  it('resolve 31/08 e 01/09 pelo fato gerador e atravessa ano', () => {
    expect(resolveMarcaCondicao([baseline, agosto, setembro], '2026-08-31')).toBe(agosto)
    expect(resolveMarcaCondicao([baseline, agosto, setembro], '2026-09-01')).toBe(setembro)
    expect(resolveMarcaCondicao([baseline, agosto], '2027-01-10')).toBe(agosto)
  })

  it('não transforma condição ausente em zero e ignora versão cancelada', () => {
    expect(resolveMarcaCondicao([], '2026-08-31')).toBeNull()
    expect(resolveMarcaCondicao([{ ...agosto, cancelled_at: '2026-09-02' }], '2026-08-31')).toBeNull()
  })

  it('fecha em centavos e soma meses com versões diferentes', () => {
    const agostoValor = calcularCobrancaCondicao({ condition: agosto, gmv: 10000 })
    const setembroValor = calcularCobrancaCondicao({ condition: setembro, gmv: 10000 })
    expect(agostoValor).toMatchObject({ fixo: 1000, comissao: 500, total: 1500, totalCents: 150000 })
    expect(setembroValor).toMatchObject({ fixo: 1200, comissao: 800, total: 2000 })
    expect(somarCobrancasCondicao([agostoValor, setembroValor])).toEqual({ total: 3500, totalCents: 350000 })
  })

  it('aplica fixo_ou_comissao por competência, nunca no intervalo inteiro', () => {
    const agostoValor = calcularCobrancaCondicao({ condition: { ...agosto, tipo_cobranca: 'fixo_ou_comissao' }, gmv: 10000 })
    const setembroValor = calcularCobrancaCondicao({ condition: { ...setembro, tipo_cobranca: 'fixo_ou_comissao' }, gmv: 10000 })
    expect(somarCobrancasCondicao([agostoValor, setembroValor])).toEqual({ total: 2200, totalCents: 220000 })
  })

  it('gera SQL parametrizado pela data do fato gerador', () => {
    const sql = marcaCondicaoAtSql({ tenantSql: '$3', marcaSql: 'l.marca_id', dateSql: "l.iniciado_em AT TIME ZONE 'America/Sao_Paulo'" })
    expect(sql).toContain('inicio_vigencia <= (l.iniciado_em AT TIME ZONE')
    expect(sql).toContain('cancelled_at IS NULL')
    expect(sql).toContain('ORDER BY mc.inicio_vigencia DESC')
    expect(sql).not.toMatch(/CURRENT_DATE|NOW\(\)/)
  })
})
