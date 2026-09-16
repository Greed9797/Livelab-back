import { describe, expect, it } from 'vitest'
import { buildConfiguracaoComercial } from '../src/routes/marcas.js'

describe('indicador de configuração comercial da marca', () => {
  it('não alerta para entidade que não usa condição comercial', () => {
    expect(buildConfiguracaoComercial({ tipo: 'afiliada' }).status).toBe('nao_aplicavel')
  })

  it('distingue legado ambíguo de zero confirmado', () => {
    expect(buildConfiguracaoComercial({
      tipo: 'cliente',
      condicao: { origem: 'legado_nao_verificado', fixo_mensal: 0, comissao_franquia_pct: 0 },
    })).toMatchObject({ status: 'a_revisar', codigos: ['a_revisar'] })
    expect(buildConfiguracaoComercial({
      tipo: 'cliente',
      condicao: {
        origem: 'gestao', fixo_mensal: 0, comissao_franquia_pct: 0,
        fixo_confirmado: true, comissao_confirmada: true,
      },
    })).toMatchObject({ status: 'configurado', codigos: [] })
  })

  it('expõe cada alerta da condição incompleta com códigos estáveis', () => {
    expect(buildConfiguracaoComercial({
      tipo: 'cliente',
      condicao: {
        origem: 'gestao', fixo_mensal: 1000, comissao_franquia_pct: 5,
        fixo_confirmado: false, comissao_confirmada: true,
      },
    })).toMatchObject({
      status: 'incompleto',
      codigos: ['fixo_nao_informado'],
      fixo: { status: 'fixo_nao_informado' },
      comissao: { status: 'configurado' },
    })
  })

  it('não trata zero não confirmado como configuração válida', () => {
    expect(buildConfiguracaoComercial({
      tipo: 'cliente',
      condicao: { origem: 'gestao', fixo_mensal: 0, comissao_franquia_pct: 0 },
    })).toMatchObject({
      status: 'incompleto',
      codigos: ['fixo_nao_informado', 'comissao_nao_informada'],
    })
  })
})
