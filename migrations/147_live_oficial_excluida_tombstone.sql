-- A exclusão gerencial da live não pode apagar nem reabrir a decisão de
-- aprovação da apresentadora. Mantemos uma referência histórica sem FK e
-- limpamos a referência física somente pela transação de DELETE da live.
ALTER TABLE apresentadora_live_submissoes
  ADD COLUMN IF NOT EXISTS live_oficial_excluida_id UUID,
  ADD COLUMN IF NOT EXISTS live_oficial_excluida_em TIMESTAMPTZ;

ALTER TABLE apresentadora_live_submissoes
  DROP CONSTRAINT IF EXISTS apresentadora_live_submissoes_revisao_check,
  ADD CONSTRAINT apresentadora_live_submissoes_revisao_check CHECK (
    (status = 'aprovada'
      AND revisado_em IS NOT NULL
      AND (
        (live_oficial_id IS NOT NULL
          AND live_oficial_excluida_id IS NULL
          AND live_oficial_excluida_em IS NULL)
        OR (live_oficial_id IS NULL
          AND live_oficial_excluida_id IS NOT NULL
          AND live_oficial_excluida_em IS NOT NULL)
      )
    )
    OR status <> 'aprovada'
  );

ALTER TABLE apresentadora_live_submissao_historico
  DROP CONSTRAINT IF EXISTS apresentadora_live_submissao_historico_acao_check,
  ADD CONSTRAINT apresentadora_live_submissao_historico_acao_check CHECK (
    acao IN ('criada', 'editada', 'reenviada', 'devolvida', 'aprovada', 'cancelada', 'live_oficial_excluida')
  );

CREATE INDEX IF NOT EXISTS apresentadora_live_submissoes_live_excluida_idx
  ON apresentadora_live_submissoes (tenant_id, live_oficial_excluida_id)
  WHERE live_oficial_excluida_id IS NOT NULL;
