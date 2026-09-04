/**
 * Calendário de dias úteis de Blumenau/SC — quando a operação é cobrada e quando não é.
 *
 * Existe para o indicador de assiduidade: dia útil sem live é falta (vermelho), fim de semana
 * e feriado não são (cinza). Errar aqui é acusar alguém de faltar num feriado.
 *
 * Trabalha com data em texto 'YYYY-MM-DD', nunca com Date de timestamp. É a convenção do repo
 * (ver CLAUDE.md: datas viajam como string) e evita a classe inteira de bug em que uma live das
 * 21h em São Paulo vira o dia seguinte em UTC.
 */

/**
 * Domingo de Páscoa (algoritmo gregoriano anônimo / Meeus). Só isto já dá Sexta-feira Santa,
 * Carnaval e Corpus Christi, que se movem todo ano.
 */
export function domingoDePascoa(ano) {
  const a = ano % 19
  const b = Math.floor(ano / 100)
  const c = ano % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const mes = Math.floor((h + l - 7 * m + 114) / 31)
  const dia = ((h + l - 7 * m + 114) % 31) + 1
  return isoDe(ano, mes, dia)
}

function isoDe(ano, mes, dia) {
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Porta de entrada única do módulo: devolve [ano, mes, dia] ou LANÇA.
 *
 * Existe porque a falha silenciosa aqui cai sempre para o lado que acusa: sem esta checagem,
 * classificarDia('lixo') fazia Number('lixo') = NaN, o teste de fim de semana com NaN dava
 * falso e a função devolvia { tipo: 'util' } — a ÚNICA classificação que pode virar vermelho.
 * E '2026-13-45' recebia classificação definitiva ('fim_de_semana') porque Date.UTC rola o mês
 * para fevereiro de 2027. Um módulo cujo erro é acusar alguém de faltar não pode ter 'util'
 * como fallback de lixo: erro alto e visível é melhor que vermelho silencioso.
 *
 * O round-trip (remontar a string e comparar) é o que pega a data que não existe: 2026-02-30
 * vira 2026-03-02 ao remontar e não bate.
 */
function partesDaData(iso) {
  if (typeof iso !== 'string' || !ISO_RE.test(iso)) {
    throw new TypeError(`Data invalida no calendario: ${JSON.stringify(iso)} (esperado 'YYYY-MM-DD')`)
  }
  const [a, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(a, m - 1, d))
  if (isoDe(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()) !== iso) {
    throw new TypeError(`Data inexistente no calendario: ${iso}`)
  }
  return [a, m, d]
}

/** Soma dias a uma data 'YYYY-MM-DD' usando UTC puro — sem fuso, sem horário de verão. */
export function somarDias(iso, dias) {
  const [a, m, d] = partesDaData(iso)
  const t = Date.UTC(a, m - 1, d) + dias * 86400000
  const dt = new Date(t)
  return isoDe(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())
}

/** 0 = domingo … 6 = sábado. Em UTC, porque a string já É o dia local. */
export function diaDaSemana(iso) {
  const [a, m, d] = partesDaData(iso)
  return new Date(Date.UTC(a, m - 1, d)).getUTCDay()
}

/**
 * Carnaval e Corpus Christi são PONTO FACULTATIVO, não feriado — juridicamente são dia útil.
 * Entram assim mesmo porque a operação não roda normal nesses dias, e um vermelho falso
 * (acusar falta de quem não faltou) custa mais caro que um cinza a mais. Para cobrar esses
 * dias como dia útil normal, basta `false` aqui.
 */
const TRATAR_FACULTATIVO_COMO_NAO_UTIL = true

/**
 * Feriados de Blumenau/SC no ano, como { 'YYYY-MM-DD': 'nome' }.
 *
 * NÃO inclui a Data Magna de SC (11/08): a Lei estadual 18.531/2022 transfere o feriado para o
 * domingo subsequente, então ele nunca cai em dia útil. Fixar 11/08 pintaria de cinza um dia de
 * trabalho todo ano.
 */
export function feriadosDoAno(ano) {
  const pascoa = domingoDePascoa(ano)

  const fixos = {
    [`${ano}-01-01`]: 'Confraternização Universal',
    [`${ano}-04-21`]: 'Tiradentes',
    [`${ano}-05-01`]: 'Dia do Trabalho',
    [`${ano}-09-07`]: 'Independência',
    [`${ano}-10-12`]: 'Nossa Senhora Aparecida',
    [`${ano}-11-02`]: 'Finados',
    [`${ano}-11-15`]: 'Proclamação da República',
    [`${ano}-12-25`]: 'Natal',
    // Municipais de Blumenau.
    [`${ano}-09-02`]: 'Aniversário de Blumenau',      // Lei municipal 1.222/1964
    [`${ano}-10-31`]: 'Dia da Reforma',               // Lei municipal 5.564/2000
  }

  // Consciência Negra só virou feriado NACIONAL com a Lei 14.759, sancionada em dezembro de
  // 2023 — vale de 2024 em diante. Antes disso não havia feriado estadual em SC nem municipal
  // em Blumenau na data, então 20/11/2023 (uma segunda-feira) era dia de trabalho normal.
  // Aplicar a chave a qualquer ano pintava de cinza uma falta real na comparação histórica.
  if (ano >= 2024) fixos[`${ano}-11-20`] = 'Consciência Negra'

  // 25/11 — Santa Catarina de Alexandria, padroeira do estado — NÃO entra: não é feriado.
  // Desde 2004 lei estadual a rebaixou a data comemorativa oficial, justamente para permitir as
  // celebrações "com manutenção das atividades econômicas". O calendário 2026 do Sindilojas-SC,
  // que rege o comércio da região, lista só o 11/08 como feriado estadual e não cita o 25/11.
  // Há projeto na Alesc para transformá-la em feriado; enquanto não virar lei, é dia de trabalho
  // e pintá-la de folga esconderia falta real. Se o projeto passar, acrescentar aqui com a
  // condição de ano, como foi feito com a Consciência Negra.

  const moveis = {
    [somarDias(pascoa, -2)]: 'Sexta-feira Santa',
  }
  if (TRATAR_FACULTATIVO_COMO_NAO_UTIL) {
    moveis[somarDias(pascoa, -48)] = 'Carnaval'
    moveis[somarDias(pascoa, -47)] = 'Carnaval'
    moveis[somarDias(pascoa, 60)] = 'Corpus Christi'
  }

  return { ...fixos, ...moveis }
}

const cachePorAno = new Map()

function feriadosCacheados(ano) {
  if (!cachePorAno.has(ano)) cachePorAno.set(ano, feriadosDoAno(ano))
  return cachePorAno.get(ano)
}

/** Nome do feriado nessa data, ou null. */
export function feriadoEm(iso) {
  // Valida ANTES de olhar o cache: com 'lixo' o Number(...) dava NaN e criava uma entrada de
  // cache sob a chave NaN, com feriados de 'NaN-NaN-NaN'. Lixo não pode virar dado.
  const [ano] = partesDaData(iso)
  return feriadosCacheados(ano)[iso] ?? null
}

/**
 * Classifica o dia para efeito de cobrança de presença.
 *  'util'         — segunda a sexta sem feriado: não fazer live é falta
 *  'fim_de_semana'— sábado ou domingo: não é cobrado
 *  'feriado'      — não é cobrado; `feriado` traz o nome, para o hover dizer qual é
 */
export function classificarDia(iso) {
  const nome = feriadoEm(iso)
  if (nome) return { tipo: 'feriado', feriado: nome }
  const dow = diaDaSemana(iso)
  if (dow === 0 || dow === 6) return { tipo: 'fim_de_semana', feriado: null }
  return { tipo: 'util', feriado: null }
}

export function ehDiaUtil(iso) {
  return classificarDia(iso).tipo === 'util'
}

/** Lista inclusiva de datas 'YYYY-MM-DD' entre início e fim. */
export function intervaloDeDias(inicioIso, fimIso) {
  // As duas pontas passam pelo validador: com fim inválido o laço acima só compararia strings e
  // devolveria uma janela silenciosamente torta (ou infinita), em vez de acusar a entrada ruim.
  partesDaData(inicioIso)
  partesDaData(fimIso)
  const dias = []
  for (let d = inicioIso; d <= fimIso; d = somarDias(d, 1)) dias.push(d)
  return dias
}
