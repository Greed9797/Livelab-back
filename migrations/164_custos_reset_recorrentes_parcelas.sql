-- Migration 164: custos manuais v2 (reset + recorrentes + parcelas + status derivado)
--
-- Decisão do dono: os registros antigos de `custos` (fonte da verdade era a
-- planilha) são APAGADOS. O status NÃO é persistido: derivado em
-- src/lib/lancamento-status.js a partir de data_vencimento/valor/valor_pago/data_pagamento.
--
-- Idempotente: a limpeza só roda na primeira aplicação (guardada pela ausência da
-- coluna `grupo`), para nunca apagar lançamentos novos numa re-execução.

-- ─── 1. Reset dos custos antigos (+ vínculos de conciliação) ────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'custos' AND column_name = 'grupo'
  ) THEN
    IF to_regclass('public.gateway_transacoes') IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'gateway_transacoes'
                      AND column_name = 'conciliado_com_tipo') THEN
      UPDATE gateway_transacoes
         SET conciliado_com_tipo = NULL,
             conciliado_com_id   = NULL,
             conciliado_em       = NULL,
             conciliado_por      = NULL
       WHERE conciliado_com_tipo = 'custo';
    END IF;
    DELETE FROM custos;
  END IF;
END $$;

-- ─── 2. Novas colunas em custos ─────────────────────────────────────────────
-- custos.valor continua sendo o valor PREVISTO (exposto como valor_previsto na API).
ALTER TABLE custos
  ADD COLUMN IF NOT EXISTS grupo            TEXT NOT NULL DEFAULT 'diversos',
  ADD COLUMN IF NOT EXISTS valor_pago       NUMERIC(15,2) CHECK (valor_pago IS NULL OR valor_pago >= 0),
  ADD COLUMN IF NOT EXISTS data_vencimento  DATE,
  ADD COLUMN IF NOT EXISTS data_pagamento   DATE,
  ADD COLUMN IF NOT EXISTS parcela_grupo_id UUID,
  ADD COLUMN IF NOT EXISTS parcela_num      SMALLINT,
  ADD COLUMN IF NOT EXISTS parcelas_total   SMALLINT,
  ADD COLUMN IF NOT EXISTS recorrente_id    UUID,
  ADD COLUMN IF NOT EXISTS observacao       TEXT,
  ADD COLUMN IF NOT EXISTS atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE custos DROP CONSTRAINT IF EXISTS custos_grupo_check;
ALTER TABLE custos
  ADD CONSTRAINT custos_grupo_check
  CHECK (grupo IN (
    'operacional', 'estrutural', 'diversos', 'investimento', 'prolabore',
    'marketing', 'ferramentas', 'cartao', 'aporte', 'outros'
  ));

ALTER TABLE custos DROP CONSTRAINT IF EXISTS custos_parcela_check;
ALTER TABLE custos
  ADD CONSTRAINT custos_parcela_check
  CHECK (
    (parcela_grupo_id IS NULL AND parcela_num IS NULL AND parcelas_total IS NULL)
    OR (parcela_grupo_id IS NOT NULL AND parcela_num >= 1 AND parcelas_total >= parcela_num)
  );

-- tipo deixa de ser taxonomia principal (o grupo é): CHECK relaxado, valores antigos seguem válidos.
ALTER TABLE custos ALTER COLUMN tipo SET DEFAULT 'outros';
ALTER TABLE custos DROP CONSTRAINT IF EXISTS custos_tipo_check;
ALTER TABLE custos
  ADD CONSTRAINT custos_tipo_check
  CHECK (tipo IN (
    'aluguel', 'salario', 'energia', 'internet', 'outros',
    'fixo', 'variavel', 'imposto', 'aporte', 'servicos', 'ferramentas', 'produtos',
    'parcela', 'recorrente'
  ));

CREATE INDEX IF NOT EXISTS idx_custos_tenant_competencia ON custos(tenant_id, competencia);
CREATE INDEX IF NOT EXISTS idx_custos_tenant_vencimento  ON custos(tenant_id, data_vencimento);
CREATE INDEX IF NOT EXISTS idx_custos_parcela_grupo      ON custos(tenant_id, parcela_grupo_id)
  WHERE parcela_grupo_id IS NOT NULL;

-- ─── 3. custos_recorrentes ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS custos_recorrentes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome           TEXT NOT NULL,
  descricao      TEXT,
  grupo          TEXT NOT NULL DEFAULT 'estrutural',
  valor          NUMERIC(15,2) NOT NULL CHECK (valor >= 0),
  dia_vencimento SMALLINT NOT NULL DEFAULT 5 CHECK (dia_vencimento BETWEEN 1 AND 31),
  mes_offset     SMALLINT NOT NULL DEFAULT 0 CHECK (mes_offset IN (0, 1)),
  inicio         DATE NOT NULL,
  fim            DATE,
  ativo          BOOLEAN NOT NULL DEFAULT true,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT custos_recorrentes_periodo_check CHECK (fim IS NULL OR fim >= inicio),
  CONSTRAINT custos_recorrentes_grupo_check CHECK (grupo IN (
    'operacional', 'estrutural', 'diversos', 'investimento', 'prolabore',
    'marketing', 'ferramentas', 'cartao', 'aporte', 'outros'
  ))
);

CREATE INDEX IF NOT EXISTS idx_custos_recorrentes_tenant ON custos_recorrentes(tenant_id, ativo);

ALTER TABLE custos_recorrentes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS custos_recorrentes_tenant ON custos_recorrentes;
CREATE POLICY custos_recorrentes_tenant ON custos_recorrentes
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Garante WITH CHECK também na policy de custos (060 já faz; reaplicado por segurança)
DROP POLICY IF EXISTS custos_tenant ON custos;
CREATE POLICY custos_tenant ON custos
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- FK: histórico materializado sobrevive à exclusão do modelo recorrente.
ALTER TABLE custos DROP CONSTRAINT IF EXISTS custos_recorrente_id_fkey;
ALTER TABLE custos
  ADD CONSTRAINT custos_recorrente_id_fkey
  FOREIGN KEY (recorrente_id) REFERENCES custos_recorrentes(id) ON DELETE SET NULL;

-- Idempotência da geração mensal (NULLs são distintos: custos avulsos não colidem).
CREATE UNIQUE INDEX IF NOT EXISTS idx_custos_recorrente_competencia
  ON custos(recorrente_id, competencia);
