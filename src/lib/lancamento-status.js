// Status único de lançamentos financeiros (receita, custo, pagamento de apresentadora).
// Regra: gravamos só data_vencimento, valor_previsto, valor_pago, data_pagamento e o
// encerramento (perdido_em em receitas; cancelado_em em custos — migration 173);
// o status é SEMPRE derivado aqui — nunca persistido.
//
// Precedência:
//   pago       valor_pago >= valor_previsto e valor_pago > 0
//   perdido    receita com perdido_em (cliente não vai pagar; encerra o saldo previsto − pago)
//   cancelado  custo com cancelado_em (não será pago; encerra o saldo previsto − pago)
//   atrasado   sem pagamento (ou parcial) e data_vencimento < hoje
//   parcial    0 < valor_pago < valor_previsto
//   pendente   vencimento no mês corrente e >= hoje (ou sem vencimento no mês corrente)
//   previsto   competência/vencimento em mês futuro (projeção)
//
// Datas são strings 'YYYY-MM-DD' (sem conversão de fuso). `hoje` também.

const num = (v) => Number(v ?? 0)
const r2 = (v) => Math.round(num(v) * 100) / 100

export const STATUS_LANCAMENTO = ['previsto', 'pendente', 'atrasado', 'parcial', 'pago', 'perdido', 'cancelado']
export const STATUS_ENCERRADOS = ['perdido', 'cancelado']

export function statusLancamento({ valor_previsto, valor_pago, data_vencimento, perdido_em, cancelado_em }, hoje) {
  const previsto = num(valor_previsto)
  const pago = num(valor_pago)
  if (pago > 0 && pago >= previsto) return 'pago'
  if (perdido_em) return 'perdido'
  if (cancelado_em) return 'cancelado'
  const venc = data_vencimento ? String(data_vencimento).slice(0, 10) : null
  const atrasado = venc && venc < hoje
  if (pago > 0) return atrasado ? 'atrasado' : 'parcial'
  if (atrasado) return 'atrasado'
  if (!venc) return 'pendente'
  return venc.slice(0, 7) > hoje.slice(0, 7) ? 'previsto' : 'pendente'
}

/** true se o item está encerrado sem pagamento integral (status 'perdido' | 'cancelado'). */
export function lancamentoEncerrado(item) {
  return STATUS_ENCERRADOS.includes(item?.status)
}

/** Saldo encerrado pela perda/cancelamento: previsto − pago (0 se o item não está encerrado). */
export function saldoEncerrado(item) {
  return lancamentoEncerrado(item) ? Math.max(0, r2(r2(item.valor_previsto) - r2(item.valor_pago))) : 0
}

/** TIMESTAMPTZ do pg (Date) ou string → ISO string; null se vazio. */
export function timestampIso(v) {
  if (v == null || v === '') return null
  return v instanceof Date ? v.toISOString() : String(v)
}

/** Motivo opcional de perda/cancelamento: trim, vazio → null, máx. 300 caracteres. */
export const MOTIVO_MAX = 300
export function normalizarMotivo(motivo) {
  if (motivo == null) return null
  const s = String(motivo).trim()
  if (!s) return null
  if (s.length > MOTIVO_MAX) {
    const e = new Error(`motivo deve ter no máximo ${MOTIVO_MAX} caracteres`)
    e.statusCode = 400
    e.code = 'INVALID_MOTIVO'
    throw e
  }
  return s
}
