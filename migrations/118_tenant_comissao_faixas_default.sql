-- Migration 118: escada padrão de comissão por tenant (fonte editável).
-- A tabela tenant_comissao_faixas_default passa a ser a fonte EDITÁVEL da
-- escada padrão; cada apresentadora continua materializando suas próprias
-- linhas em apresentadora_comissao_faixas (JOINs de diagnóstico intactos).
-- Nova escada (cliff exclusivo, convenção .01 das faixas antigas):
--   0        – 70k   → 1,00%
--   70k+.01  – 150k  → 1,50%
--   150k+.01 –       → 2,00%

-- 1) Tabela default por tenant. Linha presente = vale (sem coluna ativo);
--    delete no endpoint é físico. UNIQUE (tenant_id, gmv_inicio) já serve de
--    índice de lookup/ordenação por tenant — índice extra seria redundante.
CREATE TABLE IF NOT EXISTS tenant_comissao_faixas_default (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  gmv_inicio NUMERIC(15,2) NOT NULL DEFAULT 0,
  gmv_fim NUMERIC(15,2),
  comissao_pct NUMERIC(7,4) NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, gmv_inicio),
  CHECK (gmv_fim IS NULL OR gmv_fim > gmv_inicio),
  CHECK (comissao_pct >= 0 AND comissao_pct <= 100)
);

ALTER TABLE tenant_comissao_faixas_default ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tenant_comissao_faixas_default'
      AND policyname = 'tenant_comissao_faixas_default_tenant'
  ) THEN
    CREATE POLICY tenant_comissao_faixas_default_tenant
      ON tenant_comissao_faixas_default
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  END IF;
END $$;

-- 2) Seed: cada tenant sem NENHUMA linha recebe a escada nova. Idempotente —
--    tenants que já configuraram (ou já foram semeados) não são tocados.
INSERT INTO tenant_comissao_faixas_default (tenant_id, gmv_inicio, gmv_fim, comissao_pct)
SELECT t.id, n.gmv_inicio, n.gmv_fim, n.comissao_pct
  FROM tenants t
 CROSS JOIN (VALUES
    (0::NUMERIC(15,2),      70000::NUMERIC(15,2), 1.00::NUMERIC(7,4)),
    (70000.01,             150000,                1.50),
    (150000.01,              NULL,                2.00)
  ) AS n(gmv_inicio, gmv_fim, comissao_pct)
 WHERE NOT EXISTS (
   SELECT 1 FROM tenant_comissao_faixas_default d WHERE d.tenant_id = t.id
 );

-- 3) Limpeza: faixas soft-deletadas (ativo = false) são lixo lógico de quando
--    o delete era soft; o endpoint passa a fazer hard delete no código.
DELETE FROM apresentadora_comissao_faixas WHERE ativo = false;

-- 4) Propagação inicial: apresentadoras cujo conjunto ATIVO é EXATAMENTE o
--    padrão ANTIGO da 108 (as 4 tuplas abaixo) trocam para a escada nova.
--    Comparação de conjunto: total = 4, todas as linhas casam com alguma tupla
--    do padrão antigo (bool_and) e os 4 gmv_inicio são distintos — como cada
--    tupla tem gmv_inicio único, isso garante 1 ocorrência de cada, sem
--    duplicatas mascarando faixa faltante. gmv_fim usa IS NOT DISTINCT FROM
--    por causa do NULL da faixa aberta. Qualquer outra configuração
--    (personalizada) NÃO é tocada. Idempotente: após a troca o conjunto vira
--    a escada nova e deixa de casar com o padrão antigo.
WITH conjuntos AS (
  SELECT tenant_id, apresentadora_id,
         COUNT(*) AS total,
         COUNT(DISTINCT gmv_inicio) AS inicios_distintos,
         BOOL_AND(
              (gmv_inicio =      0    AND gmv_fim IS NOT DISTINCT FROM  50000 AND comissao_pct = 0.5)
           OR (gmv_inicio =  50000.01 AND gmv_fim IS NOT DISTINCT FROM 150000 AND comissao_pct = 1.0)
           OR (gmv_inicio = 150000.01 AND gmv_fim IS NOT DISTINCT FROM 500000 AND comissao_pct = 1.5)
           OR (gmv_inicio = 500000.01 AND gmv_fim IS NULL                     AND comissao_pct = 2.0)
         ) AS so_padrao_antigo
    FROM apresentadora_comissao_faixas
   WHERE ativo IS TRUE
   GROUP BY tenant_id, apresentadora_id
),
alvo AS (
  SELECT tenant_id, apresentadora_id
    FROM conjuntos
   WHERE total = 4 AND inicios_distintos = 4 AND so_padrao_antigo
),
removidas AS (
  DELETE FROM apresentadora_comissao_faixas f
   USING alvo a
   WHERE f.tenant_id = a.tenant_id
     AND f.apresentadora_id = a.apresentadora_id
     AND f.ativo IS TRUE
  RETURNING f.id
)
INSERT INTO apresentadora_comissao_faixas
  (tenant_id, apresentadora_id, gmv_inicio, gmv_fim, comissao_pct, ativo)
SELECT a.tenant_id, a.apresentadora_id, n.gmv_inicio, n.gmv_fim, n.comissao_pct, true
  FROM alvo a
 CROSS JOIN (VALUES
    (0::NUMERIC(15,2),      70000::NUMERIC(15,2), 1.00::NUMERIC(7,4)),
    (70000.01,             150000,                1.50),
    (150000.01,              NULL,                2.00)
  ) AS n(gmv_inicio, gmv_fim, comissao_pct);

-- 5) Apresentadoras ATIVAS sem NENHUMA faixa ativa recebem a escada nova
--    (mesmo espírito do backfill da 108, agora com a escada atual).
INSERT INTO apresentadora_comissao_faixas
  (tenant_id, apresentadora_id, gmv_inicio, gmv_fim, comissao_pct, ativo)
SELECT a.tenant_id, a.id, n.gmv_inicio, n.gmv_fim, n.comissao_pct, true
  FROM apresentadoras a
 CROSS JOIN (VALUES
    (0::NUMERIC(15,2),      70000::NUMERIC(15,2), 1.00::NUMERIC(7,4)),
    (70000.01,             150000,                1.50),
    (150000.01,              NULL,                2.00)
  ) AS n(gmv_inicio, gmv_fim, comissao_pct)
 WHERE a.ativo IS TRUE
   AND NOT EXISTS (
     SELECT 1 FROM apresentadora_comissao_faixas f
      WHERE f.tenant_id = a.tenant_id
        AND f.apresentadora_id = a.id
        AND f.ativo IS TRUE
   );

-- 6) Função da 108 fica obsoleta: o default agora vem da tabela por tenant
--    (helper getTenantDefaultCommissionTiers no backend). Sem callers em src/.
DROP FUNCTION IF EXISTS apply_default_apresentadora_faixas(UUID, UUID);
