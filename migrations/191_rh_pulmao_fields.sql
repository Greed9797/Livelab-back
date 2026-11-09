ALTER TABLE rh_colaboradores
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ativo'
    CHECK (status IN ('ativo','inativo','ferias','afastado')),
  ADD COLUMN IF NOT EXISTS tipo_contrato TEXT NOT NULL DEFAULT 'clt'
    CHECK (tipo_contrato IN ('clt','pj','estagio','freelancer')),
  ADD COLUMN IF NOT EXISTS centro_custo TEXT[],
  ADD COLUMN IF NOT EXISTS responsavel_id UUID REFERENCES rh_colaboradores(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ote_comissao TEXT,
  ADD COLUMN IF NOT EXISTS chave_pix TEXT;

UPDATE rh_colaboradores
SET status = CASE WHEN ativo IS FALSE THEN 'inativo' ELSE 'ativo' END
WHERE status IS DISTINCT FROM CASE WHEN ativo IS FALSE THEN 'inativo' ELSE 'ativo' END;
