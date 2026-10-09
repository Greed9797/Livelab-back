// Lógica de conciliação Asaas ↔ financeiro.
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

import { randomUUID } from 'node:crypto'
import { centsToExactMoney, exactMoneyToCents } from '../lib/money.js'
import { hojeSaoPaulo } from './receitas-comercial.js'

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
const revisarBaixa = () => new ConciliacaoError(
  'Baixa da conciliação sem fato canônico único equivalente; revisão necessária', 409, 'CONCILIACAO_BAIXA_AMBIGUA',
)
const atorConciliacao = (userId) => userId
  ? { tipo: 'usuario', id: userId }
  : { tipo: 'sistema', id: 'asaas.conciliacao' }
const chaveConciliacao = (transacaoId) => `asaas:${transacaoId}:${randomUUID()}`

const ORIGEM_POR_TIPO = Object.freeze({
  receita: 'receita_titulo',
  avulsa: 'receita_avulsa',
  custo: 'custo',
  apresentadora: 'apresentadora_pagamento',
  imposto: 'imposto',
})

async function alvoPertenceALiquidacao(db, { tenantId, tipo, alvoId, origemId }) {
  if (UUID_RE.test(String(alvoId ?? ''))) return origemId === alvoId
  let sql
  let params
  if (tipo === 'receita') {
    const m = /^calc:([0-9a-f-]{36}):(\d{4}-(?:0[1-9]|1[0-2])):(fixo|comissao)$/i.exec(alvoId)
    if (!m) return false
    sql = `SELECT 1 FROM receita_titulos
            WHERE tenant_id=$1::uuid AND id=$2::uuid AND marca_id=$3::uuid
              AND competencia=$4::date AND componente=$5`
    params = [tenantId, origemId, m[1], `${m[2]}-01`, m[3]]
  } else if (tipo === 'custo') {
    const m = /^rec:([0-9a-f-]{36}):(\d{4}-(?:0[1-9]|1[0-2]))$/i.exec(alvoId)
    if (!m) return false
    sql = `SELECT 1 FROM custos
            WHERE tenant_id=$1::uuid AND id=$2::uuid AND recorrente_id=$3::uuid
              AND competencia=$4::date AND tipo <> 'imposto'`
    params = [tenantId, origemId, m[1], `${m[2]}-01`]
  } else if (tipo === 'apresentadora') {
    const m = RE_APRES.exec(alvoId)
    if (!m) return false
    sql = `SELECT 1 FROM apresentadora_pagamentos
            WHERE tenant_id=$1::uuid AND id=$2::uuid AND apresentadora_id=$3::uuid
              AND competencia=$4::date AND componente=$5`
    params = [tenantId, origemId, m[1], `${m[2]}-01`, m[3] ?? 'fixo']
  } else if (tipo === 'imposto') {
    const m = RE_IMPOSTO.exec(alvoId)
    if (!m) return false
    sql = `SELECT 1 FROM custos
            WHERE tenant_id=$1::uuid AND id=$2::uuid AND tipo='imposto' AND competencia=$3::date`
    params = [tenantId, origemId, `${m[1]}-01`]
  } else {
    return false
  }
  return Boolean((await db.query(sql, params)).rows[0])
}

/**
 * Conciliação de uma transação com um fato que já foi registrado manualmente.
 * Este caminho apenas valida e devolve o vínculo; nunca insere outra liquidação.
 */
