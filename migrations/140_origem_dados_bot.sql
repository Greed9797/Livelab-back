-- Origem 'bot' em tudo que a chave de API cria.
--
-- A chave de API (138) já escreve em produção, mas o dado gravado não diz que
-- foi a automação: só o audit_log sabe. Aqui a coluna `origem_dados`, que já
-- existe em `lives` (081, manual|api), ganha o valor 'bot' e passa a existir
-- com o mesmo nome e a mesma CHECK nas outras tabelas que a chave alcança.
-- O painel lê essa coluna para mostrar o chip BOT.
--
-- 'api' continua sendo o autostart da agenda (src/jobs/agenda_autostart.js);
-- não muda de significado.

ALTER TABLE lives DROP CONSTRAINT IF EXISTS lives_origem_dados_check;
ALTER TABLE lives ADD CONSTRAINT lives_origem_dados_check
  CHECK (origem_dados IN ('manual', 'api', 'bot'));

ALTER TABLE marcas
  ADD COLUMN IF NOT EXISTS origem_dados TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE marcas DROP CONSTRAINT IF EXISTS marcas_origem_dados_check;
ALTER TABLE marcas ADD CONSTRAINT marcas_origem_dados_check
  CHECK (origem_dados IN ('manual', 'api', 'bot'));

ALTER TABLE apresentadoras
  ADD COLUMN IF NOT EXISTS origem_dados TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE apresentadoras DROP CONSTRAINT IF EXISTS apresentadoras_origem_dados_check;
ALTER TABLE apresentadoras ADD CONSTRAINT apresentadoras_origem_dados_check
  CHECK (origem_dados IN ('manual', 'api', 'bot'));

ALTER TABLE live_metric_revisions
  ADD COLUMN IF NOT EXISTS origem_dados TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE live_metric_revisions DROP CONSTRAINT IF EXISTS live_metric_revisions_origem_dados_check;
ALTER TABLE live_metric_revisions ADD CONSTRAINT live_metric_revisions_origem_dados_check
  CHECK (origem_dados IN ('manual', 'api', 'bot'));

ALTER TABLE analytics_import_batches
  ADD COLUMN IF NOT EXISTS origem_dados TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE analytics_import_batches DROP CONSTRAINT IF EXISTS analytics_import_batches_origem_dados_check;
ALTER TABLE analytics_import_batches ADD CONSTRAINT analytics_import_batches_origem_dados_check
  CHECK (origem_dados IN ('manual', 'api', 'bot'));
