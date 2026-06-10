/**
 * Testes do motor de status operacional — src/services/status_operacional.js
 *
 * Cobre:
 *  1. Status CRÍTICO — gmv=0 com horas >= limiar
 *  2. Status CRÍTICO — problema reportado
 *  3. Status DADOS INCOMPLETOS — campos obrigatórios ausentes
 *  4. Status ATENÇÃO — gmv/h abaixo da meta
 *  5. Status OK — gmv/h >= meta
 *  6. Diagnóstico de funil — tráfego, CTR, conversão, ticket
 */

import { describe, expect, it } from 'vitest'
import { calcularStatusOperacional, DEFAULT_THRESHOLDS } from '../src/services/status_operacional.js'

// Entrada base com todos os campos OK
const BASE_OK = {
  metaGmvHora:        500,
  margemPct:          30,
  comissaoLivelabPct: 10,
  horas:              3,
  gmv:                2000,
  pedidos:            40,
  views:              5000,
  clicks:             500,
  problemaReportado:  null,
}

describe('calcularStatusOperacional', () => {
  // ── 1. Crítico: gmv zero após horas ──────────────────────────────────────
  it('gmv=0 após >= 1h → CRÍTICO', () => {
    const r = calcularStatusOperacional({
      ...BASE_OK,
      gmv: 0,
      horas: 1,
    })
    expect(r.status).toBe('critico')
    expect(r.motivos.length).toBeGreaterThan(0)
    expect(r.motivos[0]).toMatch(/GMV zero/)
  })

  it('gmv=0 mas horas < limiar → NÃO crítico', () => {
    const r = calcularStatusOperacional({
      ...BASE_OK,
      gmv: 0,
      horas: 0.5,
    })
    expect(r.status).not.toBe('critico')
  })

  // ── 2. Crítico: problema reportado ───────────────────────────────────────
  it('problema reportado → CRÍTICO independente de gmv', () => {
    const r = calcularStatusOperacional({
      ...BASE_OK,
      problemaReportado: 'Falha na conexão TikTok',
    })
    expect(r.status).toBe('critico')
    expect(r.motivos[0]).toMatch(/Falha na conexão TikTok/)
  })

  it('problema vazio (string vazia) → não crítico por problema', () => {
    const r = calcularStatusOperacional({ ...BASE_OK, problemaReportado: '' })
    expect(r.status).toBe('ok')
  })

  // ── 3. Dados incompletos ──────────────────────────────────────────────────
  it('metaGmvHora null → dados_incompletos', () => {
    const r = calcularStatusOperacional({ ...BASE_OK, metaGmvHora: null })
    expect(r.status).toBe('dados_incompletos')
    expect(r.motivos).toContain('meta de GMV/hora não configurada')
  })

  it('clicks null → dados_incompletos', () => {
    const r = calcularStatusOperacional({ ...BASE_OK, clicks: null })
    expect(r.status).toBe('dados_incompletos')
    expect(r.motivos).toContain('cliques não medidos')
  })

  it('horas null → dados_incompletos', () => {
    const r = calcularStatusOperacional({ ...BASE_OK, horas: null })
    expect(r.status).toBe('dados_incompletos')
  })

  it('todos os campos null → dados_incompletos com múltiplos motivos', () => {
    const r = calcularStatusOperacional({
      metaGmvHora: null, margemPct: null, comissaoLivelabPct: null,
      horas: null, gmv: null, pedidos: null, views: null, clicks: null,
      problemaReportado: null,
    })
    expect(r.status).toBe('dados_incompletos')
    expect(r.motivos.length).toBeGreaterThan(3)
  })

  // ── 4. Atenção ────────────────────────────────────────────────────────────
  it('gmv/h abaixo da meta → ATENÇÃO', () => {
    const r = calcularStatusOperacional({
      ...BASE_OK,
      gmv: 900,   // 300/h < 500 meta
      horas: 3,
    })
    expect(r.status).toBe('atencao')
    expect(r.motivos[0]).toMatch(/abaixo da meta/)
  })

  // ── 5. OK ─────────────────────────────────────────────────────────────────
  it('gmv/h >= meta → OK', () => {
    const r = calcularStatusOperacional({
      ...BASE_OK,
      gmv: 1500,  // 500/h == meta exata
      horas: 3,
    })
    expect(r.status).toBe('ok')
    expect(r.motivos[0]).toMatch(/atingiu a meta/)
  })

  it('gmv/h acima da meta → OK', () => {
    const r = calcularStatusOperacional({
      ...BASE_OK,
      gmv: 3000,  // 1000/h >> 500 meta
      horas: 3,
    })
    expect(r.status).toBe('ok')
  })

  // ── 6. Diagnóstico de funil ───────────────────────────────────────────────
  it('views por hora baixo → diagnóstico de tráfego', () => {
    const r = calcularStatusOperacional({
      ...BASE_OK,
      views: 100,     // 33/h << 500 limiar
      horas: 3,
      clicks: 5,
      pedidos: 1,
      gmv: 0,         // força crítico p/ exibir diagnóstico
    })
    expect(r.status).toBe('critico')
    expect(r.diagnostico).toMatch(/Tráfego baixo/)
  })

  it('CTR baixo → diagnóstico de oferta', () => {
    // views=10000, clicks=10 → CTR = 0.001 < 0.02
    const r = calcularStatusOperacional({
      ...BASE_OK,
      views: 10000,
      clicks: 10,
      pedidos: 1,
      gmv: 0,
      horas: 1,
    })
    expect(r.diagnostico).toMatch(/CTR baixo/)
  })

  // ── Resultado sem diagnostico quando funil está saudável ──────────────────
  it('funil saudável → diagnostico null em status OK', () => {
    const r = calcularStatusOperacional(BASE_OK)
    expect(r.diagnostico).toBeNull()
    expect(r.proxima_acao).toBeNull()
  })

  // ── Thresholds customizados ───────────────────────────────────────────────
  it('threshold customizado horasMinCritico = 0.5', () => {
    const r = calcularStatusOperacional(
      { ...BASE_OK, gmv: 0, horas: 0.7 },
      { horasMinCritico: 0.5 },
    )
    expect(r.status).toBe('critico')
  })
})
