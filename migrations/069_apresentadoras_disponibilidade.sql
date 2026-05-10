-- Migration 069: calendário de disponibilidade de apresentadoras
-- Duas tabelas:
--  · apresentadora_disponibilidade — grade semanal recorrente (dia_semana + TIME)
--  · apresentadora_bloqueios       — exceções pontuais (TIMESTAMPTZ, ex: férias)
--
-- Convenção timezone:
--   - Grade recorrente usa TIME (sem fuso) — interpretado no fuso da unidade.
--     Front exibe sempre no fuso local do navegador, com aviso visual.
--   - Bloqueios usam TIMESTAMPTZ (UTC) — datas absolutas.
--   - Check de conflito feito 100% no backend (single source of truth).

-- ─── Bloqueios pontuais (férias, compromissos, atestado) ──────────────
CREATE TABLE IF NOT EXISTS apresentadora_bloqueios (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  apresentadora_id UUID NOT NULL REFERENCES apresentadoras(id) ON DELETE CASCADE,
  data_inicio      TIMESTAMPTZ NOT NULL,
  data_fim         TIMESTAMPTZ NOT NULL,
  motivo           TEXT,
  criado_por       UUID REFERENCES users(id),
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_periodo CHECK (data_fim > data_inicio)
);

CREATE INDEX IF NOT EXISTS idx_apb_apresentadora_periodo
  ON apresentadora_bloqueios(apresentadora_id, data_inicio, data_fim);
CREATE INDEX IF NOT EXISTS idx_apb_tenant_inicio
  ON apresentadora_bloqueios(tenant_id, data_inicio);

-- ─── Grade semanal recorrente (horário de trabalho) ───────────────────
CREATE TABLE IF NOT EXISTS apresentadora_disponibilidade (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  apresentadora_id UUID NOT NULL REFERENCES apresentadoras(id) ON DELETE CASCADE,
  dia_semana       SMALLINT NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  hora_inicio      TIME NOT NULL,
  hora_fim         TIME NOT NULL,
  CONSTRAINT chk_horario CHECK (hora_fim > hora_inicio),
  UNIQUE (apresentadora_id, dia_semana, hora_inicio)
);

CREATE INDEX IF NOT EXISTS idx_apd_apresentadora
  ON apresentadora_disponibilidade(apresentadora_id);

-- ─── RLS por tenant (USING + WITH CHECK explícito, padrão migration 060)
ALTER TABLE apresentadora_bloqueios       ENABLE ROW LEVEL SECURITY;
ALTER TABLE apresentadora_disponibilidade ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS apb_tenant ON apresentadora_bloqueios;
CREATE POLICY apb_tenant ON apresentadora_bloqueios
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

DROP POLICY IF EXISTS apd_tenant ON apresentadora_disponibilidade;
CREATE POLICY apd_tenant ON apresentadora_disponibilidade
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
