-- Adicionais manuais do fechamento mensal de apresentadoras.
-- Não infere presença: fim de semana e bonificação são lançados pelo operador.
-- A competência é sempre o primeiro dia do mês; data_referencia só documenta o dia
-- efetivamente trabalhado no adicional de fim de semana.

CREATE TABLE IF NOT EXISTS apresentadora_remuneracao_adicionais (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  apresentadora_id UUID NOT NULL REFERENCES apresentadoras(id),
  competencia DATE NOT NULL,
  tipo TEXT NOT NULL,
  descricao TEXT NOT NULL,
  data_referencia DATE,
  valor NUMERIC(15,2) NOT NULL,
  client_request_id UUID,
  criado_por UUID REFERENCES users(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelado_em TIMESTAMPTZ,
  cancelado_por UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT apresentadora_remuneracao_adicionais_competencia_check
    CHECK (competencia = date_trunc('month', competencia)::date),
  CONSTRAINT apresentadora_remuneracao_adicionais_tipo_check
    CHECK (tipo IN ('fim_de_semana', 'bonificacao')),
  CONSTRAINT apresentadora_remuneracao_adicionais_valor_check
    CHECK (valor > 0),
  CONSTRAINT apresentadora_remuneracao_adicionais_fim_de_semana_check
    CHECK (
      (tipo = 'fim_de_semana'
       AND data_referencia IS NOT NULL
       AND data_referencia >= competencia
       AND data_referencia < (competencia + interval '1 month')::date
       AND EXTRACT(ISODOW FROM data_referencia) IN (6, 7)
       AND valor = 100)
      OR tipo = 'bonificacao'
    )
);

-- Impede duas diárias para a mesma apresentadora/data, sem impedir várias bonificações.
CREATE UNIQUE INDEX IF NOT EXISTS apresentadora_remuneracao_adicionais_fim_de_semana_unico
  ON apresentadora_remuneracao_adicionais(tenant_id, apresentadora_id, data_referencia)
  WHERE tipo = 'fim_de_semana' AND cancelado_em IS NULL;

CREATE INDEX IF NOT EXISTS apresentadora_remuneracao_adicionais_fechamento_idx
  ON apresentadora_remuneracao_adicionais(tenant_id, competencia, apresentadora_id);

CREATE UNIQUE INDEX IF NOT EXISTS apresentadora_remuneracao_adicionais_idempotencia_unica
  ON apresentadora_remuneracao_adicionais(tenant_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

ALTER TABLE apresentadora_remuneracao_adicionais ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS apresentadora_remuneracao_adicionais_tenant ON apresentadora_remuneracao_adicionais;
CREATE POLICY apresentadora_remuneracao_adicionais_tenant
  ON apresentadora_remuneracao_adicionais
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMENT ON TABLE apresentadora_remuneracao_adicionais IS
  'Adicionais manuais do fechamento de apresentadoras: R$100 por sábado/domingo marcado ou bonificação individual. Não cria estado de pagamento.';
