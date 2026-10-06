const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_ORIGENS = 100

// Somente identificadores fixos entram no SQL. Imposto divide a tabela custos
// com as demais despesas, mas é uma origem canônica distinta.
const FONTES = Object.freeze({
  receita_titulo: { tabela: 'receita_titulos', filtro: '', natureza: 'receita', componente: 't.componente', categoria: "CASE WHEN t.componente = 'fixo' THEN 'marca_fixo' ELSE 'marca_comissao' END" },
  receita_avulsa: { tabela: 'receitas_avulsas', filtro: '', natureza: 'receita', componente: 'NULL::text', categoria: "'avulsa'::text" },
  custo: { tabela: 'custos', filtro: "AND tipo IS DISTINCT FROM 'imposto'", natureza: 'custo', componente: 'NULL::text', categoria: "CASE WHEN t.parcela_grupo_id IS NOT NULL THEN 'parcela' WHEN t.recorrente_id IS NOT NULL THEN 'recorrente' ELSE 'manual' END" },
  apresentadora_pagamento: { tabela: 'apresentadora_pagamentos', filtro: '', natureza: 'custo', componente: 't.componente', categoria: "'apresentadora'::text" },
  imposto: { tabela: 'custos', filtro: "AND tipo = 'imposto'", natureza: 'custo', componente: 'NULL::text', categoria: "'imposto'::text" },
})

/**
 * Compara até 100 obrigações explícitas em um único snapshot SQL. A ausência
 * de eventos canônicos em título ainda não pago não é uma divergência.
 * Diferenças são por obrigação; somas globais poderiam se compensar.
 */
export async function compararLiquidacoesLegado(db, { tenantId, origemTipo, origemIds } = {}) {
  if (!RE_UUID.test(String(tenantId ?? ''))) throw new TypeError('tenantId inválido')
  if (typeof origemTipo !== 'string' || !Object.hasOwn(FONTES, origemTipo)) {
    throw new TypeError('origemTipo não suportado')
  }
  const fonte = FONTES[origemTipo]
  if (!Array.isArray(origemIds) || origemIds.length < 1 || origemIds.length > MAX_ORIGENS ||
      origemIds.some((id) => !RE_UUID.test(String(id)))) {
    throw new TypeError(`origemIds deve conter entre 1 e ${MAX_ORIGENS} UUIDs`)
  }
  const ids = [...new Set(origemIds.map((id) => id.toLowerCase()))]

  const { rows } = await db.query(`
    WITH escopo AS (
      SELECT DISTINCT unnest($3::uuid[]) AS id
    ), legado AS (
      SELECT t.id, ${fonte.componente} AS componente,
             ${fonte.categoria} AS origem_categoria,
             COALESCE(t.valor_pago, 0::numeric)::numeric(15,2) AS valor
        FROM ${fonte.tabela} t
        JOIN escopo s ON s.id = t.id
       WHERE t.tenant_id = $1::uuid ${fonte.filtro}
    ), estornos AS (
      SELECT e.liquidacao_id, SUM(e.valor)::numeric(15,2) AS valor
        FROM financeiro_estornos e
        JOIN financeiro_liquidacoes l
          ON l.tenant_id = e.tenant_id AND l.id = e.liquidacao_id
        JOIN escopo s ON s.id = l.origem_id
       WHERE e.tenant_id = $1::uuid AND l.origem_tipo = $2
       GROUP BY e.liquidacao_id
    ), canonico AS (
      SELECT l.origem_id AS id,
             SUM(l.valor - COALESCE(e.valor, 0::numeric))::numeric(15,2) AS valor,
             COUNT(*) FILTER (WHERE l.natureza <> $4)::int AS natureza_incorreta
        FROM financeiro_liquidacoes l
        JOIN escopo s ON s.id = l.origem_id
        LEFT JOIN estornos e ON e.liquidacao_id = l.id
       WHERE l.tenant_id = $1::uuid AND l.origem_tipo = $2
       GROUP BY l.origem_id
    )
    SELECT $2::text AS origem_tipo, COALESCE(g.id, c.id) AS origem_id,
           g.componente, g.origem_categoria,
           g.valor::text AS valor_legado, c.valor::text AS valor_canonico,
           COALESCE(c.natureza_incorreta, 0)::int AS natureza_incorreta,
           (COALESCE(c.valor, 0::numeric) - COALESCE(g.valor, 0::numeric))::numeric(15,2)::text AS diferenca,
           CASE
             WHEN c.natureza_incorreta > 0 THEN 'divergent'
             WHEN g.id IS NULL THEN 'canonical-only'
             WHEN c.id IS NULL AND g.valor <> 0 THEN 'legacy-only'
             WHEN COALESCE(c.valor, 0::numeric) = g.valor THEN 'matching'
             ELSE 'divergent'
           END AS classificacao
      FROM legado g FULL JOIN canonico c ON c.id = g.id
     ORDER BY origem_id
  `, [tenantId, origemTipo, ids, fonte.natureza])
  return rows
}
