-- Operação v2: marcas, agenda, vídeos e vendas atribuídas.
-- Mantém compatibilidade com tabelas antigas e remove a amarra cabine->contrato.

ALTER TABLE cabines DROP CONSTRAINT IF EXISTS cabines_status_contrato_check;
DROP INDEX IF EXISTS idx_unique_cabines_contrato_vinculado;

ALTER TABLE cabines DROP CONSTRAINT IF EXISTS cabines_status_check;
ALTER TABLE cabines
  ADD CONSTRAINT cabines_status_check
  CHECK (status IN ('disponivel', 'reservada', 'ativa', 'ao_vivo', 'manutencao'));

CREATE TABLE IF NOT EXISTS marcas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  cliente_id UUID REFERENCES clientes(id),
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'cliente'
    CHECK (tipo IN ('cliente', 'afiliada', 'propria', 'parceira')),
  status TEXT NOT NULL DEFAULT 'ativa'
    CHECK (status IN ('ativa', 'inativa', 'pausada')),
  tiktok_username TEXT,
  site TEXT,
  marketplace_url TEXT,
  comissao_franquia_pct NUMERIC(5,2) DEFAULT 0,
  comissao_franqueadora_pct NUMERIC(5,2) DEFAULT 0,
  observacoes TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT marcas_cliente_tipo_check
    CHECK (tipo <> 'cliente' OR cliente_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_marcas_tenant_status ON marcas(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_marcas_cliente ON marcas(tenant_id, cliente_id) WHERE cliente_id IS NOT NULL;

ALTER TABLE marcas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS marcas_tenant ON marcas;
CREATE POLICY marcas_tenant ON marcas
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE TABLE IF NOT EXISTS apresentadora_marcas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  marca_id UUID NOT NULL REFERENCES marcas(id) ON DELETE CASCADE,
  apresentadora_id UUID NOT NULL REFERENCES apresentadoras(id) ON DELETE CASCADE,
  papel TEXT DEFAULT 'principal'
    CHECK (papel IN ('principal', 'apoio', 'reserva')),
  comissao_live_pct NUMERIC(5,2) DEFAULT 0,
  comissao_video_pct NUMERIC(5,2) DEFAULT 0,
  ativo BOOLEAN NOT NULL DEFAULT true,
  inicio_em DATE,
  fim_em DATE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (marca_id, apresentadora_id)
);

CREATE INDEX IF NOT EXISTS idx_apresentadora_marcas_tenant ON apresentadora_marcas(tenant_id, ativo);
CREATE INDEX IF NOT EXISTS idx_apresentadora_marcas_ap ON apresentadora_marcas(tenant_id, apresentadora_id);

ALTER TABLE apresentadora_marcas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS apresentadora_marcas_tenant ON apresentadora_marcas;
CREATE POLICY apresentadora_marcas_tenant ON apresentadora_marcas
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE TABLE IF NOT EXISTS agenda_eventos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('live', 'gravacao_video')),
  marca_id UUID NOT NULL REFERENCES marcas(id),
  cabine_id UUID REFERENCES cabines(id),
  data_inicio TIMESTAMPTZ NOT NULL,
  data_fim TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'planejado'
    CHECK (status IN ('planejado', 'confirmado', 'ao_vivo', 'concluido', 'cancelado')),
  recorrencia_rule TEXT,
  recorrencia_origem_id UUID REFERENCES agenda_eventos(id) ON DELETE SET NULL,
  observacoes TEXT,
  criado_por UUID REFERENCES users(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (data_fim > data_inicio)
);

CREATE INDEX IF NOT EXISTS idx_agenda_eventos_periodo
  ON agenda_eventos(tenant_id, data_inicio, data_fim);
CREATE INDEX IF NOT EXISTS idx_agenda_eventos_status
  ON agenda_eventos(tenant_id, status, tipo);
CREATE INDEX IF NOT EXISTS idx_agenda_eventos_overlap
  ON agenda_eventos (tenant_id, cabine_id, data_inicio, data_fim)
  WHERE status IN ('planejado', 'confirmado', 'ao_vivo') AND cabine_id IS NOT NULL;

ALTER TABLE agenda_eventos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agenda_eventos_tenant ON agenda_eventos;
CREATE POLICY agenda_eventos_tenant ON agenda_eventos
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE TABLE IF NOT EXISTS live_apresentadoras_v2 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  live_id UUID NOT NULL REFERENCES lives(id) ON DELETE CASCADE,
  apresentadora_id UUID NOT NULL REFERENCES apresentadoras(id),
  papel TEXT DEFAULT 'principal',
  percentual_rateio NUMERIC(5,2),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (live_id, apresentadora_id)
);

CREATE INDEX IF NOT EXISTS idx_live_apresentadoras_v2_tenant
  ON live_apresentadoras_v2(tenant_id, live_id);

ALTER TABLE live_apresentadoras_v2 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS live_apresentadoras_v2_tenant ON live_apresentadoras_v2;
CREATE POLICY live_apresentadoras_v2_tenant ON live_apresentadoras_v2
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE TABLE IF NOT EXISTS video_registros (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  marca_id UUID NOT NULL REFERENCES marcas(id),
  apresentadora_id UUID REFERENCES apresentadoras(id),
  agenda_evento_id UUID REFERENCES agenda_eventos(id),
  data DATE NOT NULL,
  quantidade INTEGER NOT NULL DEFAULT 0,
  plataforma TEXT DEFAULT 'tiktok',
  campanha TEXT,
  gmv_atribuido NUMERIC(15,2) DEFAULT 0,
  pedidos_atribuidos INTEGER DEFAULT 0,
  observacoes TEXT,
  criado_por UUID REFERENCES users(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_registros_periodo
  ON video_registros(tenant_id, data DESC);
CREATE INDEX IF NOT EXISTS idx_video_registros_marca
  ON video_registros(tenant_id, marca_id, data DESC);

ALTER TABLE video_registros ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS video_registros_tenant ON video_registros;
CREATE POLICY video_registros_tenant ON video_registros
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE TABLE IF NOT EXISTS vendas_atribuidas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  origem TEXT NOT NULL CHECK (origem IN ('live', 'video')),
  origem_id UUID NOT NULL,
  marca_id UUID NOT NULL REFERENCES marcas(id),
  apresentadora_id UUID REFERENCES apresentadoras(id),
  data DATE NOT NULL,
  gmv NUMERIC(15,2) NOT NULL DEFAULT 0,
  pedidos INTEGER NOT NULL DEFAULT 0,
  comissao_apresentadora NUMERIC(15,2) DEFAULT 0,
  comissao_franquia NUMERIC(15,2) DEFAULT 0,
  comissao_franqueadora NUMERIC(15,2) DEFAULT 0,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendas_atribuidas_periodo
  ON vendas_atribuidas(tenant_id, data DESC, origem);
CREATE INDEX IF NOT EXISTS idx_vendas_atribuidas_marca
  ON vendas_atribuidas(tenant_id, marca_id, data DESC);
CREATE INDEX IF NOT EXISTS idx_vendas_atribuidas_apresentadora
  ON vendas_atribuidas(tenant_id, apresentadora_id, data DESC)
  WHERE apresentadora_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendas_atribuidas_origem_unique
  ON vendas_atribuidas(
    tenant_id,
    origem,
    origem_id,
    COALESCE(apresentadora_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

ALTER TABLE vendas_atribuidas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vendas_atribuidas_tenant ON vendas_atribuidas;
CREATE POLICY vendas_atribuidas_tenant ON vendas_atribuidas
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
