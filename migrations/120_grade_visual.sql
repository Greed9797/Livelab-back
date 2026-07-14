-- Migration 120: Grade visual de agenda por cabine.
-- Duas tabelas 100% desacopladas de agenda_eventos/lives/métricas:
--   grade_padrao   — template seg–sex (dia_semana 0=domingo, convenção extract(dow)/Date.getDay())
--   grade_excecoes — overrides por data (sáb/dom e dias atípicos); marca_id NULL = célula vazia
-- Slots (08–11 etc.) são dados (TIME), não constraint — mudança de horário não exige migration.
-- Horas são TIME puro (rótulo local America/Sao_Paulo), sem timezone.

CREATE TABLE IF NOT EXISTS grade_padrao (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  dia_semana SMALLINT NOT NULL CHECK (dia_semana BETWEEN 0 AND 6), -- 0=domingo
  cabine_id UUID NOT NULL REFERENCES cabines(id),
  hora_inicio TIME NOT NULL,
  hora_fim TIME NOT NULL,
  marca_id UUID NOT NULL REFERENCES marcas(id),
  apresentadora_id UUID REFERENCES apresentadoras(id),
  observacao TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, dia_semana, cabine_id, hora_inicio),
  CHECK (hora_fim > hora_inicio)
);

CREATE TABLE IF NOT EXISTS grade_excecoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  data DATE NOT NULL,
  cabine_id UUID NOT NULL REFERENCES cabines(id),
  hora_inicio TIME NOT NULL,
  hora_fim TIME NOT NULL,
  marca_id UUID REFERENCES marcas(id), -- NULL = célula vazia neste dia (apaga o padrão)
  apresentadora_id UUID REFERENCES apresentadoras(id),
  observacao TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, data, cabine_id, hora_inicio),
  CHECK (hora_fim > hora_inicio)
);

-- Índices para consulta por período (visões semana/mês) e filtros
CREATE INDEX IF NOT EXISTS idx_grade_padrao_dia ON grade_padrao(tenant_id, dia_semana);
CREATE INDEX IF NOT EXISTS idx_grade_padrao_marca ON grade_padrao(tenant_id, marca_id);
CREATE INDEX IF NOT EXISTS idx_grade_padrao_apresentadora ON grade_padrao(tenant_id, apresentadora_id);
CREATE INDEX IF NOT EXISTS idx_grade_excecoes_data ON grade_excecoes(tenant_id, data);
CREATE INDEX IF NOT EXISTS idx_grade_excecoes_marca ON grade_excecoes(tenant_id, marca_id);
CREATE INDEX IF NOT EXISTS idx_grade_excecoes_apresentadora ON grade_excecoes(tenant_id, apresentadora_id);

-- RLS — mesmo padrão das demais tabelas (USING + WITH CHECK por app.tenant_id)
ALTER TABLE grade_padrao ENABLE ROW LEVEL SECURITY;
ALTER TABLE grade_excecoes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS grade_padrao_tenant ON grade_padrao;
CREATE POLICY grade_padrao_tenant ON grade_padrao
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

DROP POLICY IF EXISTS grade_excecoes_tenant ON grade_excecoes;
CREATE POLICY grade_excecoes_tenant ON grade_excecoes
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
