-- FIN-03A: append-only close/reopen history. No changes to existing writers.
CREATE TABLE IF NOT EXISTS financeiro_fechamentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  competencia DATE NOT NULL,
  versao INTEGER NOT NULL,
  evento TEXT NOT NULL,
  snapshot JSONB,
  motivo TEXT,
  ator_id UUID NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT financeiro_fechamentos_mes_check CHECK (EXTRACT(DAY FROM competencia) = 1),
  CONSTRAINT financeiro_fechamentos_versao_check CHECK (versao > 0),
  CONSTRAINT financeiro_fechamentos_evento_check CHECK (
    (evento = 'fechamento' AND snapshot IS NOT NULL AND jsonb_typeof(snapshot) = 'object' AND motivo IS NULL)
    OR (evento = 'reabertura' AND snapshot IS NULL AND motivo IS NOT NULL AND btrim(motivo) <> '')
  ),
  CONSTRAINT financeiro_fechamentos_versao_evento_uk UNIQUE (tenant_id, competencia, versao, evento)
);

CREATE INDEX IF NOT EXISTS financeiro_fechamentos_tenant_mes_idx
  ON financeiro_fechamentos (tenant_id, competencia, versao DESC, criado_em DESC);

ALTER TABLE financeiro_fechamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE financeiro_fechamentos FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS financeiro_fechamentos_tenant ON financeiro_fechamentos;
CREATE POLICY financeiro_fechamentos_tenant ON financeiro_fechamentos
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION bloquear_mutacao_financeiro_fechamento_182()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'histórico de fechamento financeiro é imutável' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS financeiro_fechamentos_immutable ON financeiro_fechamentos;
CREATE TRIGGER financeiro_fechamentos_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON financeiro_fechamentos
  FOR EACH STATEMENT EXECUTE FUNCTION bloquear_mutacao_financeiro_fechamento_182();
