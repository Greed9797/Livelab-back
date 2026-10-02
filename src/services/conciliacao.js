// Lógica PURA de conciliação Asaas ↔ financeiro (sem I/O, sem banco, sem rede).
//
// Entradas:
//   - transação normalizada (ver normalizarTransacaoAsaas):
//       { id, tipo: 'entrada'|'saida', valor, valor_bruto?, data: 'YYYY-MM-DD', customer_id? }
//   - candidato (montado por candidatoDeLancamento a partir do contrato comum de receitas/custos):
//       { tipo: 'receita'|'custo', id, valores: number[], data_referencia: 'YYYY-MM-DD',
//         gateway_customer_id?, descricao? }
//     `valores` lista os montantes aceitáveis (ex.: total pendente, só o fixo,
//     só a comissão — a planilha cobra fixo e comissão separados).
//
// Datas trafegam como string 'YYYY-MM-DD' (convenção do projeto) — nunca Date,
// pra não sofrer com fuso.

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/
const RE_MES = /^\d{4}-\d{2}$/

// Pesos do score (máx. 100)
export const PESOS = Object.freeze({
  CUSTOMER: 50,          // mesmo customer Asaas do cliente do contrato
  CUSTOMER_DIVERGENTE: -40,
  VALOR_EXATO: 35,       // centavo a centavo
  VALOR_1PCT: 25,        // até 1% de diferença (taxa de boleto/pix embutida etc.)
  VALOR_5PCT: 10,
  MESMO_MES: 15,
  MES_VIZINHO: 5,        // ±1 mês (comissão de M é recebida em M+1, atrasos)
})

export const SCORE_MINIMO_PADRAO = 40

export function centavos(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

export function isData(s) {
  if (typeof s !== 'string' || !RE_DATA.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

export function isMes(s) {
  return typeof s === 'string' && RE_MES.test(s) && Number(s.slice(5, 7)) >= 1 && Number(s.slice(5, 7)) <= 12
}

// Índice absoluto do mês (ano*12 + mês-1) — facilita diferença entre meses.
function indiceMes(data) {
  return Number(data.slice(0, 4)) * 12 + Number(data.slice(5, 7)) - 1
}

export function diffMeses(a, b) {
  return Math.abs(indiceMes(a) - indiceMes(b))
}

// 'YYYY-MM' + dia → 'YYYY-MM-DD', limitando ao último dia do mês (dia 30 em fevereiro → 28/29).
export function dataNoMes(mesOuData, dia) {
  const y = Number(mesOuData.slice(0, 4))
  const m = Number(mesOuData.slice(5, 7))
  const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const d = Math.min(Math.max(Number(dia) || 1, 1), ultimo)
  return `${mesOuData.slice(0, 7)}-${String(d).padStart(2, '0')}`
}

// Soma dias a uma data 'YYYY-MM-DD' (UTC puro, sem fuso).
export function somarDias(data, dias) {
  const [y, m, d] = data.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + dias))
  return dt.toISOString().slice(0, 10)
}

// Resolve e valida o período ?inicio&fim (YYYY-MM-DD).
// Padrão: do 1º dia do mês anterior até `hoje`. Limite de `maxDias` para não
// estourar a paginação do Asaas numa única requisição.
export function resolverPeriodo({ inicio, fim } = {}, hoje, { maxDias = 366 } = {}) {
  if (!isData(hoje)) throw new Error('hoje inválido')
  let fimR = fim ?? hoje
  let inicioR = inicio
  if (inicioR == null) {
    const y = Number(hoje.slice(0, 4))
    const m = Number(hoje.slice(5, 7))
    const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1]
    inicioR = `${py}-${String(pm).padStart(2, '0')}-01`
  }
  if (!isData(inicioR) || !isData(fimR)) {
    return { erro: 'Datas devem estar no formato YYYY-MM-DD' }
  }
  if (inicioR > fimR) return { erro: 'inicio deve ser menor ou igual a fim' }
  const dias = (Date.parse(`${fimR}T00:00:00Z`) - Date.parse(`${inicioR}T00:00:00Z`)) / 86400000
  if (dias > maxDias) return { erro: `Período máximo de ${maxDias} dias` }
  return { inicio: inicioR, fim: fimR }
}

