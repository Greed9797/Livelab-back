CREATE TABLE IF NOT EXISTS rh_colaboradores (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  nome              TEXT NOT NULL,
  cargo             TEXT,
  setor             TEXT,
  email             TEXT,
  telefone          TEXT,
  cpf               TEXT,
  data_nascimento   DATE,
  data_admissao     DATE,
  data_desligamento DATE,
  salario_fixo      NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (salario_fixo >= 0),
  ativo             BOOLEAN NOT NULL DEFAULT true,
  observacoes       TEXT,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rh_colaboradores_tenant ON rh_colaboradores(tenant_id);
CREATE INDEX IF NOT EXISTS idx_rh_colaboradores_ativo ON rh_colaboradores(tenant_id, ativo);
ALTER TABLE rh_colaboradores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rh_colaboradores_tenant ON rh_colaboradores;
CREATE POLICY rh_colaboradores_tenant ON rh_colaboradores
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE TABLE IF NOT EXISTS rh_folha_mensal (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  colaborador_id  UUID NOT NULL REFERENCES rh_colaboradores(id) ON DELETE RESTRICT,
  competencia     DATE NOT NULL,
  salario_fixo    NUMERIC(15,2) NOT NULL DEFAULT 0,
  meta_valor      NUMERIC(15,2) NOT NULL DEFAULT 0,
  meta_realizado  NUMERIC(15,2) NOT NULL DEFAULT 0,
  comissao        NUMERIC(15,2) NOT NULL DEFAULT 0,
  bonus           NUMERIC(15,2) NOT NULL DEFAULT 0,
  descontos       NUMERIC(15,2) NOT NULL DEFAULT 0,
  total           NUMERIC(15,2) GENERATED ALWAYS AS (salario_fixo + comissao + bonus - descontos) STORED,
  status          TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','fechado','pago')),
  observacoes     TEXT,
  fechado_em      TIMESTAMPTZ,
  pago_em         TIMESTAMPTZ,
  criado_por      UUID REFERENCES users(id),
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, colaborador_id, competencia),
  CHECK (EXTRACT(DAY FROM competencia) = 1)
);
CREATE INDEX IF NOT EXISTS idx_rh_folha_tenant_competencia ON rh_folha_mensal(tenant_id, competencia);
CREATE INDEX IF NOT EXISTS idx_rh_folha_colaborador ON rh_folha_mensal(tenant_id, colaborador_id);
ALTER TABLE rh_folha_mensal ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rh_folha_mensal_tenant ON rh_folha_mensal;
CREATE POLICY rh_folha_mensal_tenant ON rh_folha_mensal
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
