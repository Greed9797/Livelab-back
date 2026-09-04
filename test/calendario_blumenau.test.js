import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import {
  classificarDia,
  diaDaSemana,
  ehDiaUtil,
  feriadoEm,
  feriadosDoAno,
  domingoDePascoa,
  intervaloDeDias,
  somarDias,
} from '../src/lib/calendario-blumenau.js'

const MODULO = fileURLToPath(new URL('../src/lib/calendario-blumenau.js', import.meta.url))

/**
 * Roda somarDias num processo com TZ forçado. É a única forma honesta de provar que a
 * aritmética é UTC pura: o bug clássico (montar `new Date(ano, mes-1, dia)` local e somar
 * 86.400.000 ms) só aparece na volta do horário de verão, quando o dia tem 25 horas, e só
 * se o processo estiver no fuso certo. Mudar process.env.TZ dentro do vitest vazaria para
 * os outros arquivos da mesma worker.
 */
function somarDiasNoFuso(tz, iso, dias) {
  const script = `import(${JSON.stringify(MODULO)}).then((m) => process.stdout.write(m.somarDias(${JSON.stringify(iso)}, ${dias})))`
  return execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  })
}

describe('domingoDePascoa', () => {
  // Conferido contra o calendário litúrgico real. Se um destes quebrar, o bug é do algoritmo,
  // não do teste — a Páscoa não muda de data depois de publicada.
  const CONHECIDOS = {
    1981: '1981-04-19',
    2019: '2019-04-21',
    2020: '2020-04-12',
    2021: '2021-04-04',
    2022: '2022-04-17',
    2023: '2023-04-09',
    2024: '2024-03-31', // março, não abril — pega implementação que assume mês fixo
    2025: '2025-04-20',
    2026: '2026-04-05',
    2027: '2027-03-28',
    2028: '2028-04-16',
    2029: '2029-04-01',
    2030: '2030-04-21',
    2038: '2038-04-25', // data mais tardia possível, extremo do algoritmo
  }

  for (const [ano, iso] of Object.entries(CONHECIDOS)) {
    it(`acerta ${ano}`, () => {
      expect(domingoDePascoa(Number(ano))).toBe(iso)
    })
  }

  it('sempre cai num domingo', () => {
    for (let ano = 2020; ano <= 2040; ano += 1) {
      expect(diaDaSemana(domingoDePascoa(ano))).toBe(0)
    }
  })
})

describe('feriadosDoAno — móveis derivados da Páscoa', () => {
  it('Sexta-feira Santa é dois dias antes da Páscoa', () => {
    expect(feriadosDoAno(2026)['2026-04-03']).toBe('Sexta-feira Santa')
    expect(feriadosDoAno(2025)['2025-04-18']).toBe('Sexta-feira Santa')
  })

  it('Carnaval ocupa segunda E terça (Páscoa -48 e -47)', () => {
    const f2026 = feriadosDoAno(2026)
    expect(f2026['2026-02-16']).toBe('Carnaval')
    expect(f2026['2026-02-17']).toBe('Carnaval')
    expect(diaDaSemana('2026-02-16')).toBe(1)
    expect(diaDaSemana('2026-02-17')).toBe(2)

    const f2025 = feriadosDoAno(2025)
    expect(f2025['2025-03-03']).toBe('Carnaval')
    expect(f2025['2025-03-04']).toBe('Carnaval')
  })

  it('Corpus Christi é 60 dias depois da Páscoa e cai numa quinta', () => {
    expect(feriadosDoAno(2026)['2026-06-04']).toBe('Corpus Christi')
    expect(feriadosDoAno(2025)['2025-06-19']).toBe('Corpus Christi')
    expect(diaDaSemana('2026-06-04')).toBe(4)
  })

  it('os móveis acompanham a Páscoa em qualquer ano, sem lista fixa', () => {
    for (let ano = 2024; ano <= 2032; ano += 1) {
      const pascoa = domingoDePascoa(ano)
      const feriados = feriadosDoAno(ano)
      expect(feriados[somarDias(pascoa, -2)]).toBe('Sexta-feira Santa')
      expect(feriados[somarDias(pascoa, -48)]).toBe('Carnaval')
      expect(feriados[somarDias(pascoa, -47)]).toBe('Carnaval')
      expect(feriados[somarDias(pascoa, 60)]).toBe('Corpus Christi')
    }
  })
})

