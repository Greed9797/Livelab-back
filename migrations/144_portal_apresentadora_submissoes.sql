-- Relatos retroativos enviados pela própria apresentadora. São deliberadamente
-- separados de lives: enquanto pendentes/devolvidos não podem afetar operação,
-- métricas, agenda, vendas atribuídas nem remuneração.
CREATE TABLE IF NOT EXISTS apresentadora_live_submissoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  apresentadora_id UUID NOT NULL REFERENCES apresentadoras(id),
  marca_id UUID REFERENCES marcas(id),
  marca_descricao TEXT,
  cabine_id UUID REFERENCES cabines(id),
  iniciado_em TIMESTAMPTZ NOT NULL,
  encerrado_em TIMESTAMPTZ NOT NULL,
  observacao TEXT,
  gmv_declarado NUMERIC(15,2),
  pedidos_declarados INTEGER,
  client_request_id UUID,
  status TEXT NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'devolvida', 'aprovada', 'cancelada')),
  motivo_devolucao TEXT,
  versao INTEGER NOT NULL DEFAULT 1 CHECK (versao > 0),
  live_oficial_id UUID REFERENCES lives(id),
  revisado_por UUID REFERENCES users(id) ON DELETE SET NULL,
  revisado_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT apresentadora_live_submissoes_intervalo_check CHECK (encerrado_em > iniciado_em),
  CONSTRAINT apresentadora_live_submissoes_gmv_check CHECK (gmv_declarado IS NULL OR gmv_declarado >= 0),
  CONSTRAINT apresentadora_live_submissoes_pedidos_check CHECK (pedidos_declarados IS NULL OR pedidos_declarados >= 0),
  CONSTRAINT apresentadora_live_submissoes_marca_check CHECK (marca_id IS NOT NULL OR NULLIF(BTRIM(marca_descricao), '') IS NOT NULL),
  CONSTRAINT apresentadora_live_submissoes_revisao_check CHECK (
    (status = 'aprovada' AND live_oficial_id IS NOT NULL AND revisado_em IS NOT NULL)
    OR status <> 'aprovada'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS apresentadora_live_submissoes_live_oficial_unico
  ON apresentadora_live_submissoes (tenant_id, apresentadora_id, live_oficial_id)
  WHERE live_oficial_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS apresentadora_live_submissoes_request_unico
  ON apresentadora_live_submissoes (tenant_id, apresentadora_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS apresentadora_live_submissoes_autora_idx
  ON apresentadora_live_submissoes (tenant_id, apresentadora_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS apresentadora_live_submissoes_revisao_idx
  ON apresentadora_live_submissoes (tenant_id, status, iniciado_em DESC);

CREATE TABLE IF NOT EXISTS apresentadora_live_submissao_historico (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  submissao_id UUID NOT NULL REFERENCES apresentadora_live_submissoes(id) ON DELETE CASCADE,
  versao INTEGER NOT NULL,
  acao TEXT NOT NULL CHECK (acao IN ('criada', 'editada', 'reenviada', 'devolvida', 'aprovada', 'cancelada')),
  ator_id UUID REFERENCES users(id) ON DELETE SET NULL,
  motivo TEXT,
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS apresentadora_live_submissao_historico_idx
  ON apresentadora_live_submissao_historico (tenant_id, submissao_id, criado_em);
ALTER TABLE apresentadora_live_submissao_historico ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS apresentadora_live_submissao_historico_tenant ON apresentadora_live_submissao_historico;
CREATE POLICY apresentadora_live_submissao_historico_tenant ON apresentadora_live_submissao_historico
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE apresentadora_live_submissoes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS apresentadora_live_submissoes_tenant ON apresentadora_live_submissoes;
CREATE POLICY apresentadora_live_submissoes_tenant ON apresentadora_live_submissoes
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
