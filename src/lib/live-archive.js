/**
 * Histórico financeiro de uma live já carregada.
 * Zero gravado conta (manual_gmv, ads_gmv, snapshot de comissão, venda).
 * O default de fat_gerado e comissao_calculada é 0 e não é histórico.
 * Null não vira zero.
 */
export function liveHasFinancialHistory(live) {
  if (!live || typeof live !== 'object') return false
  if (isTrue(live.tem_venda_atribuida) || isTrue(live.tem_revisao_gmv)) return true
  if (hasStoredValue(live.manual_gmv) || hasStoredValue(live.ads_gmv)) return true
  if (hasStoredValue(live.comissao_apresentadora_valor)) return true
  if (isStoredNonZero(live.fat_gerado) || isStoredNonZero(live.comissao_calculada)) return true
  return false
}

function isTrue(value) {
  return value === true || value === 't' || value === 'true'
}

function hasStoredValue(value) {
  if (value == null) return false
  if (typeof value === 'string' && value.trim() === '') return false
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric)
}

function isStoredNonZero(value) {
  if (!hasStoredValue(value)) return false
  return Number(value) !== 0
}