describe('feriadosDoAno — fixos', () => {
  it('traz os nove nacionais', () => {
    const f = feriadosDoAno(2026)
    expect(f['2026-01-01']).toBe('Confraternização Universal')
    expect(f['2026-04-21']).toBe('Tiradentes')
    expect(f['2026-05-01']).toBe('Dia do Trabalho')
    expect(f['2026-09-07']).toBe('Independência')
    expect(f['2026-10-12']).toBe('Nossa Senhora Aparecida')
    expect(f['2026-11-02']).toBe('Finados')
    expect(f['2026-11-15']).toBe('Proclamação da República')
    expect(f['2026-11-20']).toBe('Consciência Negra')
    expect(f['2026-12-25']).toBe('Natal')
  })

  it('traz os municipais de Blumenau em todo ano', () => {
    for (const ano of [2025, 2026, 2027]) {
      const f = feriadosDoAno(ano)
      expect(f[`${ano}-09-02`]).toBe('Aniversário de Blumenau')
      expect(f[`${ano}-10-31`]).toBe('Dia da Reforma')
    }
  })

  it('NÃO inclui 11/08 (Data Magna de SC)', () => {
    // Lei estadual 18.531/2022 transfere a Data Magna para o domingo seguinte, então ela
    // nunca cai em dia útil. Fixar 11/08 pintaria de folga um dia de trabalho todo ano —
    // em 2026 é uma terça-feira.
    for (const ano of [2025, 2026, 2027, 2028]) {
      expect(feriadosDoAno(ano)[`${ano}-08-11`]).toBeUndefined()
      expect(feriadoEm(`${ano}-08-11`)).toBeNull()
    }
    expect(classificarDia('2026-08-11')).toEqual({ tipo: 'util', feriado: null })
  })
})

describe('feriadoEm', () => {
  it('devolve o nome no feriado e null fora dele', () => {
    expect(feriadoEm('2026-12-25')).toBe('Natal')
    expect(feriadoEm('2026-12-24')).toBeNull()
  })

  it('não vaza feriado móvel de um ano para o outro (cache por ano)', () => {
    // 18/04 é Sexta-feira Santa em 2025 e dia comum em 2026. Cache indexado por ano errado
    // marcaria folga num dia de trabalho.
    expect(feriadoEm('2025-04-18')).toBe('Sexta-feira Santa')
    expect(feriadoEm('2026-04-18')).toBeNull()
    expect(feriadoEm('2025-04-18')).toBe('Sexta-feira Santa') // segunda leitura vem do cache
  })
})

describe('classificarDia', () => {
  it('segunda a sexta sem feriado é dia útil', () => {
    expect(classificarDia('2026-09-03')).toEqual({ tipo: 'util', feriado: null }) // quinta
    expect(classificarDia('2026-09-04')).toEqual({ tipo: 'util', feriado: null }) // sexta
  })

  it('sábado e domingo são fim de semana', () => {
    expect(classificarDia('2026-09-05')).toEqual({ tipo: 'fim_de_semana', feriado: null })
    expect(classificarDia('2026-09-06')).toEqual({ tipo: 'fim_de_semana', feriado: null })
  })

  it('feriado em dia útil é feriado, e diz qual é', () => {
    expect(classificarDia('2026-09-07')).toEqual({ tipo: 'feriado', feriado: 'Independência' })
    expect(classificarDia('2026-04-03')).toEqual({ tipo: 'feriado', feriado: 'Sexta-feira Santa' })
  })

  it('feriado que cai no fim de semana continua sendo classificado como feriado', () => {
    // 01/01/2028 é sábado. Os dois casos são folga, então a cor não muda; o que importa é o
    // hover conseguir dizer "Confraternização Universal" em vez de "fim de semana".
    expect(diaDaSemana('2028-01-01')).toBe(6)
    expect(classificarDia('2028-01-01')).toEqual({
      tipo: 'feriado',
      feriado: 'Confraternização Universal',
    })
  })

  it('ehDiaUtil só é verdade no dia cobrado', () => {
    expect(ehDiaUtil('2026-09-03')).toBe(true) // quinta comum
    expect(ehDiaUtil('2026-09-05')).toBe(false) // sábado
    expect(ehDiaUtil('2026-09-07')).toBe(false) // feriado em segunda
    expect(ehDiaUtil('2026-09-02')).toBe(false) // aniversário de Blumenau, numa quarta
  })
})

