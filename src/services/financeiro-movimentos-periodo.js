import { exactMoneyToCents, centsToExactMoney } from '../lib/money.js'
import { classeDoItem } from '../lib/custo-classe.js'

// Metadata is read once per source, never through one query per payment. Canonical
// events and a legacy projection are mutually exclusive for the same obligation.
export const MOVIMENTOS_PERIODO_SQL = `
WITH origens AS (
 SELECT rt.id, rt.tenant_id, 'receita_titulo'::text AS origem_tipo, 'receita'::text AS natureza,
        CASE WHEN rt.componente='fixo' THEN 'marca_fixo' ELSE 'marca_comissao' END AS origem,
        'receita'::text AS grupo, rt.componente, rt.competencia, rt.data_vencimento,
        rt.valor_pago, rt.data_pagamento, ('Receita ' || rt.componente || ' · ' || m.nome) AS descricao,
        rt.marca_id, m.nome AS marca_nome, rt.cliente_id, cl.nome AS cliente_nome,
        NULL::uuid AS apresentadora_id, NULL::text AS apresentadora_nome,
        NULL::text AS classe_custo, NULL::text AS classe_custo_recorrente
 FROM receita_titulos rt JOIN marcas m ON m.tenant_id=rt.tenant_id AND m.id=rt.marca_id
 LEFT JOIN clientes cl ON cl.tenant_id=rt.tenant_id AND cl.id=rt.cliente_id
 WHERE rt.tenant_id=$1::uuid
 UNION ALL
 SELECT a.id,a.tenant_id,'receita_avulsa','receita','avulsa',a.grupo,NULL,a.competencia,a.data_vencimento,
        a.valor_pago,a.data_pagamento,a.descricao,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL
 FROM receitas_avulsas a WHERE a.tenant_id=$1::uuid
 UNION ALL
 SELECT c.id,c.tenant_id,CASE WHEN c.tipo='imposto' THEN 'imposto' ELSE 'custo' END,'custo',
        CASE WHEN c.tipo='imposto' THEN 'imposto' WHEN c.parcela_grupo_id IS NOT NULL THEN 'parcela'
             WHEN c.recorrente_id IS NOT NULL THEN 'recorrente' ELSE 'manual' END,
        COALESCE(c.grupo,c.tipo),NULL,c.competencia,c.data_vencimento,c.valor_pago,c.data_pagamento,c.descricao,
        NULL,NULL,NULL,NULL,NULL,NULL,c.classe_custo,r.classe_custo
 FROM custos c LEFT JOIN custos_recorrentes r ON r.tenant_id=c.tenant_id AND r.id=c.recorrente_id
 WHERE c.tenant_id=$1::uuid
 UNION ALL
 SELECT p.id,p.tenant_id,'apresentadora_pagamento','custo','apresentadora','apresentadoras',p.componente,
        p.competencia,NULL::date,p.valor_pago,p.data_pagamento,('Pagamento ' || a.nome),
        NULL,NULL,NULL,NULL,p.apresentadora_id,a.nome,NULL,NULL
 FROM apresentadora_pagamentos p JOIN apresentadoras a ON a.tenant_id=p.tenant_id AND a.id=p.apresentadora_id
 WHERE p.tenant_id=$1::uuid
), eventos AS (
 SELECT l.id::text AS id,'liquidacao'::text AS tipo,l.origem_tipo,l.origem_id,l.natureza,
        l.data_liquidacao AS data,l.valor AS valor,'canonico'::text AS fonte
 FROM financeiro_liquidacoes l WHERE l.tenant_id=$1::uuid
 UNION ALL
 SELECT e.id::text,'estorno',l.origem_tipo,l.origem_id,l.natureza,e.data_estorno,-e.valor,'canonico'
 FROM financeiro_estornos e JOIN financeiro_liquidacoes l ON l.tenant_id=e.tenant_id AND l.id=e.liquidacao_id
 WHERE e.tenant_id=$1::uuid
), cobertura AS (
 SELECT origem_tipo,origem_id,COUNT(*) AS quantidade,SUM(valor) AS liquido,
        ARRAY_AGG(DISTINCT natureza) AS naturezas
 FROM eventos GROUP BY origem_tipo,origem_id
), movimentos AS (
 SELECT e.*,o.origem,o.grupo,o.componente,o.competencia,o.data_vencimento,o.descricao,
        o.marca_id,o.marca_nome,o.cliente_id,o.cliente_nome,o.apresentadora_id,o.apresentadora_nome,
        o.classe_custo,o.classe_custo_recorrente,
        NULL::text AS inconsistencia
 FROM eventos e LEFT JOIN origens o ON o.origem_tipo=e.origem_tipo AND o.id=e.origem_id
 WHERE e.data BETWEEN $2::date AND $3::date AND ($4::date IS NULL OR e.data >= $4::date)
 UNION ALL
 SELECT ('legado:'||o.origem_tipo||':'||o.id),'liquidacao',o.origem_tipo,o.id,o.natureza,
        o.data_pagamento,o.valor_pago,'legado',o.origem,o.grupo,o.componente,o.competencia,o.data_vencimento,
        o.descricao,o.marca_id,o.marca_nome,o.cliente_id,o.cliente_nome,o.apresentadora_id,o.apresentadora_nome,
        o.classe_custo,o.classe_custo_recorrente,NULL
 FROM origens o LEFT JOIN cobertura c ON c.origem_tipo=o.origem_tipo AND c.origem_id=o.id
 WHERE c.origem_id IS NULL AND o.valor_pago>0 AND o.data_pagamento BETWEEN $2::date AND $3::date
       AND ($4::date IS NULL OR o.data_pagamento >= $4::date)
 UNION ALL
 SELECT ('sem-data:'||o.origem_tipo||':'||o.id),'revisao',o.origem_tipo,o.id,o.natureza,NULL::date,0,'legado',
        o.origem,o.grupo,o.componente,o.competencia,o.data_vencimento,o.descricao,o.marca_id,o.marca_nome,
        o.cliente_id,o.cliente_nome,o.apresentadora_id,o.apresentadora_nome,o.classe_custo,o.classe_custo_recorrente,
        'pagamento_sem_data'
 FROM origens o WHERE o.valor_pago>0 AND o.data_pagamento IS NULL
       AND NOT EXISTS (SELECT 1 FROM cobertura c WHERE c.origem_tipo=o.origem_tipo AND c.origem_id=o.id)
 UNION ALL
 -- Coverage is all-time, independently of the date filter above. One undated
 -- review row per inconsistent obligation prevents a partial legacy balance
 -- from silently disappearing when its canonical events fall outside the period.
 SELECT ('reconciliacao:'||c.origem_tipo||':'||c.origem_id),'revisao',c.origem_tipo,c.origem_id,
        o.natureza,NULL::date,0,'canonico',o.origem,o.grupo,o.componente,o.competencia,o.data_vencimento,
        o.descricao,o.marca_id,o.marca_nome,o.cliente_id,o.cliente_nome,o.apresentadora_id,o.apresentadora_nome,
        o.classe_custo,o.classe_custo_recorrente,r.inconsistencia
 FROM cobertura c LEFT JOIN origens o ON o.origem_tipo=c.origem_tipo AND o.id=c.origem_id
 CROSS JOIN LATERAL (
   SELECT CASE WHEN o.id IS NULL THEN 'origem_ausente'
               WHEN c.naturezas IS DISTINCT FROM ARRAY[o.natureza] THEN 'natureza_divergente'
               WHEN COALESCE(o.valor_pago,0)<>c.liquido THEN 'saldo_divergente' END AS inconsistencia
 ) r
 WHERE r.inconsistencia IS NOT NULL
)
SELECT *,valor::text AS valor,to_char(data,'YYYY-MM-DD') AS data,
       to_char(competencia,'YYYY-MM-DD') AS competencia,to_char(data_vencimento,'YYYY-MM-DD') AS data_vencimento
FROM movimentos ORDER BY movimentos.data,movimentos.id`

