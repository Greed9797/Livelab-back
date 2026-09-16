-- Migration 151 — histórico mensal de condições comerciais das marcas.
--
-- Esta migration é somente aditiva. O backfill fotografa os campos atuais da
-- marca como baseline técnico e não recalcula lives, vendas, boletos ou
-- snapshots. A fonte temporal só será usada depois que os leitores forem
-- migrados nas tarefas T9–T13.

-- A FK composta abaixo garante que tenant_id e marca_id pertençam ao mesmo
-- registro de marca. O id da marca já é globalmente único, mas a composição
-- evita aceitar uma combinação forjada quando o schema for restaurado com
-- chaves de outro tenant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'marcas_tenant_id_id_key'
       AND conrelid = 'public.marcas'::regclass
  ) THEN
    ALTER TABLE marcas
      ADD CONSTRAINT marcas_tenant_id_id_key UNIQUE (tenant_id, id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS marca_condicoes_comerciais (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  marca_id                   UUID NOT NULL,
  inicio_vigencia            DATE NOT NULL,
  fixo_mensal                NUMERIC(15,2) NOT NULL DEFAULT 0,
  comissao_franquia_pct      NUMERIC(5,2) NOT NULL DEFAULT 0,
  comissao_franqueadora_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,
  tipo_cobranca              TEXT NOT NULL DEFAULT 'fixo_mais_comissao',
  fixo_confirmado             BOOLEAN NOT NULL DEFAULT FALSE,
  comissao_confirmada         BOOLEAN NOT NULL DEFAULT FALSE,
  origem                      TEXT NOT NULL DEFAULT 'gestao',
  motivo                      TEXT,
  created_by                  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revision                    INTEGER NOT NULL DEFAULT 1,
  cancelled_at                TIMESTAMPTZ,
  idempotency_key             TEXT,
  payload_hash                TEXT,
  CONSTRAINT marca_condicoes_marca_fk
    FOREIGN KEY (tenant_id, marca_id)
    REFERENCES marcas (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT marca_condicoes_inicio_mes_check
    CHECK (EXTRACT(DAY FROM inicio_vigencia) = 1),
  CONSTRAINT marca_condicoes_fixo_check
    CHECK (fixo_mensal >= 0),
  CONSTRAINT marca_condicoes_franquia_pct_check
    CHECK (comissao_franquia_pct >= 0 AND comissao_franquia_pct <= 100),
  CONSTRAINT marca_condicoes_franqueadora_pct_check
    CHECK (comissao_franqueadora_pct >= 0 AND comissao_franqueadora_pct <= 100),
  CONSTRAINT marca_condicoes_tipo_cobranca_check
    CHECK (tipo_cobranca IN ('fixo_mais_comissao', 'fixo_ou_comissao')),
  CONSTRAINT marca_condicoes_origem_check
    CHECK (origem IN ('gestao', 'importacao', 'legado_nao_verificado', 'correcao')),
  CONSTRAINT marca_condicoes_revision_check
    CHECK (revision > 0),
  CONSTRAINT marca_condicoes_idempotency_key_check
    CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255)
);

-- Períodos são [início, próximo início). Cancelamento é histórico e libera a
-- chave somente para correção administrativa explícita; o serviço não apaga
-- versões usadas.
CREATE UNIQUE INDEX IF NOT EXISTS marca_condicoes_vigencia_uk
  ON marca_condicoes_comerciais (tenant_id, marca_id, inicio_vigencia)
  WHERE cancelled_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS marca_condicoes_idempotency_uk
  ON marca_condicoes_comerciais (tenant_id, marca_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS marca_condicoes_lookup_idx
  ON marca_condicoes_comerciais (tenant_id, marca_id, inicio_vigencia DESC)
  WHERE cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS marca_condicoes_created_by_idx
  ON marca_condicoes_comerciais (tenant_id, created_by, created_at DESC);

-- Baseline técnico idempotente. O valor zero não é convertido em confirmação:
-- a UI poderá diferenciar “Sem fixo/comissão” de “A revisar”.
INSERT INTO marca_condicoes_comerciais (
  tenant_id,
  marca_id,
  inicio_vigencia,
  fixo_mensal,
  comissao_franquia_pct,
  comissao_franqueadora_pct,
  tipo_cobranca,
  fixo_confirmado,
  comissao_confirmada,
  origem,
  motivo
)
SELECT
  m.tenant_id,
  m.id,
  DATE '1900-01-01',
  COALESCE(m.valor_fixo_minimo, 0),
  COALESCE(m.comissao_franquia_pct, 0),
  COALESCE(m.comissao_franqueadora_pct, 0),
  COALESCE(m.tipo_cobranca, 'fixo_mais_comissao'),
  FALSE,
  FALSE,
  'legado_nao_verificado',
  'Baseline técnico criado pela migration 151; valores históricos não foram inferidos.'
FROM marcas m
WHERE NOT EXISTS (
  SELECT 1
    FROM marca_condicoes_comerciais c
   WHERE c.tenant_id = m.tenant_id
     AND c.marca_id = m.id
     AND c.inicio_vigencia = DATE '1900-01-01'
     AND c.cancelled_at IS NULL
);

ALTER TABLE marca_condicoes_comerciais ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS marca_condicoes_comerciais_tenant ON marca_condicoes_comerciais;
CREATE POLICY marca_condicoes_comerciais_tenant ON marca_condicoes_comerciais
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMENT ON TABLE marca_condicoes_comerciais IS
  'Condições comerciais mensais por marca. A vigência é resolvida pela data do fato gerador; baseline legado não verificado não confirma zeros.';
COMMENT ON COLUMN marca_condicoes_comerciais.inicio_vigencia IS
  'Primeiro dia do mês em America/Sao_Paulo; intervalo [início, próxima versão).';
COMMENT ON COLUMN marca_condicoes_comerciais.payload_hash IS
  'Digest do payload normalizado usado para rejeitar retry idempotente com conteúdo diferente.';
