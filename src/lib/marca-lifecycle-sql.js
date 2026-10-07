// Ciclo de vida de marca/cliente: helpers SQL de data_fim.
// "Hoje" em São Paulo (data do contrato/cancelamento — nunca o dia UTC).
export const HOJE_SP_SQL = "(now() AT TIME ZONE 'America/Sao_Paulo')::date"
// Encerrar contrato: preenche data_fim e puxa uma data futura de volta para hoje.
export const DATA_FIM_ENCERRAMENTO_SQL = `data_fim = LEAST(COALESCE(data_fim, ${HOJE_SP_SQL}), ${HOJE_SP_SQL})`
// Reativar: data_fim futura/hoje é limpa; uma já vencida fica (o schema não representa lacuna).
export const DATA_FIM_REATIVACAO_SQL = `data_fim = CASE WHEN data_fim >= ${HOJE_SP_SQL} THEN NULL ELSE data_fim END`

/**
 * Apaga títulos de receita FUTUROS e sem movimento de marcas já encerradas: competência
 * posterior ao mês de data_fim, nada pago e não perdido. O mês de data_fim fica.
 * `where` filtra as marcas (alias `m`) com params posicionais a partir de $2; $1 = tenant_id.
 */
export async function limparTitulosFuturosMarca(db, { tenantId, where, params = [] }) {
  return db.query(
    `DELETE FROM receita_titulos t
      USING marcas m
      WHERE m.tenant_id = $1::uuid AND ${where}
        AND t.tenant_id = m.tenant_id AND t.marca_id = m.id
        AND m.data_fim IS NOT NULL
        AND t.valor_pago = 0 AND t.perdido_em IS NULL
        AND t.suspensao_comercial IS NULL
        AND t.competencia > date_trunc('month', m.data_fim::timestamp)::date`,
    [tenantId, ...params],
  )
}