export async function lerMovimentosFinanceirosPeriodo(db, { tenantId, de, ate, dataCorte = null }) {
  if (!tenantId || !/^\d{4}-\d{2}-\d{2}$/.test(de ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(ate ?? '') || de > ate) {
    throw Object.assign(new Error('Escopo financeiro inválido'), { statusCode: 400, code: 'INVALID_PERIOD' })
  }
  const { rows } = await db.query(MOVIMENTOS_PERIODO_SQL, [tenantId, de, ate, dataCorte])
  const divergencias = rows.filter((r) => r.inconsistencia)
  // Partial legacy/canonical coverage cannot be assigned to an invented date.
  // Surface the exact obligations; never silently add a residual to the last payment.
  if (divergencias.length) throw Object.assign(new Error('Recebimentos e pagamentos precisam de reconciliação antes de calcular o caixa.'), {
    statusCode: 409, code: 'FINANCIAL_RECONCILIATION_REQUIRED', divergencias: divergencias.map((r) => ({ origem_tipo: r.origem_tipo, origem_id: r.origem_id, motivo: r.inconsistencia })),
  })
  const itens = rows.map((r) => ({ ...r, valor: Number(r.valor), classe: classeDoItem(r) }))
  return { itens, reconciliacao: { eventos_canonicos: itens.filter((r) => r.fonte === 'canonico').length, movimentos_legados: itens.filter((r) => r.fonte === 'legado').length } }
}

export function resumirRecebimentos(itens) {
  const receitas = itens.filter((i) => i.natureza === 'receita')
  const soma = (xs) => Number(centsToExactMoney(xs.reduce((n, i) => n + exactMoneyToCents(String(i.valor)), 0n)))
  return {
    operacional: soma(receitas.filter((i) => !(i.origem === 'avulsa' && i.grupo === 'aporte'))),
    aportes: soma(receitas.filter((i) => i.origem === 'avulsa' && i.grupo === 'aporte')),
    total: soma(receitas), itens: receitas,
  }
}
