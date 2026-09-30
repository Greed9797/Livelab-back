-- 163: remoção completa do legado de boletos (Pagar.me/Appmax).
-- Decisão do dono: a tabela `boletos`, seus vínculos, o webhook de pagamento,
-- o job de boletos vencidos e a notificação `notif_boleto_vencido` deixam de existir.
-- Idempotente: pode rodar N vezes. Não altera migrations antigas.
-- `lives.faturado_em` é MANTIDA (marca live já fechada e é lida por união de lives,
-- condições comerciais e vendas_atribuidas); só o vínculo `boleto_id` some.

-- 1. Vínculos (FKs e índices) → tabela boletos
DROP INDEX IF EXISTS idx_webhook_eventos_boleto;
ALTER TABLE IF EXISTS webhook_eventos DROP COLUMN IF EXISTS boleto_id;
ALTER TABLE IF EXISTS lives DROP COLUMN IF EXISTS boleto_id;

-- 2. Tabela (leva junto índices, policies RLS, triggers e FKs restantes)
DROP TABLE IF EXISTS boletos CASCADE;

-- 3. Preferência de notificação do tenant
ALTER TABLE IF EXISTS tenants DROP COLUMN IF EXISTS notif_boleto_vencido;

-- 4. Histórico de notificações de boleto
DELETE FROM notification_log WHERE tipo LIKE 'boleto\_%' ESCAPE '\';
