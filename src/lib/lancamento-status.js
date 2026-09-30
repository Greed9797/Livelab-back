// Status único de lançamentos financeiros (receita, custo, pagamento de apresentadora).
// Regra: gravamos só data_vencimento, valor_previsto, valor_pago e data_pagamento;
// o status é SEMPRE derivado aqui — nunca persistido.
//
//   pago       valor_pago >= valor_previsto e valor_pago > 0
//   parcial    0 < valor_pago < valor_previsto
//   atrasado   sem pagamento (ou parcial) e data_vencimento < hoje
//   pendente   vencimento no mês corrente e >= hoje (ou sem vencimento no mês corrente)
//   previsto   competência/vencimento em mês futuro (projeção)
//
// Datas são strings 'YYYY-MM-DD' (sem conversão de fuso). `hoje` também.

const num = (v) => Number(v ?? 0)

export const STATUS_LANCAMENTO = ['previsto', 'pendente', 'atrasado', 'parcial', 'pago']

export function statusLancamento({ valor_previsto, valor_pago, data_vencimento }, hoje) {
  const previsto = num(valor_previsto)
  const pago = num(valor_pago)
  if (pago > 0 && pago >= previsto) return 'pago'
  const venc = data_vencimento ? String(data_vencimento).slice(0, 10) : null
  const atrasado = venc && venc < hoje
  if (pago > 0) return atrasado ? 'atrasado' : 'parcial'
  if (atrasado) return 'atrasado'
  if (!venc) return 'pendente'
  return venc.slice(0, 7) > hoje.slice(0, 7) ? 'previsto' : 'pendente'
}
