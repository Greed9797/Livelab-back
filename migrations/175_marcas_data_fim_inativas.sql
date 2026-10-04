-- 175 — Backfill de marcas.data_fim para marcas (de qualquer tipo) já inativas/arquivadas.
-- Cancelar/arquivar não preenchia data_fim, então a Receita (fixo por vigência e
-- "em apuração") continuava listando esses clientes. A partir daqui a escrita
-- preenche data_fim; este UPDATE corrige o legado: data do cancelamento no audit_log
-- (clientes.status_alterado → cancelado/arquivado), senão a data da última alteração — sempre em
-- America/Sao_Paulo (o cast direto de timestamptz usaria a TZ da sessão, normalmente UTC).
-- Idempotente (só toca linhas com data_fim IS NULL).

UPDATE marcas
   SET data_fim = COALESCE(
         (SELECT (MAX(a.criado_em) AT TIME ZONE 'America/Sao_Paulo')::date
            FROM audit_log a
           WHERE a.tenant_id = marcas.tenant_id
             AND a.entity_type = 'cliente'
             AND a.entity_id = marcas.cliente_id
             AND a.action = 'clientes.status_alterado'
             AND a.metadata->>'new_status' IN ('cancelado', 'cancelado_automaticamente', 'arquivado')),
         (atualizado_em AT TIME ZONE 'America/Sao_Paulo')::date
       )
 WHERE status IN ('inativa', 'arquivada')
   AND data_fim IS NULL;

COMMENT ON COLUMN marcas.data_fim IS 'Fim do contrato do cliente; preenchido ao cancelar/arquivar (175). Fonte única de vigência na Receita.';

-- Títulos materializados e intocados (nada pago, não perdidos) de competências POSTERIORES ao mês
-- de data_fim não são mais devidos: mesma regra do cancelamento em runtime (limparTitulosFuturosMarca).
-- Sem isso, clientes cancelados/arquivados antes desta versão seguem em "a receber" e no caixa projetado.
-- Idempotente. As linhas removidas ficam em receita_titulos_removidos_175 (restaurável).
CREATE TABLE IF NOT EXISTS receita_titulos_removidos_175 AS
  SELECT t.*, now() AS removido_em FROM receita_titulos t WHERE false;
-- Backup interno: RLS sem policy = invisível para roles da API (Supabase).
ALTER TABLE receita_titulos_removidos_175 ENABLE ROW LEVEL SECURITY;

INSERT INTO receita_titulos_removidos_175
SELECT t.*, now()
  FROM receita_titulos t
  JOIN marcas m ON t.tenant_id = m.tenant_id AND t.marca_id = m.id
 WHERE m.status IN ('inativa', 'arquivada')
   AND m.data_fim IS NOT NULL
   AND t.valor_pago = 0 AND t.perdido_em IS NULL
   AND t.competencia > date_trunc('month', m.data_fim::timestamp)::date;

DELETE FROM receita_titulos t
 USING marcas m
 WHERE t.tenant_id = m.tenant_id AND t.marca_id = m.id
   AND m.status IN ('inativa', 'arquivada')
   AND m.data_fim IS NOT NULL
   AND t.valor_pago = 0 AND t.perdido_em IS NULL
   AND t.competencia > date_trunc('month', m.data_fim::timestamp)::date;
