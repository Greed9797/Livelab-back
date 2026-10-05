-- 181 — FIN-02: eventos imutáveis de perda/reversão de receitas.
--
-- Migration estritamente aditiva: não faz backfill, não altera saldo, não muda
-- writers e não substitui os campos legado perdido_* da migration 173.
-- valor_perdido é uma projeção nullable para o writer canônico futuro:
-- NULL preserva a semântica legada; valor >= 0 permite representar perda parcial.

ALTER TABLE receita_titulos
  ADD COLUMN IF NOT EXISTS valor_perdido NUMERIC(15,2) NULL;

ALTER TABLE receitas_avulsas
  ADD COLUMN IF NOT EXISTS valor_perdido NUMERIC(15,2) NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'receita_titulos_valor_perdido_check'
       AND conrelid = 'receita_titulos'::regclass
  ) THEN
    ALTER TABLE receita_titulos
      ADD CONSTRAINT receita_titulos_valor_perdido_check
      CHECK (valor_perdido IS NULL OR valor_perdido >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'receitas_avulsas_valor_perdido_check'
       AND conrelid = 'receitas_avulsas'::regclass
  ) THEN
    ALTER TABLE receitas_avulsas
      ADD CONSTRAINT receitas_avulsas_valor_perdido_check
      CHECK (valor_perdido IS NULL OR valor_perdido >= 0) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN receita_titulos.valor_perdido IS
  'FIN-02: projeção canônica futura da perda líquida. NULL mantém semântica legado perdido_*; pode representar perda parcial.';
COMMENT ON COLUMN receitas_avulsas.valor_perdido IS
  'FIN-02: projeção canônica futura da perda líquida. NULL mantém semântica legado perdido_*; pode representar perda parcial.';

CREATE TABLE IF NOT EXISTS financeiro_perdas_eventos (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  tipo                   TEXT NOT NULL,
  origem_tipo            TEXT NOT NULL,
  origem_id              UUID NOT NULL,
  valor                  NUMERIC(15,2) NOT NULL,
  motivo                 TEXT NOT NULL,
  ator_tipo              TEXT NOT NULL,
  ator_id                TEXT NOT NULL,
  competencia_obrigacao  DATE NOT NULL,
  registrado_em          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  perda_original_id      UUID NULL,
  perda_original_tipo    TEXT NULL,
  chave_operacao         UUID NULL,
  requisicao             JSONB NULL,
  CONSTRAINT financeiro_perdas_eventos_tipo_check
    CHECK (tipo IN ('perda', 'reversao')),
  CONSTRAINT financeiro_perdas_eventos_origem_tipo_check
    CHECK (origem_tipo IN ('receita_titulo', 'receita_avulsa')),
  CONSTRAINT financeiro_perdas_eventos_valor_check
    CHECK (valor > 0),
  CONSTRAINT financeiro_perdas_eventos_motivo_check
    CHECK (btrim(motivo) <> ''),
  CONSTRAINT financeiro_perdas_eventos_ator_tipo_check
    CHECK (btrim(ator_tipo) <> ''),
  CONSTRAINT financeiro_perdas_eventos_ator_id_check
    CHECK (btrim(ator_id) <> ''),
  CONSTRAINT financeiro_perdas_eventos_competencia_check
    CHECK (EXTRACT(DAY FROM competencia_obrigacao) = 1),
  CONSTRAINT financeiro_perdas_eventos_reversao_check
    CHECK (
      (tipo = 'perda' AND perda_original_id IS NULL AND perda_original_tipo IS NULL)
      OR
      (tipo = 'reversao' AND perda_original_id IS NOT NULL AND perda_original_tipo = 'perda')
    ),
  CONSTRAINT financeiro_perdas_eventos_requisicao_check
    CHECK ((chave_operacao IS NULL) = (requisicao IS NULL)),
  CONSTRAINT financeiro_perdas_eventos_chave_uk UNIQUE (tenant_id, chave_operacao),
  CONSTRAINT financeiro_perdas_eventos_referencia_uk
    UNIQUE (tenant_id, id, tipo, origem_tipo, origem_id, competencia_obrigacao),
  CONSTRAINT financeiro_perdas_eventos_reversao_fk
    FOREIGN KEY (
      tenant_id,
      perda_original_id,
      perda_original_tipo,
      origem_tipo,
      origem_id,
      competencia_obrigacao
    ) REFERENCES financeiro_perdas_eventos (
      tenant_id,
      id,
      tipo,
      origem_tipo,
      origem_id,
      competencia_obrigacao
    ) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS financeiro_perdas_eventos_origem_idx
  ON financeiro_perdas_eventos (
    tenant_id, origem_tipo, origem_id, competencia_obrigacao, registrado_em
  );

CREATE INDEX IF NOT EXISTS financeiro_perdas_eventos_registro_idx
  ON financeiro_perdas_eventos (tenant_id, registrado_em);

COMMENT ON TABLE financeiro_perdas_eventos IS
  'FIN-02: eventos imutáveis de perda e reversão para títulos comerciais e receitas avulsas; sem backfill e sem efeito de saldo nesta migration.';
COMMENT ON COLUMN financeiro_perdas_eventos.registrado_em IS
  'Instante do evento. O Resultado reconhece perda/reversão no mês deste registro; competencia_obrigacao preserva a competência de origem.';
COMMENT ON COLUMN financeiro_perdas_eventos.perda_original_id IS
  'Obrigatório apenas para reversão; FK composta garante perda original no mesmo tenant, origem e competência.';

ALTER TABLE financeiro_perdas_eventos ENABLE ROW LEVEL SECURITY;
ALTER TABLE financeiro_perdas_eventos FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = current_schema()
       AND tablename = 'financeiro_perdas_eventos'
       AND policyname = 'financeiro_perdas_eventos_tenant'
  ) THEN
    CREATE POLICY financeiro_perdas_eventos_tenant ON financeiro_perdas_eventos
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION bloquear_mutacao_financeiro_perda_evento_181()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'eventos financeiros FIN-02 são imutáveis'
    USING ERRCODE = '55000';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgrelid = 'financeiro_perdas_eventos'::regclass
       AND tgname = 'financeiro_perdas_eventos_immutable'
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER financeiro_perdas_eventos_immutable
      BEFORE UPDATE OR DELETE OR TRUNCATE ON financeiro_perdas_eventos
      FOR EACH STATEMENT EXECUTE FUNCTION bloquear_mutacao_financeiro_perda_evento_181();
  END IF;
END $$;
