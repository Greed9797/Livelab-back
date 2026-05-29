-- Fundação da esteira de implantação / auditoria de contratos

-- Expandir status do cliente para refletir o funil comercial completo
ALTER TABLE clientes DROP CONSTRAINT IF EXISTS clientes_status_check;
ALTER TABLE clientes
  ADD CONSTRAINT clientes_status_check
  CHECK (status IN (
    'negociacao',
    'enviado',
    'em_analise',
    'pendencia_comercial',
    'aprovado',
    'ativo',
    'risco_assumido',
    'reprovado',
    'inadimplente',
    'arquivado',
    'cancelado',
    'cancelado_automaticamente'
  ));

-- Expandir status do contrato para o novo fluxo de auditoria
ALTER TABLE contratos DROP CONSTRAINT IF EXISTS contratos_status_check;
ALTER TABLE contratos
  ADD CONSTRAINT contratos_status_check
  CHECK (status IN (
    'rascunho',
    'enviado',
    'em_analise',
    'pendencia_comercial',
    'aprovado',
    'ativo',
    'risco_assumido',
    'reprovado',
    'cancelado',
    'arquivado',
    'cancelado_automaticamente'
  ));

-- Campos de rastreabilidade e decisão do fluxo
ALTER TABLE contratos
  ADD COLUMN IF NOT EXISTS approved_by                  UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at                  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_ip                  TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_by                  UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at                  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_ip                    TEXT,
  ADD COLUMN IF NOT EXISTS pendencia_motivo             TEXT,
  ADD COLUMN IF NOT EXISTS reprovacao_motivo            TEXT,
  ADD COLUMN IF NOT EXISTS auto_aprovado                BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auditoria_post_factum        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS prazo_decisao_ate            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS franqueado_aceite_risco_em   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS franqueado_aceite_risco_ip   TEXT,
  ADD COLUMN IF NOT EXISTS franqueado_aceite_risco_texto TEXT,
  ADD COLUMN IF NOT EXISTS cancelado_automaticamente_em TIMESTAMPTZ;

-- Índices para consultas operacionais do backoffice
CREATE INDEX IF NOT EXISTS idx_contratos_status_prazo
  ON contratos(status, prazo_decisao_ate);

CREATE INDEX IF NOT EXISTS idx_contratos_reviewed_at
  ON contratos(reviewed_at DESC NULLS LAST);

-- Log imutável dos eventos de contrato
CREATE TABLE IF NOT EXISTS contrato_eventos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  contrato_id    UUID NOT NULL REFERENCES contratos(id) ON DELETE CASCADE,
  tipo_evento    TEXT NOT NULL CHECK (tipo_evento IN (
    'contrato_criado',
    'contrato_assinado',
    'contrato_enviado_analise',
    'contrato_auto_aprovado',
    'contrato_aprovado',
    'contrato_pendencia_comercial',
    'contrato_reprovado',
    'contrato_risco_assumido',
    'contrato_arquivado',
    'contrato_cancelado_automaticamente'
  )),
  actor_user_id  UUID REFERENCES users(id),
  actor_papel    TEXT,
  ip             TEXT,
  payload_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contrato_eventos_contrato
  ON contrato_eventos(contrato_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_contrato_eventos_tipo
  ON contrato_eventos(tipo_evento, created_at DESC);

ALTER TABLE contrato_eventos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contrato_eventos_tenant ON contrato_eventos;
CREATE POLICY contrato_eventos_tenant ON contrato_eventos
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Blindagem append-only
CREATE OR REPLACE FUNCTION prevent_contrato_eventos_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'contrato_eventos is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_contrato_eventos_update ON contrato_eventos;
CREATE TRIGGER trg_prevent_contrato_eventos_update
BEFORE UPDATE ON contrato_eventos
FOR EACH ROW EXECUTE FUNCTION prevent_contrato_eventos_mutation();

DROP TRIGGER IF EXISTS trg_prevent_contrato_eventos_delete ON contrato_eventos;
CREATE TRIGGER trg_prevent_contrato_eventos_delete
BEFORE DELETE ON contrato_eventos
FOR EACH ROW EXECUTE FUNCTION prevent_contrato_eventos_mutation();
