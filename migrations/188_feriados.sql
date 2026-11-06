-- Feriados editáveis pela gestão, por unidade. O calendário embutido
-- (src/lib/calendario-blumenau.js: nacionais + Blumenau) continua valendo; uma
-- linha aqui acrescenta um feriado (ativo=true) ou desliga o embutido daquela
-- data (ativo=false). Usado na comissão de 2% e no bônus de fim de semana/feriado.
CREATE TABLE IF NOT EXISTS feriados (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  data DATE NOT NULL,
  nome TEXT NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT true,
  atualizado_por UUID REFERENCES users(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT feriados_nome_check CHECK (length(btrim(nome)) BETWEEN 1 AND 120),
  CONSTRAINT feriados_tenant_data_unico UNIQUE (tenant_id, data)
);

ALTER TABLE feriados ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS feriados_tenant ON feriados;
CREATE POLICY feriados_tenant ON feriados
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- A aprovação no portal roda o motor de comissão com a role isolada.
GRANT SELECT (tenant_id, data, nome, ativo) ON feriados TO livelab_portal_runtime;
