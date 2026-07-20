// ── Dias úteis (seg–sex, sem feriados — simplificação documentada) ──────────
// Não inclui feriados nacionais/estaduais. A precisão é suficiente para
// projeção de ritmo intradia; se precisar de feriados, injetar calendário.
function _isWeekday(date) {
  const d = date.getDay() // 0=dom, 6=sab
  return d !== 0 && d !== 6
}

/**
 * Conta dias úteis (seg–sex) no mês YYYY-MM.
 * Junho/2026 = 22 dias úteis, validado no teste.
 */
export function countWeekdaysInMonth(yyyy, mm) {
  const total = new Date(yyyy, mm, 0).getDate() // dias no mês
  let count = 0
  for (let d = 1; d <= total; d++) {
    if (_isWeekday(new Date(yyyy, mm - 1, d))) count++
  }
  return count
}

/**
 * Conta quantos dias úteis transcorreram até (e incluindo) `dayOfMonth`.
 * Se o próprio dia for útil, é contado; se for fim de semana, não conta.
 */
export function countWeekdaysUpTo(yyyy, mm, dayOfMonth) {
  let count = 0
  for (let d = 1; d <= dayOfMonth; d++) {
    if (_isWeekday(new Date(yyyy, mm - 1, d))) count++
  }
  return count
}
