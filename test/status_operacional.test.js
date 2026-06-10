import { describe, it, expect } from 'vitest'
import {
  calcularStatusOperacional,
  DEFAULT_THRESHOLDS,
} from '../src/services/status_operacional.js'

// ---------------------------------------------------------------------------
// Fixture: input completamente preenchido e saudável
// ---------------------------------------------------------------------------
const inputOk = {
  metaGmvHora: 1000,
  margemPct: 30,
  comissaoLivelabPct: 10,
  horas: 2,
  gmv: 3000,       // 1500/h > 1000/h
  pedidos: 30,
  views: 5000,
  clicks: 300,     // CTR 6 % > 2 %   conversão 10 % > 5 %   ticket 100 > 50
  problemaReportado: null,
}

// ---------------------------------------------------------------------------
// 1. Status CRÍTICO
// ---------------------------------------------------------------------------
describe('critico — gmv zero após live longa', () => {
  it('retorna critico quando gmv === 0 e horas >= limiar padrão (1h)', () => {
    // Arrange
    const input = { ...inputOk, gmv: 0, horas: 2 }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert
    expect(resultado.status).toBe('critico')
    expect(resultado.motivos.length).toBeGreaterThan(0)
    expect(resultado.motivos[0]).toMatch(/GMV zero/i)
  })

  it('NÃO retorna critico quando gmv === 0 mas horas < limiar (0.5h)', () => {
    // Arrange
    const input = { ...inputOk, gmv: 0, horas: 0.5 }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert — sem horas suficientes, não deve ser crítico por gmv=0
    expect(resultado.status).not.toBe('critico')
  })
})

describe('critico — problema reportado', () => {
  it('retorna critico quando problemaReportado está preenchido', () => {
    // Arrange
    const input = { ...inputOk, problemaReportado: 'checkout caiu' }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert
    expect(resultado.status).toBe('critico')
    expect(resultado.motivos[0]).toContain('checkout caiu')
  })

  it('problema reportado vence mesmo com dados incompletos', () => {
    // Arrange — sem meta, sem margem → seria dados_incompletos, mas problema reportado vence
    const input = {
      metaGmvHora: null,
      margemPct: null,
      comissaoLivelabPct: null,
      horas: null,
      gmv: null,
      pedidos: null,
      views: null,
      clicks: null,
      problemaReportado: 'checkout caiu',
    }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert
    expect(resultado.status).toBe('critico')
    expect(resultado.motivos[0]).toContain('checkout caiu')
  })

  it('string vazia NÃO dispara crítico', () => {
    // Arrange
    const input = { ...inputOk, problemaReportado: '   ' }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert
    expect(resultado.status).not.toBe('critico')
  })
})

// ---------------------------------------------------------------------------
// 2. Status DADOS INCOMPLETOS — cada campo isolado
// ---------------------------------------------------------------------------
describe('dados_incompletos', () => {
  it('retorna dados_incompletos quando metaGmvHora é null e lista o motivo', () => {
    // Arrange
    const input = { ...inputOk, metaGmvHora: null }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert
    expect(resultado.status).toBe('dados_incompletos')
    expect(resultado.motivos).toContain('meta de GMV/hora não configurada')
  })

  it('retorna dados_incompletos quando margemPct é null', () => {
    // Arrange
    const input = { ...inputOk, margemPct: null }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert
    expect(resultado.status).toBe('dados_incompletos')
    expect(resultado.motivos).toContain('margem não configurada')
  })

  it('retorna dados_incompletos quando comissaoLivelabPct é null', () => {
    // Arrange
    const input = { ...inputOk, comissaoLivelabPct: null }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert
    expect(resultado.status).toBe('dados_incompletos')
    expect(resultado.motivos).toContain('comissão LiveLab não configurada')
  })

  it('retorna dados_incompletos quando clicks é null', () => {
    // Arrange
    const input = { ...inputOk, clicks: null }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert
    expect(resultado.status).toBe('dados_incompletos')
    expect(resultado.motivos).toContain('cliques não informados')
  })

  it('retorna dados_incompletos quando horas é null', () => {
    // Arrange
    const input = { ...inputOk, horas: null }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert
    expect(resultado.status).toBe('dados_incompletos')
    expect(resultado.motivos).toContain('horas não informadas')
  })

  it('retorna dados_incompletos quando gmv é null', () => {
    // Arrange
    const input = { ...inputOk, gmv: null }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert
    expect(resultado.status).toBe('dados_incompletos')
    expect(resultado.motivos).toContain('GMV não informado')
  })

  it('lista TODOS os campos faltantes juntos', () => {
    // Arrange — apenas horas e gmv preenchidos, resto null
    const input = {
      metaGmvHora: null,
      margemPct: null,
      comissaoLivelabPct: null,
      horas: 1,
      gmv: 500,
      pedidos: null,
      views: null,
      clicks: null,
      problemaReportado: null,
    }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert
    expect(resultado.status).toBe('dados_incompletos')
    expect(resultado.motivos).toContain('meta de GMV/hora não configurada')
    expect(resultado.motivos).toContain('margem não configurada')
    expect(resultado.motivos).toContain('comissão LiveLab não configurada')
    expect(resultado.motivos).toContain('cliques não informados')
  })
})

