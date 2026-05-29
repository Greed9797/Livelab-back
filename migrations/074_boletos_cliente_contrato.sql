-- Migration 074: boletos.cliente_id e boletos.contrato_id — colunas usadas
-- por billing_engine, notify_boletos_vencidos, cliente_metricas_snapshot,
-- franqueado.js, cliente_dashboard.js e relatorios.js.
--
-- Problema resolvido:
--   src/jobs/billing_engine.js executa
--     INSERT INTO boletos (tenant_id, cliente_id, contrato_id, ...)
--   mas as colunas nunca foram adicionadas via migration. Em ambientes
--   onde foram aplicadas manualmente (prod), os jobs funcionam; em ambientes
--   novos (dev/staging/restore from backup) o INSERT quebra com
--   `column "cliente_id" does not exist`.
--
-- Solução:
--   ADD COLUMN IF NOT EXISTS (idempotente, sem efeitos colaterais em prod
--   se já existirem). FK pra clientes(id) e contratos(id) com ON DELETE
--   SET NULL — preserva histórico financeiro mesmo se o cliente ou contrato
--   for removido.
--
-- Índices acompanham as queries de leitura mais frequentes
-- (notify_boletos_vencidos, cliente_dashboard, franqueado).

ALTER TABLE boletos
  ADD COLUMN IF NOT EXISTS cliente_id  UUID REFERENCES clientes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contrato_id UUID REFERENCES contratos(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_boletos_cliente_id  ON boletos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_boletos_contrato_id ON boletos(contrato_id);
