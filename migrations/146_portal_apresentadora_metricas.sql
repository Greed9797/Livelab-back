-- Optional funnel metrics submitted by presenters remain isolated until a
-- manager approves and materializes a new official live. NULL means unknown;
-- zero is a confirmed value.
ALTER TABLE apresentadora_live_submissoes
  ADD COLUMN IF NOT EXISTS live_impressions_declaradas BIGINT,
  ADD COLUMN IF NOT EXISTS manual_views_declaradas INTEGER,
  ADD COLUMN IF NOT EXISTS live_impressions_oficiais BIGINT,
  ADD COLUMN IF NOT EXISTS manual_views_oficiais INTEGER;

ALTER TABLE apresentadora_live_submissoes
  DROP CONSTRAINT IF EXISTS apresentadora_live_submissoes_live_impressions_declaradas_check,
  ADD CONSTRAINT apresentadora_live_submissoes_live_impressions_declaradas_check
    CHECK (live_impressions_declaradas IS NULL OR live_impressions_declaradas >= 0),
  DROP CONSTRAINT IF EXISTS apresentadora_live_submissoes_manual_views_declaradas_check,
  ADD CONSTRAINT apresentadora_live_submissoes_manual_views_declaradas_check
    CHECK (manual_views_declaradas IS NULL OR manual_views_declaradas >= 0),
  DROP CONSTRAINT IF EXISTS apresentadora_live_submissoes_live_impressions_oficiais_check,
  ADD CONSTRAINT apresentadora_live_submissoes_live_impressions_oficiais_check
    CHECK (live_impressions_oficiais IS NULL OR live_impressions_oficiais >= 0),
  DROP CONSTRAINT IF EXISTS apresentadora_live_submissoes_manual_views_oficiais_check,
  ADD CONSTRAINT apresentadora_live_submissoes_manual_views_oficiais_check
    CHECK (manual_views_oficiais IS NULL OR manual_views_oficiais >= 0);

-- 145 already grants full submission-table access to this role. These explicit
-- column grants cover materializing the canonical live metrics and the own
-- remuneration read helper without broadening any client-facing role.
GRANT INSERT (live_impressions, manual_views) ON lives TO livelab_portal_runtime;
GRANT SELECT (id, tenant_id, user_id, nome, foto_url, fixo, comissao_pct, ativo, arquivada, data_inicio, data_fim)
  ON apresentadoras TO livelab_portal_runtime;
GRANT SELECT (id, tenant_id, apresentadora_id, competencia, tipo, descricao, data_referencia, valor, cancelado_em, criado_em)
  ON apresentadora_remuneracao_adicionais TO livelab_portal_runtime;