describe('diaDaSemana', () => {
  it('usa a convenção 0=domingo … 6=sábado', () => {
    expect(diaDaSemana('2026-09-06')).toBe(0)
    expect(diaDaSemana('2026-09-07')).toBe(1)
    expect(diaDaSemana('2026-09-12')).toBe(6)
  })
})

describe('somarDias', () => {
  it('atravessa virada de mês', () => {
    expect(somarDias('2026-01-31', 1)).toBe('2026-02-01')
    expect(somarDias('2026-04-30', 1)).toBe('2026-05-01')
    expect(somarDias('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('atravessa fevereiro em ano comum e em ano bissexto', () => {
    expect(somarDias('2026-02-28', 1)).toBe('2026-03-01')
    expect(somarDias('2024-02-28', 1)).toBe('2024-02-29')
    expect(somarDias('2024-02-29', 1)).toBe('2024-03-01')
    expect(somarDias('2000-02-28', 1)).toBe('2000-02-29') // século divisível por 400
    expect(somarDias('1900-02-28', 1)).toBe('1900-03-01') // século NÃO divisível por 400
  })

  it('atravessa virada de ano nos dois sentidos', () => {
    expect(somarDias('2025-12-31', 1)).toBe('2026-01-01')
    expect(somarDias('2026-01-01', -1)).toBe('2025-12-31')
    expect(somarDias('2025-12-25', 30)).toBe('2026-01-24')
  })

  it('zera dias devolve a própria data e mantém o padding de dois dígitos', () => {
    expect(somarDias('2026-01-05', 0)).toBe('2026-01-05')
    expect(somarDias('2026-09-09', 1)).toBe('2026-09-10')
  })

  it('é imune ao horário de verão do fuso do processo', () => {
    // Volta do horário de verão brasileiro: 18/02/2018 teve 25 horas. Somar 86.400.000 ms a
    // uma Date local de 17/02 devolveria 17/02 às 23h — o dia não avança.
    expect(somarDiasNoFuso('America/Sao_Paulo', '2018-02-17', 1)).toBe('2018-02-18')
    // Entrada do horário de verão brasileiro (dia de 23 horas), o outro lado da mesma armadilha.
    expect(somarDiasNoFuso('America/Sao_Paulo', '2017-10-14', 1)).toBe('2017-10-15')
    // Mesma prova em fusos do norte, para o caso de a API rodar fora do Brasil: 01/11/2026
    // tem 25 horas em Nova York e 25/10/2026 tem 25 horas em Lisboa.
    expect(somarDiasNoFuso('America/New_York', '2026-11-01', 1)).toBe('2026-11-02')
    expect(somarDiasNoFuso('Europe/Lisbon', '2026-10-25', 1)).toBe('2026-10-26')
    // E o resultado tem que ser igual em qualquer fuso, inclusive nos extremos.
    expect(somarDiasNoFuso('Pacific/Kiritimati', '2026-01-31', 1)).toBe('2026-02-01')
    expect(somarDiasNoFuso('UTC', '2026-01-31', 1)).toBe('2026-02-01')
  })
})

describe('intervaloDeDias', () => {
  it('é inclusivo nas duas pontas', () => {
    expect(intervaloDeDias('2026-09-01', '2026-09-03')).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
    ])
    expect(intervaloDeDias('2026-09-01', '2026-09-01')).toEqual(['2026-09-01'])
  })

  it('atravessa mês e ano sem buraco nem repetição', () => {
    expect(intervaloDeDias('2026-01-30', '2026-02-02')).toEqual([
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
      '2026-02-02',
    ])
    expect(intervaloDeDias('2025-12-30', '2026-01-02')).toHaveLength(4)
  })

  it('cobre a janela de 30 dias que a Home usa, sem duplicar dia', () => {
    const dias = intervaloDeDias(somarDias('2026-03-15', -29), '2026-03-15')
    expect(dias).toHaveLength(30)
    expect(new Set(dias).size).toBe(30)
    expect(dias[0]).toBe('2026-02-14')
  })

  it('devolve vazio quando o fim é anterior ao início', () => {
    expect(intervaloDeDias('2026-09-03', '2026-09-01')).toEqual([])
  })
})

