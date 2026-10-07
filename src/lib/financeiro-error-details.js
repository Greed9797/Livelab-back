const ORIGENS = new Set(['receita_titulo', 'receita_avulsa', 'custo', 'imposto', 'apresentadora_pagamento'])
const MOTIVOS = new Set(['origem_ausente', 'natureza_divergente', 'saldo_divergente', 'pagamento_sem_data'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Only tenant-scoped references supplied by the financial reader leave the API.
// Do not serialize arbitrary error properties, values, SQL or source snapshots.
export function detalhesReconciliacao(error) {
  if (error?.code !== 'FINANCIAL_RECONCILIATION_REQUIRED' || !Array.isArray(error.divergencias)) return {}
  const vistos = new Set()
  const divergencias = []
  for (const item of error.divergencias) {
    if (!ORIGENS.has(item?.origem_tipo) || !UUID.test(item?.origem_id ?? '') || !MOTIVOS.has(item?.motivo)) continue
    const chave = `${item.origem_tipo}:${item.origem_id}:${item.motivo}`
    if (vistos.has(chave)) continue
    vistos.add(chave)
    divergencias.push({ origem_tipo: item.origem_tipo, origem_id: item.origem_id, motivo: item.motivo })
  }
  return { divergencias }
}
