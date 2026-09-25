/**
 * GMV oficial de uma live, a mesma ordem de liveGmvSql:
 * ads_gmv, depois manual_gmv, depois fat_gerado.
 *
 * Zero gravado continua zero. Coluna ausente (null/undefined/'') não vira zero
 * e não esconde a coluna seguinte. Se as três faltam, o resultado é null —
 * nunca um 0 inventado.
 */

const COLUMNS = ['ads_gmv', 'manual_gmv', 'fat_gerado']

export function moneyOrMissing(value) {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(n) ? n : undefined
}

export function officialLiveGmv(source = {}) {
  if (!source || typeof source !== 'object') return null
  for (const key of COLUMNS) {
    const amount = moneyOrMissing(source[key])
    if (amount !== undefined) return amount
  }
  return null
}

/**
 * Aplica o patch em cima da linha gravada, coluna por coluna, e só então
 * escolhe ads → manual → fat.
 *
 * Um payload que manda só fat_gerado não pode ganhar de um manual_gmv já
 * gravado: a ordem oficial é da linha resultante, não da ordem dos campos
 * que vieram no pedido.
 */
export function officialGmvFromPayload(payload = {}, fallback = {}) {
  const merged = {}
  for (const key of COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) merged[key] = payload[key]
    else merged[key] = fallback?.[key]
  }
  return officialLiveGmv(merged)
}
