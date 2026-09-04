import { describe, it, expect } from 'vitest'

import { apresentadoraHorasSql, apresentadoraHorasPresencaSql } from '../src/lib/metric-sql.js'

/**
 * Duas réguas, de propósito. A de PRODUTIVIDADE (apresentadoraHorasSql) alimenta GMV/h, meta e
 * ranking e usa `percentual_rateio` — está certa para o que faz. A de PRESENÇA não pode usar
 * essa coluna crua: no rateio pós-live por valor o percentual sai de gmv/gmvTotal
 * (live-rateio.js, distribuirPercentuais), então quem ficou 6h no ar e vendeu R$ 0 recebe
 * percentual 0,00, vira 0 hora e o painel de assiduidade a acusa de não ter aparecido.
 *
 * Não há Postgres neste ambiente (a suíte inteira mocka db.query), então o que estes testes
 * travam é a FORMA da expressão. É o que impede a regressão real que se teme aqui: alguém
 * "unificar" as duas de novo, ou soltar o percentual da guarda de rateio planejado.
 */
describe('apresentadoraHorasPresencaSql', () => {
  const presenca = apresentadoraHorasPresencaSql()

  it('não é a mesma expressão da régua de dinheiro', () => {
    expect(presenca).not.toBe(apresentadoraHorasSql())
    // O degrau de papel='principal' é da régua de dinheiro; aqui presença não depende de papel.
    expect(apresentadoraHorasSql()).toContain("papel = 'principal'")
    expect(presenca).not.toContain("papel = 'principal'")
  })

  it('segundos_rateio = 0 é ausência de informação, não presença de zero', () => {
    // Zero ali vem de live importada com encerrado_em = iniciado_em, ou de campo em branco.
    // Sem o NULLIF ele ganha do resto da cascata e zera o dia inteiro.
    expect(presenca).toContain('NULLIF(ap_v2.segundos_rateio, 0) / 3600.0')
  })

  it('só aceita percentual_rateio quando o rateio é PLANEJADO (gmv_rateado IS NULL)', () => {
    const usos = presenca.match(/percentual_rateio/g) ?? []
    expect(usos).toHaveLength(1)
    expect(presenca).toMatch(/gmv_rateado IS NULL[\s\S]*?percentual_rateio \/ 100\.0/)
  })

  it('o turno da agenda vem antes do percentual: é tempo de calendário, não de rateio', () => {
    const posTurno = presenca.indexOf('turno.horas_turno')
    const posPercentual = presenca.indexOf('percentual_rateio')
    expect(posTurno).toBeGreaterThan(-1)
    expect(posTurno).toBeLessThan(posPercentual)
    // Capado pela live: o plano não pode inventar hora que não houve.
    expect(presenca).toContain('LEAST(turno.horas_turno')
  })

  it('duração ausente ou negativa vira 0, nunca 24h nem hora negativa', () => {
    // LEAST(NULL, 24.0) é 24.0 no Postgres (LEAST ignora NULL): sem a guarda explícita, uma
    // live sem encerrado_em creditaria 24h, e encerrado_em < iniciado_em (migration 107
    // documenta o caso em produção) creditaria hora negativa, que subtrai as horas de outra
    // live do mesmo dia e fabrica vermelho.
    const guardas = presenca.match(/WHEN COALESCE\(l\.encerrado_em, l\.previsto_fim\) > l\.iniciado_em/g) ?? []
    expect(guardas.length).toBeGreaterThanOrEqual(4)
    expect(presenca).not.toMatch(/COALESCE\(\s*LEAST\(EXTRACT/)
  })

  it('aceita alias customizado sem vazar o padrão', () => {
    const custom = apresentadoraHorasPresencaSql({ live: 'lv', rateio: 'r', turno: 't' })
    expect(custom).toContain('r.segundos_rateio')
    expect(custom).toContain('t.horas_turno')
    expect(custom).toContain('lv.encerrado_em')
    expect(custom).not.toContain('ap_v2.')
  })
})

describe('apresentadoraHorasPresencaSql — armadilhas do LEAST com NULL', () => {
  it('o degrau do turno é guardado por IS NOT NULL, senão engole os degraus seguintes', () => {
    // LEAST(NULL, 5.0) é 5.0 no Postgres. Sem a guarda, live sem turno na agenda cairia no
    // degrau do turno com a duração CHEIA e o rateio planejado (degrau 3) nunca rodaria —
    // trocando o sub-crédito da co-apresentação por super-crédito no revezamento sequencial.
    const presenca = apresentadoraHorasPresencaSql()
    expect(presenca).toMatch(/CASE WHEN turno\.horas_turno IS NOT NULL[\s\S]*?LEAST\(turno\.horas_turno/)
  })
})