export async function vincularLiquidacaoExistenteConciliacao(db, {
  tenantId, transacao, tipo, alvoId, liquidacaoId,
} = {}) {
  const erroTipo = validarTipoConciliacao(transacao?.tipo, tipo)
  if (erroTipo) throw new ConciliacaoError(erroTipo, 400, 'TIPO_INCOMPATIVEL')
  if (!UUID_RE.test(String(liquidacaoId ?? ''))) {
    throw new ConciliacaoError('liquidacao_id inválida', 400, 'LIQUIDACAO_INVALIDA')
  }
  let valorTx
  try { valorTx = exactMoneyToCents(String(transacao?.valor)) } catch { /* tratado abaixo */ }
  if (!valorTx || valorTx <= 0n || !isData(String(transacao?.data ?? ''))) {
    throw new ConciliacaoError('Transação sem valor/data válidos', 400, 'TRANSACAO_INVALIDA')
  }
  const { rows } = await db.query(
    `SELECT id, origem_tipo, origem_id, valor::text AS valor,
            to_char(data_liquidacao, 'YYYY-MM-DD') AS data
       FROM financeiro_liquidacoes
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tenantId, liquidacaoId],
  )
  const liquidacao = rows[0]
  if (!liquidacao) throw new ConciliacaoError('Liquidação não encontrada neste tenant', 404, 'LIQUIDACAO_NAO_ENCONTRADA')
  if (liquidacao.origem_tipo !== ORIGEM_POR_TIPO[tipo]) {
    throw new ConciliacaoError('Liquidação não pertence ao tipo informado', 409, 'LIQUIDACAO_ORIGEM_DIVERGENTE')
  }
  if (!(await alvoPertenceALiquidacao(db, {
    tenantId, tipo, alvoId: String(alvoId ?? ''), origemId: liquidacao.origem_id,
  }))) {
    throw new ConciliacaoError('Liquidação não pertence ao lançamento informado', 409, 'LIQUIDACAO_ORIGEM_DIVERGENTE')
  }
  if (exactMoneyToCents(liquidacao.valor) !== valorTx || liquidacao.data !== transacao.data) {
    throw new ConciliacaoError('Valor ou data da liquidação diverge da transação', 409, 'LIQUIDACAO_TRANSACAO_DIVERGENTE')
  }
  return {
    aplicada: false,
    motivo: 'liquidacao_existente',
    alvo_id: liquidacao.origem_id,
    liquidacao_id: liquidacao.id,
    valor_pago: liquidacao.valor,
    data_pagamento: liquidacao.data,
  }
}

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

function obrigacaoQuitada(row) {
  if (!row) return false
  // Consultas reais sempre trazem o previsto. O fallback preserva o contrato
  // defensivo de integrações antigas que só projetavam `valor_pago`.
  if (row.valor_previsto == null) return Number(row.valor_pago ?? 0) > 0
  try {
    return exactMoneyToCents(String(row.valor_pago ?? 0))
      + exactMoneyToCents(String(row.valor_perdido ?? 0))
      >= exactMoneyToCents(String(row.valor_previsto))
  } catch {
    return Number(row.valor_pago ?? 0) > 0
  }
}

async function baixarReceita(db, { tenantId, tx, alvoId, userId, chaveOperacao }) {
  const mod = await import('./receitas-comercial.js')
  const ref = mod.parseIdTitulo(alvoId)
  if (!ref) throw naoEncontrado('Título de receita não encontrado')
  let existente
  if (ref.tipo === 'materializado') {
    existente = await db.query(
      `SELECT id, valor_previsto, valor_pago, COALESCE(valor_perdido, 0) AS valor_perdido, perdido_em
         FROM receita_titulos WHERE id = $1::uuid AND tenant_id = $2::uuid FOR UPDATE`,
      [ref.id, tenantId],
    )
    if (!existente.rows[0]) throw naoEncontrado('Título de receita não encontrado')
  } else {
    existente = await db.query(
      `SELECT id, valor_previsto, valor_pago, COALESCE(valor_perdido, 0) AS valor_perdido, perdido_em FROM receita_titulos
        WHERE tenant_id = $1::uuid AND marca_id = $2::uuid AND competencia = $3::date AND componente = $4
        FOR UPDATE`,
      [tenantId, ref.marca_id, `${ref.mes}-01`, ref.componente],
    )
  }
  const row = existente.rows[0]
  if (row?.perdido_em) throw encerradoErro('receita')
  if (obrigacaoQuitada(row)) {
    return { aplicada: false, motivo: 'ja_baixado', alvo_id: row.id }
  }
  try {
    const item = await mod.receberTitulo(comSavepoints(db), {
      tenantId, id: alvoId, valorIncremental: tx.valor, dataPagamento: tx.data, actorUserId: userId ?? null,
      observacao: 'Baixa via conciliação Asaas', chaveOperacao, retornoBasico: true,
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

async function baixarCustoPorId(db, { tenantId, tx, id, chaveOperacao, userId }) {
  const r = await db.query(
    `SELECT id, valor AS valor_previsto, valor_pago, tipo, cancelado_em
       FROM custos WHERE id = $1::uuid AND tenant_id = $2::uuid FOR UPDATE`,
    [id, tenantId],
  )
  const row = r.rows[0]
  if (!row || row.tipo === 'imposto') throw naoEncontrado('Custo não encontrado')
  if (row.cancelado_em) throw encerradoErro('custo')
  if (obrigacaoQuitada(row)) return { aplicada: false, motivo: 'ja_baixado', alvo_id: row.id }
  const { pagarCusto } = await import('./custos-plano.js')
  const item = await pagarCusto(comSavepoints(db), {
    tenantId, id: row.id, valorIncremental: tx.valor, dataPagamento: tx.data,
    hoje: hojeSaoPaulo(), ator: atorConciliacao(userId), chaveOperacao,
  })
  return { aplicada: true, alvo_id: row.id, valor_pago: item.valor_pago, data_pagamento: item.data_pagamento }
}

async function baixarCusto(db, { tenantId, tx, alvoId, chaveOperacao, userId }) {
  const id = await resolverCustoId(db, tenantId, alvoId)
  if (!id) throw naoEncontrado('Custo não encontrado')
  return baixarCustoPorId(db, { tenantId, tx, id, chaveOperacao, userId })
}

async function baixarApresentadora(db, { tenantId, tx, alvoId, userId, chaveOperacao }) {
  const m = RE_APRES.exec(alvoId)
  if (!m) throw naoEncontrado('Pagamento de apresentadora não encontrado (use apresentadora:<id>:<AAAA-MM>:<fixo|variavel>)')
  const [, apresentadoraId, mes] = m
  const componente = (m[3] ?? 'fixo').toLowerCase()
  const ex = await db.query(
    `SELECT id, valor_pago, cancelado_em FROM apresentadora_pagamentos
      WHERE tenant_id = $1::uuid AND apresentadora_id = $2::uuid AND competencia = $3::date AND componente = $4::text FOR UPDATE`,
    [tenantId, apresentadoraId, `${mes}-01`, componente],
  )
  if (ex.rows[0]?.cancelado_em) throw encerradoErro('custo')
  const pg = await import('./apresentadoras-pagamentos.js')
  let reg
  try {
    reg = await pg.registrarPagamentoApresentadora(comSavepoints(db), {
      tenantId, apresentadoraId, mes, componente, valorIncremental: tx.valor, dataPagamento: tx.data,
      observacao: 'Baixa via conciliação Asaas', userId: userId ?? null, chaveOperacao,
    })
  } catch (error) {
    if (error?.code === 'APRESENTADORA_SEM_SALDO' && ex.rows[0]) {
      return { aplicada: false, motivo: 'ja_baixado', alvo_id: ex.rows[0].id }
    }
    throw error
  }
  if (!reg) throw naoEncontrado('Apresentadora não encontrada')
  const r = await db.query(
    `SELECT id FROM apresentadora_pagamentos
      WHERE tenant_id = $1::uuid AND apresentadora_id = $2::uuid AND competencia = $3::date AND componente = $4::text`,
    [tenantId, apresentadoraId, `${mes}-01`, componente],
  )
  return { aplicada: true, alvo_id: r.rows[0].id, valor_pago: Number(reg.valor_pago), data_pagamento: reg.data_pagamento }
}

// Receita avulsa: alvo = receitas_avulsas.id (UUID). Baixa via serviço receitas-avulsas.js.
async function baixarAvulsa(db, { tenantId, tx, alvoId, userId, chaveOperacao }) {
  if (!UUID_RE.test(alvoId)) throw naoEncontrado('Receita avulsa não encontrada')
  const ex = await db.query(
    `SELECT id, valor_previsto, valor_pago, COALESCE(valor_perdido, 0) AS valor_perdido, perdido_em
       FROM receitas_avulsas WHERE id = $1::uuid AND tenant_id = $2::uuid FOR UPDATE`,
    [alvoId, tenantId],
  )
  const row = ex.rows[0]
  if (!row) throw naoEncontrado('Receita avulsa não encontrada')
  if (row.perdido_em) throw encerradoErro('receita')
  if (obrigacaoQuitada(row)) return { aplicada: false, motivo: 'ja_baixado', alvo_id: row.id }
  const avulsas = await import('./receitas-avulsas.js')
  const item = await avulsas.receberReceitaAvulsa(comSavepoints(db), {
    tenantId, id: row.id, valorPago: tx.valor, dataPagamento: tx.data,
    ator: atorConciliacao(userId), chaveOperacao,
  })
  if (!item) throw naoEncontrado('Receita avulsa não encontrada')
  return { aplicada: true, alvo_id: item.id, valor_pago: item.valor_pago, data_pagamento: item.data_pagamento }
}

// Imposto: custos tipo 'imposto' materializado na baixa; id virtual `imposto:<AAAA-MM>`.
// Virtual => `pagarImposto` (financeiro-agregador) materializa e baixa com o valor/data da transação.
async function baixarImposto(db, { tenantId, tx, alvoId, userId, chaveOperacao }) {
  const m = RE_IMPOSTO.exec(alvoId)
  if (!m && !UUID_RE.test(alvoId)) throw naoEncontrado('Imposto não encontrado (use imposto:<AAAA-MM>)')
  const filtro = m ? 'competencia = $2::date' : 'id = $2::uuid'
  const ref = m ? `${m[1]}-01` : alvoId
  const { rows } = await db.query(
    `SELECT id, valor AS valor_previsto, valor_pago, cancelado_em, to_char(competencia, 'YYYY-MM') AS mes
       FROM custos WHERE tenant_id = $1::uuid AND tipo = 'imposto' AND ${filtro} FOR UPDATE`,
    [tenantId, ref],
  )
  const row = rows[0]
  if (!m && !row) throw naoEncontrado('Imposto não encontrado')
  if (row?.cancelado_em) throw encerradoErro('custo')
  if (obrigacaoQuitada(row)) return { aplicada: false, motivo: 'ja_baixado', alvo_id: row.id }
  const mes = m?.[1] ?? row.mes
  const { pagarImposto } = await import('./financeiro-agregador.js')
  await pagarImposto(comSavepoints(db), {
    tenantId, mes, valorIncremental: tx.valor, dataPagamento: tx.data,
    ator: atorConciliacao(userId), chaveOperacao,
  })
  const { rows: criados } = await db.query(
    `SELECT id FROM custos WHERE tenant_id = $1::uuid AND tipo = 'imposto' AND competencia = $2::date`,
    [tenantId, `${mes}-01`],
  )
  const id = criados[0]?.id
  if (!id || (row && id !== row.id)) throw indisponivel('Imposto do mês não pôde ser materializado')
  return { aplicada: true, alvo_id: id, valor_pago: Number(tx.valor), data_pagamento: tx.data }
}

/**
 * Dá baixa no alvo da conciliação. Retorna
 *   { aplicada, motivo?, alvo_tipo, alvo_id (UUID real), valor_pago?, data_pagamento? }
 * Lança ConciliacaoError (404/409/400) quando o alvo não existe / módulo ausente.
 * `transacao` = { id, valor, data, tipo } (gateway_transacoes).
 */
export async function darBaixaConciliacao(db, { tenantId, transacao, tipo, alvoId, userId } = {}) {
  let centavosTx
  try { centavosTx = exactMoneyToCents(String(transacao?.valor)) } catch { /* rejeitada abaixo */ }
  const tx = { valor: centavosTx > 0n ? centsToExactMoney(centavosTx) : null, data: String(transacao?.data ?? '').slice(0, 10) }
  if (!tx.valor || !isData(tx.data) || !UUID_RE.test(String(transacao?.id ?? ''))) {
    throw new ConciliacaoError('Transação sem id/valor/data válidos', 400, 'TRANSACAO_INVALIDA')
  }
  const id = String(alvoId ?? '')
  const args = { tenantId, tx, alvoId: id, userId, chaveOperacao: chaveConciliacao(transacao.id) }
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
    const status = err?.status ?? err?.statusCode
    if (!(err instanceof ConciliacaoError) && Number.isInteger(status) && status >= 400 && status < 500) {
      throw new ConciliacaoError(err.message, status, err.code ?? 'CONCILIACAO_INVALIDA')
    }
    throw err
  }
  return { alvo_tipo: tipo, ...r }
}

/**
 * Desfaz a baixa gerada por uma conciliação (só chamar se gateway_transacoes.conciliado_baixa).
 * O id da transação identifica a liquidação canônica criada pela conciliação.
 * Vínculos antigos sem fato identificável exigem revisão e permanecem vinculados.
 */
export async function desfazerBaixaConciliacao(db, { tenantId, tipo, alvoId, transacaoId, userId } = {}) {
  if (!UUID_RE.test(String(transacaoId ?? '')) || !UUID_RE.test(String(alvoId ?? ''))) throw revisarBaixa()
  const origens = {
    receita: 'receita_titulo', avulsa: 'receita_avulsa', custo: 'custo',
    apresentadora: 'apresentadora_pagamento', imposto: 'imposto',
  }
  if (!origens[tipo]) throw revisarBaixa()
  // O vínculo antigo só guarda o alvo, não a liquidação. O prefixo da chave
  // identifica o fato criado por ESTA transação; sem ele, uma baixa manual
  // posterior poderia ser estornada por engano. Links legados falham fechados.
  const { rows: fatos } = await db.query(
    `SELECT l.id, l.origem_tipo, l.origem_id,
            (l.valor - COALESCE(SUM(e.valor), 0))::text AS saldo
       FROM financeiro_liquidacoes l
       LEFT JOIN financeiro_estornos e ON e.tenant_id = l.tenant_id AND e.liquidacao_id = l.id
      WHERE l.tenant_id = $1::uuid AND l.idempotencia_chave LIKE $2
      GROUP BY l.id, l.origem_tipo, l.origem_id, l.valor
     HAVING l.valor > COALESCE(SUM(e.valor), 0)`,
    [tenantId, `asaas:${transacaoId}:%`],
  )
  if (fatos.length !== 1 || fatos[0].origem_tipo !== origens[tipo] || fatos[0].origem_id !== alvoId) {
    throw revisarBaixa()
  }
  const chaveOperacao = `asaas:desfazer:${transacaoId}:${randomUUID()}`
  if (tipo === 'receita') {
    const mod = await import('./receitas-comercial.js')
    await mod.desfazerRecebimento(comSavepoints(db), {
      tenantId, id: alvoId, actorId: userId ?? 'asaas.conciliacao',
      actorType: userId ? 'usuario' : 'sistema', chaveOperacao,
    })
    return { desfeita: true }
  }
  if (tipo === 'avulsa') {
    const avulsas = await import('./receitas-avulsas.js')
    const item = await avulsas.desfazerReceitaAvulsa(comSavepoints(db), {
      tenantId, id: alvoId, autoEstorno: true, ator: atorConciliacao(userId),
    })
    if (!item) throw revisarBaixa()
    return { desfeita: true }
  }
  if (tipo === 'custo') {
    const { desfazerBaixaCusto } = await import('./custos-plano.js')
    await desfazerBaixaCusto(comSavepoints(db), {
      tenantId, id: alvoId, hoje: hojeSaoPaulo(), ator: atorConciliacao(userId), chaveOperacao,
    })
    return { desfeita: true }
  }
  if (tipo === 'apresentadora') {
    const { rows } = await db.query(
      `SELECT apresentadora_id, to_char(competencia, 'YYYY-MM') AS mes, componente
         FROM apresentadora_pagamentos WHERE tenant_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
      [tenantId, alvoId],
    )
    if (!rows[0]) throw revisarBaixa()
    const { desfazerPagamentoApresentadora } = await import('./apresentadoras-pagamentos.js')
    const ok = await desfazerPagamentoApresentadora(comSavepoints(db), {
      tenantId, apresentadoraId: rows[0].apresentadora_id, mes: rows[0].mes,
      componente: rows[0].componente, userId: userId ?? null, chaveOperacao,
    })
    if (!ok) throw revisarBaixa()
    return { desfeita: true }
  }
  const { rows } = await db.query(
    `SELECT to_char(competencia, 'YYYY-MM') AS mes FROM custos
      WHERE tenant_id = $1::uuid AND id = $2::uuid AND tipo = 'imposto' FOR UPDATE`,
    [tenantId, alvoId],
  )
  if (!rows[0]) throw revisarBaixa()
  const { desfazerImposto } = await import('./financeiro-agregador.js')
  await desfazerImposto(comSavepoints(db), {
    tenantId, mes: rows[0].mes, ator: atorConciliacao(userId), chaveOperacao,
  })
  return { desfeita: true }
}
