-- CRM MVP fields for leads
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS crm_etapa TEXT NOT NULL DEFAULT 'lead_novo'
    CHECK (crm_etapa IN ('lead_novo','contato_iniciado','reuniao_agendada','proposta_enviada','em_negociacao','aguardando_assinatura','ganho','perdido')),
  ADD COLUMN IF NOT EXISTS valor_oportunidade NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS responsavel_nome TEXT,
  ADD COLUMN IF NOT EXISTS origem TEXT,
  ADD COLUMN IF NOT EXISTS historico_contatos JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS observacoes_internas TEXT,
  ADD COLUMN IF NOT EXISTS tarefas JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS motivo_perda TEXT,
  ADD COLUMN IF NOT EXISTS convertido_cliente_id UUID REFERENCES clientes(id),
  ADD COLUMN IF NOT EXISTS ganho_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_leads_crm_etapa   ON leads(pego_por, crm_etapa);
CREATE INDEX IF NOT EXISTS idx_leads_convertido   ON leads(convertido_cliente_id) WHERE convertido_cliente_id IS NOT NULL;
