-- Migration 087: núcleo financeiro baseado na planilha CONTROLE_FINANCEIRO_LIVELAB
--
-- Objetivo (frente C):
--   1. contratos.dia_vencimento — dia do mês em que o cliente paga (5/10/15/20/25/30).
--   2. custos: grupo (taxonomia da planilha), status previsto|pago, data_pagamento,
--      dia_vencimento, cartao, recorrente_id, observacao. CHECK de `tipo` ampliado
--      mantendo os valores antigos válidos.
--   3. custos_recorrentes — itens de custo fixo mensal que são materializados em
--      `custos` mês a mês (idempotente por (recorrente_id, competencia)).
--   4. receitas_previstas — previsto x recebido por contrato/competência
--      (fixo + comissão separados), unique(contrato_id, competencia).
--   5. tenants.aliquota_imposto_pct (default 6%).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS, CREATE ... IF NOT EXISTS,
-- DROP CONSTRAINT/POLICY IF EXISTS antes de recriar.

-- ─── 1. contratos.dia_vencimento ────────────────────────────────────────────
ALTER TABLE contratos
  ADD COLUMN IF NOT EXISTS dia_vencimento SMALLINT;

ALTER TABLE contratos DROP CONSTRAINT IF EXISTS contratos_dia_vencimento_check;
ALTER TABLE contratos
  ADD CONSTRAINT contratos_dia_vencimento_check
  CHECK (dia_vencimento IS NULL OR dia_vencimento BETWEEN 1 AND 31);

COMMENT ON COLUMN contratos.dia_vencimento IS
  'Dia do mês de vencimento da cobrança (fixo + comissão do mês anterior). NULL = fim do mês.';

-- Leitura do financeiro: contratos vigentes por tenant no período
CREATE INDEX IF NOT EXISTS idx_contratos_tenant_ativado
  ON contratos(tenant_id, ativado_em)
  WHERE ativado_em IS NOT NULL;

-- ─── 2. custos: novos campos ────────────────────────────────────────────────
-- status é adicionado num bloco DO para que, apenas na primeira aplicação,
-- os custos legados (lançados antes desta migration, quando todo custo era
-- tratado como realizado no /resumo) sejam marcados como 'pago'.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'custos' AND column_name = 'status'
  ) THEN
    ALTER TABLE custos ADD COLUMN status TEXT NOT NULL DEFAULT 'previsto';
    ALTER TABLE custos ADD COLUMN IF NOT EXISTS data_pagamento DATE;
    UPDATE custos SET status = 'pago', data_pagamento = competencia;
  END IF;
END $$;

ALTER TABLE custos
  ADD COLUMN IF NOT EXISTS grupo          TEXT,
  ADD COLUMN IF NOT EXISTS data_pagamento DATE,
  ADD COLUMN IF NOT EXISTS dia_vencimento SMALLINT,
  ADD COLUMN IF NOT EXISTS cartao         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recorrente_id  UUID,
  ADD COLUMN IF NOT EXISTS observacao     TEXT,
  ADD COLUMN IF NOT EXISTS atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Backfill do grupo a partir do tipo legado
UPDATE custos SET grupo = CASE tipo
    WHEN 'aluguel'  THEN 'estrutural'
    WHEN 'energia'  THEN 'estrutural'
    WHEN 'internet' THEN 'estrutural'
    WHEN 'salario'  THEN 'operacional'
    ELSE 'diversos'
  END
WHERE grupo IS NULL;

ALTER TABLE custos ALTER COLUMN grupo SET DEFAULT 'diversos';
ALTER TABLE custos ALTER COLUMN grupo SET NOT NULL;
ALTER TABLE custos ALTER COLUMN tipo  SET DEFAULT 'outros';

ALTER TABLE custos DROP CONSTRAINT IF EXISTS custos_grupo_check;
ALTER TABLE custos
  ADD CONSTRAINT custos_grupo_check
  CHECK (grupo IN (
    'operacional', 'investimento', 'diversos', 'estrutural', 'prolabore',
    'variavel_comissao', 'variavel_produtos', 'variavel_diversos', 'cartao',
    'aporte'
  ));

ALTER TABLE custos DROP CONSTRAINT IF EXISTS custos_status_check;
ALTER TABLE custos
  ADD CONSTRAINT custos_status_check CHECK (status IN ('previsto', 'pago'));

ALTER TABLE custos DROP CONSTRAINT IF EXISTS custos_dia_vencimento_check;
ALTER TABLE custos
  ADD CONSTRAINT custos_dia_vencimento_check
  CHECK (dia_vencimento IS NULL OR dia_vencimento BETWEEN 1 AND 31);

-- CHECK de tipo: mantém valores antigos + categorias novas
ALTER TABLE custos DROP CONSTRAINT IF EXISTS custos_tipo_check;
ALTER TABLE custos
  ADD CONSTRAINT custos_tipo_check
  CHECK (tipo IN (
    'aluguel', 'salario', 'energia', 'internet', 'outros',
    'fixo', 'variavel', 'imposto', 'aporte', 'servicos', 'ferramentas', 'produtos'
  ));

