-- Additive workflow metadata; existing submission statuses and financial rules stay intact.
ALTER TABLE apresentadora_live_submissoes
  ADD COLUMN IF NOT EXISTS arquivamento_status TEXT,
  ADD COLUMN IF NOT EXISTS motivo_contestacao TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='submissao_arquivamento_estado_check' AND conrelid='apresentadora_live_submissoes'::regclass) THEN
    ALTER TABLE apresentadora_live_submissoes ADD CONSTRAINT submissao_arquivamento_estado_check CHECK (
      arquivamento_status IS NULL
      OR (arquivamento_status='solicitado' AND status='devolvida')
      OR (arquivamento_status='confirmado' AND status='cancelada')
    );
  END IF;
END $$;