// ---------------------------------------------------------------------------
// 3. NUNCA retornar ok sem campos obrigatórios
// ---------------------------------------------------------------------------
describe('nunca-ok — gmv/h alto mas margem null → dados_incompletos', () => {
  it('não retorna ok quando margem é null mesmo com gmv/h acima da meta', () => {
    // Arrange — gmv/h = 2000 > meta 1000, mas margem null
    const input = { ...inputOk, margemPct: null }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert
    expect(resultado.status).toBe('dados_incompletos')
  })
})

// ---------------------------------------------------------------------------
// 4. Status ATENÇÃO
// ---------------------------------------------------------------------------
describe('atencao', () => {
  it('retorna atencao quando gmv/h < meta e gmv > 0', () => {
    // Arrange — gmv/h = 400 < meta 1000
    const input = { ...inputOk, gmv: 800, horas: 2 }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert
    expect(resultado.status).toBe('atencao')
    expect(resultado.motivos[0]).toMatch(/abaixo da meta/i)
  })
})

// ---------------------------------------------------------------------------
// 5. Status OK
// ---------------------------------------------------------------------------
describe('ok', () => {
  it('retorna ok quando todos os campos estão preenchidos e gmv/h >= meta', () => {
    // Arrange
    const input = { ...inputOk }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert
    expect(resultado.status).toBe('ok')
    expect(resultado.motivos[0]).toMatch(/atingiu a meta/i)
  })

  it('retorna ok quando gmv/h exatamente igual à meta (borda)', () => {
    // Arrange — gmv/h = 1000 = meta 1000
    const input = { ...inputOk, gmv: 2000, horas: 2 }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert
    expect(resultado.status).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// 6. gmv null ≠ gmv 0
// ---------------------------------------------------------------------------
describe('gmv null vs gmv zero', () => {
  it('gmv null → dados_incompletos (não crítico)', () => {
    // Arrange
    const input = { ...inputOk, gmv: null }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert
    expect(resultado.status).toBe('dados_incompletos')
  })

  it('gmv 0 medido + horas >= 1 → critico', () => {
    // Arrange
    const input = { ...inputOk, gmv: 0, horas: 1 }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert
    expect(resultado.status).toBe('critico')
  })
})

// ---------------------------------------------------------------------------
// 7. Diagnóstico de funil — 4 ramos
// ---------------------------------------------------------------------------
describe('diagnostico — baixa visualização por hora', () => {
  it('diagnostica baixa visualização quando views/h < limiar', () => {
    // Arrange — views/h = 100 < 500, gmv/h abaixo da meta
    const input = {
      ...inputOk,
      views: 200,
      horas: 2,
      gmv: 800,   // abaixo da meta
      clicks: 10,
      pedidos: 2,
    }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert
    expect(resultado.diagnostico).toMatch(/visualiza/i)
    expect(resultado.proxima_acao).toMatch(/tráfego|horário|divulg/i)
  })
})

describe('diagnostico — baixo CTR', () => {
  it('diagnostica baixo CTR quando views ok mas cliques/views < limiar', () => {
    // Arrange — views/h = 1000 ok, CTR = 5/1000 = 0.5 % < 2 %, gmv/h abaixo
    const input = {
      ...inputOk,
      views: 2000,   // 1000/h → ok
      clicks: 5,     // CTR 0.25 %
      pedidos: 1,
      gmv: 800,      // abaixo meta
      horas: 2,
    }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert
    expect(resultado.diagnostico).toMatch(/clique|CTA|gancho/i)
  })
})

describe('diagnostico — baixa conversão', () => {
  it('diagnostica baixa conversão quando CTR ok mas pedidos/clicks < limiar', () => {
    // Arrange — views/h = 1000 ok, CTR = 200/2000 = 10 % ok, conversão = 2/200 = 1 % < 5 %
    const input = {
      ...inputOk,
      views: 2000,
      clicks: 200,    // CTR 10 % ok
      pedidos: 2,     // conversão 1 %
      gmv: 200,       // abaixo da meta 1000/h
      horas: 2,
    }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert
    expect(resultado.diagnostico).toMatch(/pedidos|checkout|confiança/i)
  })
})

describe('diagnostico — baixo ticket', () => {
  it('diagnostica baixo ticket quando conversão ok mas gmv/pedidos < limiar', () => {
    // Arrange — views/h ok, CTR ok, conversão ok, ticket = 600/20 = 30 < 50
    const input = {
      ...inputOk,
      views: 4000,    // 2000/h ok
      clicks: 400,    // CTR 10 % ok
      pedidos: 20,    // conversão 20/400 = 5 % ok (borda)
      gmv: 600,       // ticket 30 < 50, gmv/h = 300 < 1000
      horas: 2,
    }

    // Act
    const resultado = calcularStatusOperacional(input)

    // Assert
    expect(resultado.diagnostico).toMatch(/ticket|mix|produto/i)
  })
})

// ---------------------------------------------------------------------------
// 8. Divisão por zero — guardas de segurança
// ---------------------------------------------------------------------------
describe('divisão por zero — guardas', () => {
  it('não lança erro quando views === 0', () => {
    // Arrange
    const input = { ...inputOk, views: 0, gmv: 800, horas: 2 }

    // Act & Assert — não deve lançar
    expect(() => calcularStatusOperacional(input)).not.toThrow()
  })

  it('não lança erro quando clicks === 0', () => {
    // Arrange
    const input = { ...inputOk, clicks: 0, gmv: 800, horas: 2 }

    // Act & Assert
    expect(() => calcularStatusOperacional(input)).not.toThrow()
  })

  it('não lança erro quando pedidos === 0', () => {
    // Arrange
    const input = { ...inputOk, pedidos: 0, gmv: 800, horas: 2 }

    // Act & Assert
    expect(() => calcularStatusOperacional(input)).not.toThrow()
  })

  it('não lança erro quando horas === 0', () => {
    // Arrange — horas = 0 (recém iniciada)
    const input = { ...inputOk, horas: 0 }

    // Act & Assert
    expect(() => calcularStatusOperacional(input)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 9. Thresholds customizados sobrescrevem os defaults
// ---------------------------------------------------------------------------
describe('thresholds customizados', () => {
  it('usa horasMinCritico customizado', () => {
    // Arrange — gmv=0, horas=0.5; padrão=1h → não crítico; custom=0.5 → crítico
    const input = { ...inputOk, gmv: 0, horas: 0.5 }

    // Act
    const resultado = calcularStatusOperacional(input, { horasMinCritico: 0.5 })

    // Assert
    expect(resultado.status).toBe('critico')
  })

  it('usa viewsPorHoraMin customizado', () => {
    // Arrange — views/h = 100; padrão=500 → baixo tráfego; custom=50 → não dispara
    const input = {
      ...inputOk,
      views: 200,
      horas: 2,
      gmv: 800,
      clicks: 100,   // CTR 50 % ok
      pedidos: 10,   // conversão 10 % ok, ticket 80 ok
    }

    // Act com limiar bem baixo para não disparar diagnóstico de visualização
    const resultado = calcularStatusOperacional(input, { viewsPorHoraMin: 50 })

    // Assert — não diagnostica visualização baixa com limiar 50
    expect(resultado.diagnostico == null || !(/visualiza/i).test(resultado.diagnostico)).toBe(true)
  })

  it('usa ctrMin customizado', () => {
    // Arrange — CTR = 1 %; padrão=2 % → diagnóstico CTR; custom=0.5 % → não dispara
    const input = {
      ...inputOk,
      views: 4000,   // 2000/h ok
      clicks: 40,    // CTR 1 %
      pedidos: 10,
      gmv: 800,      // abaixo da meta
      horas: 2,
    }

    // Act
    const resultado = calcularStatusOperacional(input, { ctrMin: 0.005 })

    // Assert — com limiar bem baixo, CTR de 1 % não dispara
    expect(resultado.diagnostico == null || !(/clique|CTA|gancho/i).test(resultado.diagnostico)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 10. DEFAULT_THRESHOLDS exportado
// ---------------------------------------------------------------------------
describe('DEFAULT_THRESHOLDS', () => {
  it('exporta os thresholds esperados', () => {
    expect(DEFAULT_THRESHOLDS.horasMinCritico).toBe(1)
    expect(DEFAULT_THRESHOLDS.viewsPorHoraMin).toBe(500)
    expect(DEFAULT_THRESHOLDS.ctrMin).toBe(0.02)
    expect(DEFAULT_THRESHOLDS.conversaoMin).toBe(0.05)
    expect(DEFAULT_THRESHOLDS.ticketMin).toBe(50)
  })
})