CREATE INDEX IF NOT EXISTS idx_custos_tenant_competencia
  ON custos(tenant_id, competencia);

-- ─── 3. custos_recorrentes ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS custos_recorrentes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome           TEXT NOT NULL,
  descricao      TEXT,
  grupo          TEXT NOT NULL DEFAULT 'estrutural',
  valor          NUMERIC(15,2) NOT NULL CHECK (valor >= 0),
  dia_vencimento SMALLINT CHECK (dia_vencimento IS NULL OR dia_vencimento BETWEEN 1 AND 31),
  cartao         BOOLEAN NOT NULL DEFAULT false,
  inicio         DATE NOT NULL,
  fim            DATE,
  ativo          BOOLEAN NOT NULL DEFAULT true,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT custos_recorrentes_periodo_check CHECK (fim IS NULL OR fim >= inicio),
  CONSTRAINT custos_recorrentes_grupo_check CHECK (grupo IN (
    'operacional', 'investimento', 'diversos', 'estrutural', 'prolabore',
    'variavel_comissao', 'variavel_produtos', 'variavel_diversos', 'cartao',
    'aporte'
  ))
);

CREATE INDEX IF NOT EXISTS idx_custos_recorrentes_tenant
  ON custos_recorrentes(tenant_id, ativo);

ALTER TABLE custos_recorrentes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS custos_recorrentes_tenant ON custos_recorrentes;
CREATE POLICY custos_recorrentes_tenant ON custos_recorrentes
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- FK custos.recorrente_id → custos_recorrentes (histórico sobrevive à exclusão do modelo)
ALTER TABLE custos DROP CONSTRAINT IF EXISTS custos_recorrente_id_fkey;
ALTER TABLE custos
  ADD CONSTRAINT custos_recorrente_id_fkey
  FOREIGN KEY (recorrente_id) REFERENCES custos_recorrentes(id) ON DELETE SET NULL;

-- Idempotência da geração mensal: 1 lançamento por (recorrente, competência).
-- NULLs são distintos em índices únicos, então custos avulsos não são afetados.
CREATE UNIQUE INDEX IF NOT EXISTS idx_custos_recorrente_competencia
  ON custos(recorrente_id, competencia);

-- ─── 4. receitas_previstas ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS receitas_previstas (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contrato_id       UUID REFERENCES contratos(id) ON DELETE SET NULL,
  cliente_id        UUID REFERENCES clientes(id) ON DELETE SET NULL,
  descricao         TEXT,
  competencia       DATE NOT NULL,          -- sempre dia 1 do mês de cobrança
  fixo_previsto     NUMERIC(15,2) NOT NULL DEFAULT 0,
  comissao_prevista NUMERIC(15,2) NOT NULL DEFAULT 0,
  gmv_base          NUMERIC(15,2) NOT NULL DEFAULT 0,   -- GMV do mês anterior que gerou a comissão
  fixo_recebido     NUMERIC(15,2) NOT NULL DEFAULT 0,
  comissao_recebida NUMERIC(15,2) NOT NULL DEFAULT 0,
  dia_vencimento    SMALLINT CHECK (dia_vencimento IS NULL OR dia_vencimento BETWEEN 1 AND 31),
  data_recebimento  DATE,
  status            TEXT NOT NULL DEFAULT 'previsto'
                      CHECK (status IN ('previsto', 'parcial', 'recebido', 'atrasado')),
  ajuste_manual     BOOLEAN NOT NULL DEFAULT false, -- true = geração não sobrescreve os previstos
  observacao        TEXT,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT receitas_previstas_competencia_dia1 CHECK (EXTRACT(DAY FROM competencia) = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_receitas_previstas_contrato_competencia
  ON receitas_previstas(contrato_id, competencia);
CREATE INDEX IF NOT EXISTS idx_receitas_previstas_tenant_competencia
  ON receitas_previstas(tenant_id, competencia);

ALTER TABLE receitas_previstas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS receitas_previstas_tenant ON receitas_previstas;
CREATE POLICY receitas_previstas_tenant ON receitas_previstas
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ─── 5. tenants.aliquota_imposto_pct ────────────────────────────────────────
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS aliquota_imposto_pct NUMERIC(5,2) NOT NULL DEFAULT 6;

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_aliquota_imposto_pct_check;
ALTER TABLE tenants
  ADD CONSTRAINT tenants_aliquota_imposto_pct_check
  CHECK (aliquota_imposto_pct >= 0 AND aliquota_imposto_pct <= 100);

COMMENT ON COLUMN tenants.aliquota_imposto_pct IS
  'Alíquota de imposto sobre a receita do mês usada no DRE/fluxo de caixa (default 6% — Simples).';

-- ============================================================================
-- Fim da migration 087
-- ============================================================================
