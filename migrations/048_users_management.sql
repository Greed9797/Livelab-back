-- Expandir CHECK de papéis
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_papel_check;
ALTER TABLE users ADD CONSTRAINT users_papel_check
  CHECK (papel IN (
    'franqueador_master','franqueado','cliente_parceiro',
    'gerente','gerente_comercial','financeiro','operacional',
    'apresentador','apresentadora'
  ));

-- FK clientes.user_id (login do cliente_parceiro)
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS user_id UUID
  REFERENCES users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_user_id
  ON clientes(user_id) WHERE user_id IS NOT NULL;

-- FK apresentadoras.user_id
ALTER TABLE apresentadoras ADD COLUMN IF NOT EXISTS user_id UUID
  REFERENCES users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_apresentadoras_user_id
  ON apresentadoras(user_id) WHERE user_id IS NOT NULL;

-- Auditoria: quem criou o usuário
ALTER TABLE users ADD COLUMN IF NOT EXISTS criado_por UUID
  REFERENCES users(id) ON DELETE SET NULL;