// Converte uma financialTransaction do Asaas (+ payment opcional) na linha de gateway_transacoes.
// SUPOSIÇÃO (validar com chave real): `value` vem com sinal — positivo = crédito
// na conta, negativo = débito (taxas, transferências). `date` = 'YYYY-MM-DD'.
export function normalizarTransacaoAsaas(ft, pagamento = null) {
  if (!ft || !ft.id) return null
  const valorNum = Number(ft.value)
  if (!Number.isFinite(valorNum)) return null
  const data = typeof ft.date === 'string' ? ft.date.slice(0, 10) : null
  if (!isData(data)) return null
  const valorBruto = pagamento && Number.isFinite(Number(pagamento.value)) ? Number(pagamento.value) : null
  return {
    asaas_id: String(ft.id),
    tipo: valorNum < 0 ? 'saida' : 'entrada',
    tipo_asaas: ft.type ?? null,
    valor: Math.abs(valorNum),
    valor_bruto: valorBruto,
    data,
    descricao: ft.description ?? pagamento?.description ?? null,
    payment_id: ft.paymentId ?? pagamento?.id ?? null,
    customer_id: pagamento?.customer ?? null,
    raw: { transacao: ft, pagamento: pagamento ?? null },
  }
}

// Tipos de alvo aceitos: receita/avulsa ↔ entrada; custo/apresentadora/imposto ↔ saída.
export const TIPOS_ALVO = Object.freeze(['receita', 'avulsa', 'custo', 'apresentadora', 'imposto'])
const TIPOS_ENTRADA = ['receita', 'avulsa']

export function validarTipoConciliacao(tipoTransacao, tipoAlvo) {
  if (!TIPOS_ALVO.includes(tipoAlvo)) return 'tipo deve ser receita, avulsa, custo, apresentadora ou imposto'
  if (TIPOS_ENTRADA.includes(tipoAlvo) && tipoTransacao !== 'entrada') {
    return tipoAlvo === 'avulsa' ? 'Só entradas podem ser conciliadas com receitas avulsas' : 'Só entradas podem ser conciliadas com receitas'
  }
  if (!TIPOS_ENTRADA.includes(tipoAlvo) && tipoTransacao !== 'saida') {
    return `Só saídas podem ser conciliadas com ${tipoAlvo === 'custo' ? 'custos' : tipoAlvo === 'imposto' ? 'imposto' : 'pagamentos de apresentadoras'}`
  }
  return null
}

function pontuarValor(transacao, valoresCandidato) {
  const alvos = [transacao.valor, transacao.valor_bruto]
    .map(centavos)
    .filter((c) => c != null && c > 0)
  let melhor = { pontos: 0, motivo: null }
  for (const vc of valoresCandidato ?? []) {
    const c = centavos(vc)
    if (c == null || c <= 0) continue
    for (const t of alvos) {
      const diff = Math.abs(t - c) / c
      let r = { pontos: 0, motivo: null }
      if (t === c) r = { pontos: PESOS.VALOR_EXATO, motivo: 'valor_exato' }
      else if (diff <= 0.01) r = { pontos: PESOS.VALOR_1PCT, motivo: 'valor_aprox_1pct' }
      else if (diff <= 0.05) r = { pontos: PESOS.VALOR_5PCT, motivo: 'valor_aprox_5pct' }
      if (r.pontos > melhor.pontos) melhor = { ...r, valor_casado: c / 100 }
    }
  }
  return melhor
}

