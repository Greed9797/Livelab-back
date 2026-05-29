-- CRM Comercial: histórico estruturado mantendo compatibilidade com JSONB legado.

CREATE TABLE IF NOT EXISTS lead_contatos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  resumo TEXT NOT NULL,
  autor_id UUID REFERENCES users(id),
  autor_nome TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_contatos_lead
  ON lead_contatos(tenant_id, lead_id, criado_em DESC);

CREATE TABLE IF NOT EXISTS lead_tarefas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  titulo TEXT NOT NULL,
  descricao TEXT,
  responsavel_id UUID REFERENCES users(id),
  responsavel_nome TEXT,
  due_date DATE,
  concluida BOOLEAN NOT NULL DEFAULT false,
  concluida_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_tarefas_lead
  ON lead_tarefas(tenant_id, lead_id, concluida, due_date);

CREATE TABLE IF NOT EXISTS lead_etapa_historico (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  etapa_anterior TEXT,
  etapa_nova TEXT NOT NULL,
  alterado_por UUID REFERENCES users(id),
  alterado_por_nome TEXT,
  motivo TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_etapa_historico_lead
  ON lead_etapa_historico(tenant_id, lead_id, criado_em DESC);

ALTER TABLE cabines
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_cabines_operacionais
  ON cabines(tenant_id, ativo, deleted_at);
