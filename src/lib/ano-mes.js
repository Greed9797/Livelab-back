// Convenção única de mês de referência na API: string 'YYYY-MM'.
//
// O banco guarda mês em três formatos diferentes (histórico):
//   - meta_unidade.ano_mes            CHAR(7) 'YYYY-MM'   (migration 100)
//   - metas_apresentadora.mes_referencia / metas_supervisor.mes_referencia
//                                     DATE no dia 01      (migration 090)
//   - cliente_metricas_mensais.ano / .mes  INT + INT      (migration 052)
//
// Nada disso muda aqui. O que este módulo padroniza é a *borda*: o que entra
// pela query string é sempre 'YYYY-MM' validado, e a conversão para o formato
// de cada tabela sai de uma função só.

/** Mês de referência aceito na API: 'YYYY-MM' com mês entre 01 e 12. */
export const ANO_MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export function isAnoMes(value) {
  return typeof value === 'string' && ANO_MES_RE.test(value)
}

/** Mês corrente em 'YYYY-MM' — usado como default quando ?mes não vem. */
export function anoMesCorrente() {
  return new Date().toISOString().slice(0, 7)
}

/**
 * Valida ?mes. Retorna o valor quando ausente (usa o mês corrente) ou válido;
 * lança Error com .statusCode 400 e mensagem pt-BR quando malformado.
 */
export function parseAnoMes(value, { campo = 'mes' } = {}) {
  if (value == null || value === '') return anoMesCorrente()
  if (!isAnoMes(value)) {
    const error = new Error(`${campo} inválido: use o formato AAAA-MM (ex: 2026-07).`)
    error.statusCode = 400
    throw error
  }
  return value
}

/** 'YYYY-MM' → primeiro dia do mês, formato DATE ('YYYY-MM-01'). */
export function anoMesToDate(anoMes) {
  return `${anoMes}-01`
}

/**
 * 'YYYY-MM' → { inicio, proximo } como strings DATE, para filtro sargável:
 *   coluna >= inicio AND coluna < proximo
 * Equivalente exato a to_char(coluna, 'YYYY-MM') = anoMes quando a coluna é
 * DATE (meia-noite implícita, sem timezone envolvido).
 */
export function anoMesRange(anoMes) {
  const [ano, mes] = anoMes.split('-').map(Number)
  const proximoAno = mes === 12 ? ano + 1 : ano
  const proximoMes = mes === 12 ? 1 : mes + 1
  return {
    inicio: `${anoMes}-01`,
    proximo: `${String(proximoAno).padStart(4, '0')}-${String(proximoMes).padStart(2, '0')}-01`,
  }
}