// Score 0..100 + motivos legíveis pela UI.
export function pontuarMatch(transacao, candidato) {
  const motivos = []
  let score = 0

  const tc = transacao.customer_id
  const cc = candidato.gateway_customer_id
  if (tc && cc) {
    if (tc === cc) {
      score += PESOS.CUSTOMER
      motivos.push('mesmo_customer')
    } else {
      score += PESOS.CUSTOMER_DIVERGENTE
      motivos.push('customer_divergente')
    }
  }

  const v = pontuarValor(transacao, candidato.valores)
  let valorCasado = null
  if (v.pontos > 0) {
    score += v.pontos
    motivos.push(v.motivo)
    valorCasado = v.valor_casado
  }

  if (isData(transacao.data) && isData(candidato.data_referencia)) {
    const dm = diffMeses(transacao.data, candidato.data_referencia)
    if (dm === 0) {
      score += PESOS.MESMO_MES
      motivos.push('mesmo_mes')
    } else if (dm === 1) {
      score += PESOS.MES_VIZINHO
      motivos.push('mes_vizinho')
    }
  }

  return { score: Math.max(0, Math.min(100, score)), motivos, valor_casado: valorCasado }
}

// Para cada transação, devolve as melhores sugestões (ordenadas por score desc).
// Candidatos de tipo incompatível (receita x saída / custo x entrada) são ignorados.
// `ambiguo` = as duas melhores sugestões empatam — UI deve pedir confirmação manual.
export function sugerirMatches(transacoes, candidatos, { limite = 3, scoreMinimo = SCORE_MINIMO_PADRAO } = {}) {
  return (transacoes ?? []).map((t) => {
    const sugestoes = []
    for (const c of candidatos ?? []) {
      if (validarTipoConciliacao(t.tipo, c.tipo)) continue
      const { score, motivos, valor_casado } = pontuarMatch(t, c)
      if (score < scoreMinimo) continue
      sugestoes.push({
        tipo: c.tipo,
        id: c.id,
        descricao: c.descricao ?? null,
        data_referencia: c.data_referencia ?? null,
        valor_casado,
        score,
        motivos,
      })
    }
    // Desempate estável: score desc, depois data de referência mais próxima.
    sugestoes.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const da = a.data_referencia && isData(t.data) ? Math.abs(Date.parse(a.data_referencia) - Date.parse(t.data)) : Infinity
      const db = b.data_referencia && isData(t.data) ? Math.abs(Date.parse(b.data_referencia) - Date.parse(t.data)) : Infinity
      return da - db
    })
    const top = sugestoes.slice(0, limite)
    return {
      transacao_id: t.id,
      sugestoes: top,
      ambiguo: top.length >= 2 && top[0].score === top[1].score,
    }
  })
}

// Monta candidato a partir de um lançamento do contrato comum das frentes A/B
// (listarTitulosReceita / listarCustos): { id, natureza, descricao, data_vencimento,
// valor_previsto, valor_pago, cliente_id? }. O valor aceito é o saldo pendente
// (previsto − pago); títulos já quitados ou sem saldo não viram candidatos.
// Receita PERDIDA / custo CANCELADO (status derivado ou perdido_em/cancelado_em) também não.
// `gatewayCustomerPorCliente` = Map(cliente_id → cus_* do Asaas).
export function lancamentoEncerrado(l) {
  return l?.status === 'perdido' || l?.status === 'cancelado' || Boolean(l?.perdido_em) || Boolean(l?.cancelado_em)
}

export function candidatoDeLancamento(l, gatewayCustomerPorCliente = new Map()) {
  if (lancamentoEncerrado(l)) return null
  const natureza = l?.natureza === 'custo' ? 'custo' : 'receita'
  const tipoAlvo = natureza === 'receita' ? (l?.origem === 'avulsa' ? 'avulsa' : 'receita')
    : l?.origem === 'apresentadora' ? 'apresentadora'
    : l?.origem === 'imposto' || l?.tipo === 'imposto' ? 'imposto'
    : 'custo'
  const pendente = Math.max(0, Number(l?.valor_previsto ?? 0) - Number(l?.valor_pago ?? 0))
  const c = centavos(pendente)
  if (!c || c <= 0) return null
  const venc = typeof l.data_vencimento === 'string' ? l.data_vencimento.slice(0, 10) : null
  const comp = typeof l.competencia === 'string' ? l.competencia.slice(0, 10) : null
  const ref = venc && isData(venc) ? venc : comp && isData(comp) ? comp : null
  return {
    tipo: tipoAlvo,
    id: l.id,
    valores: [c / 100],
    data_referencia: ref,
    gateway_customer_id: l.cliente_id ? gatewayCustomerPorCliente.get(l.cliente_id) ?? null : null,
    descricao: l.descricao ?? null,
  }
}