/**
 * Estes três blocos existem por causa da regra do dono: 'util' é a ÚNICA classificação que pode
 * virar vermelho, e vermelho acusa uma pessoa real de ter faltado. Nenhum caminho pode chegar em
 * 'util' por acidente.
 */
describe('classificarDia — entrada inválida não pode virar dia cobrado', () => {
  it('lança em vez de classificar lixo como dia útil', () => {
    // Antes: Number('lixo'.slice(0,4)) = NaN, o teste de fim de semana com NaN dava falso e a
    // função devolvia { tipo: 'util' } — exatamente a classificação que pinta VERMELHO.
    for (const lixo of ['lixo', '', '2026-9-1', '03/09/2026', null, undefined, 20260903]) {
      expect(() => classificarDia(lixo)).toThrow(TypeError)
    }
  })

  it('lança na data que não existe, em vez de rolar para outro dia', () => {
    // Date.UTC(2026, 12, 45) rola para 2027-02-14 (um domingo) e a data inexistente recebia
    // classificação definitiva.
    expect(() => classificarDia('2026-13-45')).toThrow(/inexistente/i)
    expect(() => classificarDia('2026-02-30')).toThrow(/inexistente/i)
    expect(() => somarDias('2026-02-30', 1)).toThrow(TypeError)
    expect(() => diaDaSemana('2026-00-10')).toThrow(TypeError)
  })

  it('intervaloDeDias valida as duas pontas', () => {
    expect(() => intervaloDeDias('2026-09-01', 'lixo')).toThrow(TypeError)
    expect(() => intervaloDeDias('lixo', '2026-09-07')).toThrow(TypeError)
  })

  it('não polui o cache de feriados com a chave NaN', () => {
    expect(() => feriadoEm('lixo')).toThrow(TypeError)
    // Se o ano NaN tivesse entrado no cache, o ano seguinte poderia ler a lista errada.
    expect(feriadosDoAno(2026)['2026-12-25']).toBe('Natal')
  })
})

describe('Consciência Negra — nacional só a partir de 2024', () => {
  it('não é feriado nos anos anteriores à Lei 14.759/2023', () => {
    // 20/11/2023 caiu numa segunda-feira e era dia de trabalho normal: não havia lei nacional,
    // estadual de SC nem municipal de Blumenau. Marcá-lo de cinza escondia falta real.
    for (const ano of [2021, 2022, 2023]) {
      expect(feriadosDoAno(ano)[`${ano}-11-20`]).toBeUndefined()
    }
    expect(classificarDia('2023-11-20')).toEqual({ tipo: 'util', feriado: null })
  })

  it('é feriado de 2024 em diante', () => {
    for (const ano of [2024, 2025, 2026]) {
      expect(feriadosDoAno(ano)[`${ano}-11-20`]).toBe('Consciência Negra')
    }
  })
})

describe('25/11 — Santa Catarina de Alexandria', () => {
  it('é dia útil: a padroeira é data comemorativa, não feriado', () => {
    // Lei estadual de 2004 rebaixou o 25/11 a data comemorativa oficial, exatamente para manter
    // as atividades econômicas — e o calendário do Sindilojas-SC, que rege o comércio da região,
    // lista só o 11/08 como feriado estadual. Pintar de folga esconderia falta real: é o erro
    // oposto ao que este módulo mais teme, mas ainda é erro.
    // Há projeto na Alesc para virar feriado; se passar, entra com condição de ano como a
    // Consciência Negra, e este teste muda junto.
    expect(classificarDia('2026-11-25')).toEqual({ tipo: 'util', feriado: null })
    for (const ano of [2025, 2026, 2027]) {
      expect(feriadosDoAno(ano)[`${ano}-11-25`]).toBeUndefined()
    }
  })
})