// ─── Baixa automática (onda 2) ────────────────────────────────────────────────
// Ao conciliar, a transação do Asaas dá baixa no alvo: valor_pago = valor da transação,
// data_pagamento = data da transação. Roda DENTRO da transação do chamador (a rota abre o
// BEGIN, grava o vínculo e chama isto; qualquer erro → ROLLBACK de tudo).
// Ids virtuais (calc:/rec:/imposto:) são materializados e o vínculo guarda o UUID real.
// Alvo já baixado (valor_pago > 0) NÃO é sobrescrito: só vincula (aplicada=false, motivo='ja_baixado')
// e, como a baixa não foi gerada aqui, desconciliar também não a desfaz.

export class ConciliacaoError extends Error {
  constructor(message, status = 400, codigo = 'CONCILIACAO') {
    super(message)
    this.name = 'ConciliacaoError'
    this.status = status
    this.codigo = codigo
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// apresentadora:<uuid>:<AAAA-MM>[:fixo|variavel]. Sem componente (id LEGADO) = 'fixo'.
const RE_APRES = /^apresentadora:([0-9a-f-]{36}):(\d{4}-(?:0[1-9]|1[0-2]))(?::(fixo|variavel))?$/i
const RE_IMPOSTO = /^imposto:(\d{4}-(?:0[1-9]|1[0-2]))$/

const naoEncontrado = (msg) => new ConciliacaoError(msg, 404, 'ALVO_NAO_ENCONTRADO')
// Perdido/cancelado não aceita baixa (nem vínculo): o usuário desfaz a perda antes.
const encerradoErro = (tipo) => new ConciliacaoError(
  'Desfaça a perda/cancelamento antes',
  409, tipo === 'custo' ? 'ALVO_CANCELADO' : 'ALVO_PERDIDO',
)
const indisponivel = (msg) => new ConciliacaoError(msg, 409, 'MODULO_INDISPONIVEL')

// Serviços como receberTitulo abrem BEGIN/COMMIT próprios; dentro de uma transação já aberta
// isso commitaria o vínculo antes da hora. Este wrapper converte em SAVEPOINT/RELEASE/ROLLBACK TO,
// mantendo a baixa e o vínculo atômicos.
export function comSavepoints(db) {
  const pilha = []
  let seq = 0
  return {
    query(sql, params) {
      const cmd = typeof sql === 'string' ? sql.trim().toUpperCase() : ''
      if (cmd === 'BEGIN') {
        const nome = `conc_sp_${++seq}`
        pilha.push(nome)
        return db.query(`SAVEPOINT ${nome}`)
      }
      if (cmd === 'COMMIT') {
        const nome = pilha.pop()
        return nome ? db.query(`RELEASE SAVEPOINT ${nome}`) : Promise.resolve({ rows: [] })
      }
      if (cmd === 'ROLLBACK') {
        const nome = pilha.pop()
        return nome ? db.query(`ROLLBACK TO SAVEPOINT ${nome}`) : Promise.resolve({ rows: [] })
      }
      return db.query(sql, params)
    },
  }
}

const jaPago = (v) => Number(v ?? 0) > 0

async function baixarReceita(db, { tenantId, tx, alvoId, userId }) {
  const mod = await import('./receitas-comercial.js')
  const ref = mod.parseIdTitulo(alvoId)
  if (!ref) throw naoEncontrado('Título de receita não encontrado')
  let existente
  if (ref.tipo === 'materializado') {
    existente = await db.query(
      'SELECT id, valor_pago, perdido_em FROM receita_titulos WHERE id = $1::uuid AND tenant_id = $2::uuid FOR UPDATE',
      [ref.id, tenantId],
    )
    if (!existente.rows[0]) throw naoEncontrado('Título de receita não encontrado')
  } else {
    existente = await db.query(
      `SELECT id, valor_pago, perdido_em FROM receita_titulos
        WHERE tenant_id = $1::uuid AND marca_id = $2::uuid AND competencia = $3::date AND componente = $4
        FOR UPDATE`,
      [tenantId, ref.marca_id, `${ref.mes}-01`, ref.componente],
    )
  }
  const row = existente.rows[0]
  if (row?.perdido_em) throw encerradoErro('receita')
  if (row && jaPago(row.valor_pago)) {
    return { aplicada: false, motivo: 'ja_baixado', alvo_id: row.id }
  }
  try {
    const item = await mod.receberTitulo(comSavepoints(db), {
      tenantId, id: alvoId, valorPago: tx.valor, dataPagamento: tx.data, actorUserId: userId ?? null,
      observacao: 'Baixa via conciliação Asaas',
    })
    return { aplicada: true, alvo_id: item.id, valor_pago: item.valor_pago, data_pagamento: item.data_pagamento }
  } catch (err) {
    if (err?.code === 'RECEITA_NOT_FOUND' || err?.status === 404) throw naoEncontrado('Título de receita não encontrado')
    throw err
  }
}

async function resolverCustoId(db, tenantId, alvoId) {
  if (UUID_RE.test(alvoId)) return alvoId
  const custos = await import('./custos-plano.js')
  const v = custos.parseIdVirtual(alvoId)
  if (!v) return null
  return custos.materializarVirtual(db, { tenantId, recorrente_id: v.recorrente_id, mes: v.mes })
}

async function baixarCustoPorId(db, { tenantId, tx, id, tipoEsperado }) {
  const r = await db.query(
    'SELECT id, valor_pago, tipo, cancelado_em FROM custos WHERE id = $1::uuid AND tenant_id = $2::uuid FOR UPDATE',
    [id, tenantId],
  )
  const row = r.rows[0]
  if (!row || (tipoEsperado && row.tipo !== tipoEsperado)) {
    throw naoEncontrado(tipoEsperado === 'imposto' ? 'Imposto não encontrado' : 'Custo não encontrado')
  }
  if (row.cancelado_em) throw encerradoErro('custo')
  if (jaPago(row.valor_pago)) return { aplicada: false, motivo: 'ja_baixado', alvo_id: row.id }
  await db.query(
    `UPDATE custos SET valor_pago = $3::numeric, data_pagamento = $4::date, atualizado_em = NOW()
      WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [row.id, tenantId, tx.valor, tx.data],
  )
  return { aplicada: true, alvo_id: row.id, valor_pago: Number(tx.valor), data_pagamento: tx.data }
}

async function baixarCusto(db, { tenantId, tx, alvoId }) {
  const id = await resolverCustoId(db, tenantId, alvoId)
  if (!id) throw naoEncontrado('Custo não encontrado')
  return baixarCustoPorId(db, { tenantId, tx, id })
}

async function baixarApresentadora(db, { tenantId, tx, alvoId, userId }) {
  const m = RE_APRES.exec(alvoId)
  if (!m) throw naoEncontrado('Pagamento de apresentadora não encontrado (use apresentadora:<id>:<AAAA-MM>:<fixo|variavel>)')
  const [, apresentadoraId, mes] = m
  const componente = (m[3] ?? 'fixo').toLowerCase()
  const ex = await db.query(
    `SELECT id, valor_pago FROM apresentadora_pagamentos
      WHERE tenant_id = $1::uuid AND apresentadora_id = $2::uuid AND competencia = $3::date AND componente = $4::text FOR UPDATE`,
    [tenantId, apresentadoraId, `${mes}-01`, componente],
  )
  if (ex.rows[0] && jaPago(ex.rows[0].valor_pago)) {
    return { aplicada: false, motivo: 'ja_baixado', alvo_id: ex.rows[0].id }
  }
  const pg = await import('./apresentadoras-pagamentos.js')
  const reg = await pg.registrarPagamentoApresentadora(db, {
    tenantId, apresentadoraId, mes, componente, valorPago: tx.valor, dataPagamento: tx.data,
    observacao: 'Baixa via conciliação Asaas', userId: userId ?? null,
  })
  if (!reg) throw naoEncontrado('Apresentadora não encontrada')
  const r = await db.query(
    `SELECT id FROM apresentadora_pagamentos
      WHERE tenant_id = $1::uuid AND apresentadora_id = $2::uuid AND competencia = $3::date AND componente = $4::text`,
    [tenantId, apresentadoraId, `${mes}-01`, componente],
  )
  return { aplicada: true, alvo_id: r.rows[0].id, valor_pago: Number(reg.valor_pago), data_pagamento: reg.data_pagamento }
}

// Receita avulsa: alvo = receitas_avulsas.id (UUID). Baixa via serviço receitas-avulsas.js.
async function baixarAvulsa(db, { tenantId, tx, alvoId }) {
  if (!UUID_RE.test(alvoId)) throw naoEncontrado('Receita avulsa não encontrada')
  const ex = await db.query(
    'SELECT id, valor_pago, perdido_em FROM receitas_avulsas WHERE id = $1::uuid AND tenant_id = $2::uuid FOR UPDATE',
    [alvoId, tenantId],
  )
  const row = ex.rows[0]
  if (!row) throw naoEncontrado('Receita avulsa não encontrada')
  if (row.perdido_em) throw encerradoErro('receita')
  if (jaPago(row.valor_pago)) return { aplicada: false, motivo: 'ja_baixado', alvo_id: row.id }
  const avulsas = await import('./receitas-avulsas.js')
  const item = await avulsas.receberReceitaAvulsa(db, { tenantId, id: row.id, valorPago: tx.valor, dataPagamento: tx.data })
  if (!item) throw naoEncontrado('Receita avulsa não encontrada')
  return { aplicada: true, alvo_id: item.id, valor_pago: item.valor_pago, data_pagamento: item.data_pagamento }
}

// Imposto: custos tipo 'imposto' materializado na baixa; id virtual `imposto:<AAAA-MM>`.
// Virtual => `pagarImposto` (financeiro-agregador) materializa e baixa com o valor/data da transação.
async function baixarImposto(db, { tenantId, tx, alvoId }) {
  let id = UUID_RE.test(alvoId) ? alvoId : null
  if (!id) {
    const m = RE_IMPOSTO.exec(alvoId)
    if (!m) throw naoEncontrado('Imposto não encontrado (use imposto:<AAAA-MM>)')
    const mes = m[1]
    const existente = await db.query(
      `SELECT id FROM custos WHERE tenant_id = $1::uuid AND tipo = 'imposto' AND competencia = $2::date
        ORDER BY criado_em LIMIT 1`,
      [tenantId, `${mes}-01`],
    )
    id = existente.rows[0]?.id ?? null
    if (!id) {
      const { pagarImposto } = await import('./financeiro-agregador.js')
      try {
        await pagarImposto(db, { tenantId, mes, valorPago: tx.valor, dataPagamento: tx.data })
      } catch (err) {
        if (err?.status && !(err instanceof ConciliacaoError)) throw new ConciliacaoError(err.message, err.status, err.code ?? 'IMPOSTO_INVALIDO')
        throw err
      }
      const criado = await db.query(
        `SELECT id FROM custos WHERE tenant_id = $1::uuid AND tipo = 'imposto' AND competencia = $2::date LIMIT 1`,
        [tenantId, `${mes}-01`],
      )
      id = criado.rows[0]?.id ?? null
      if (!id) throw indisponivel('Imposto do mês não pôde ser materializado')
      return { aplicada: true, alvo_id: id, valor_pago: tx.valor, data_pagamento: tx.data }
    }
  }
  return baixarCustoPorId(db, { tenantId, tx, id, tipoEsperado: 'imposto' })
}

/**
 * Dá baixa no alvo da conciliação. Retorna
 *   { aplicada, motivo?, alvo_tipo, alvo_id (UUID real), valor_pago?, data_pagamento? }
 * Lança ConciliacaoError (404/409/400) quando o alvo não existe / módulo ausente.
 * `transacao` = { valor, data, tipo } (gateway_transacoes).
 */
export async function darBaixaConciliacao(db, { tenantId, transacao, tipo, alvoId, userId } = {}) {
  const tx = { valor: Number(transacao?.valor), data: String(transacao?.data ?? '').slice(0, 10) }
  if (!(tx.valor > 0) || !isData(tx.data)) throw new ConciliacaoError('Transação sem valor/data válidos', 400, 'TRANSACAO_INVALIDA')
  const id = String(alvoId ?? '')
  const args = { tenantId, tx, alvoId: id, userId }
  let r
  try {
    if (tipo === 'receita') r = await baixarReceita(db, args)
    else if (tipo === 'avulsa') r = await baixarAvulsa(db, args)
    else if (tipo === 'custo') r = await baixarCusto(db, args)
    else if (tipo === 'apresentadora') r = await baixarApresentadora(db, args)
    else if (tipo === 'imposto') r = await baixarImposto(db, args)
    else throw new ConciliacaoError('tipo deve ser receita, avulsa, custo, apresentadora ou imposto')
  } catch (err) {
    if (err?.code === '42P01' || err?.code === '42703') throw indisponivel('Módulo financeiro ainda não migrado')
    throw err
  }
  return { alvo_tipo: tipo, ...r }
}

/**
 * Desfaz a baixa gerada por uma conciliação (só chamar se gateway_transacoes.conciliado_baixa).
 * `vinculo` = { tipo, id } com o UUID real guardado no vínculo.
 */
export async function desfazerBaixaConciliacao(db, { tenantId, tipo, alvoId } = {}) {
  if (tipo === 'receita') {
    const mod = await import('./receitas-comercial.js')
    try {
      await mod.desfazerRecebimento(db, { tenantId, id: alvoId })
    } catch (err) {
      if (err?.code === 'RECEITA_NOT_FOUND' || err?.status === 404) return { desfeita: false, motivo: 'alvo_inexistente' }
      throw err
    }
    return { desfeita: true }
  }
  if (tipo === 'avulsa') {
    const avulsas = await import('./receitas-avulsas.js')
    const item = await avulsas.desfazerReceitaAvulsa(db, { tenantId, id: alvoId })
    return item ? { desfeita: true } : { desfeita: false, motivo: 'alvo_inexistente' }
  }
  if (tipo === 'custo' || tipo === 'imposto') {
    const r = await db.query(
      `UPDATE custos SET valor_pago = NULL, data_pagamento = NULL, atualizado_em = NOW()
        WHERE id = $1::uuid AND tenant_id = $2::uuid RETURNING id`,
      [alvoId, tenantId],
    )
    return r.rows[0] ? { desfeita: true } : { desfeita: false, motivo: 'alvo_inexistente' }
  }
  if (tipo === 'apresentadora') {
    const r = await db.query(
      'DELETE FROM apresentadora_pagamentos WHERE id = $1::uuid AND tenant_id = $2::uuid RETURNING id',
      [alvoId, tenantId],
    )
    return r.rows[0] ? { desfeita: true } : { desfeita: false, motivo: 'alvo_inexistente' }
  }
  return { desfeita: false, motivo: 'tipo_desconhecido' }
}
