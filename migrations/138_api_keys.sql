-- Chaves de API para automação (máquina-a-máquina).
--
-- Até aqui a API só sabia autenticar gente: JWT de 60 minutos emitido no login.
-- Uma automação externa não tinha por onde entrar sem um usuário humano e uma
-- senha guardada em algum lugar.
--
-- A chave em texto nunca é gravada: guardamos só o SHA-256. O `prefixo` são os
-- primeiros caracteres, o suficiente para identificar a chave numa lista sem
-- revelar o resto.

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  prefixo TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  papel TEXT NOT NULL DEFAULT 'automacao',
  revogada_em TIMESTAMPTZ,
  expira_em TIMESTAMPTZ,
  ultimo_uso TIMESTAMPTZ,
  criado_por UUID,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A autenticação procura pelo hash e por mais nada: é o índice que faz o
-- caminho quente ser uma busca só, e o UNIQUE garante que duas chaves nunca
-- colidam.
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_uniq ON api_keys (key_hash);

CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys (tenant_id, criado_em DESC);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_keys_tenant ON api_keys;
CREATE POLICY api_keys_tenant ON api_keys
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Impressão digital do arquivo importado.
--
-- Quem chama a ingestão é um agente, e agente repete chamada: erra um
-- parâmetro, não entende a resposta, tenta de novo. O import do TikTok Studio
-- se defende sozinho pelo `tiktok_room_id` (migration 134), mas o de Ads não
-- tem chave natural nenhuma — o mesmo arquivo entrava duas vezes e dobrava o
-- GMV do mês. Com o hash, o reenvio devolve o lote anterior em vez de criar um
-- novo.
ALTER TABLE analytics_import_batches ADD COLUMN IF NOT EXISTS file_hash TEXT;

CREATE INDEX IF NOT EXISTS analytics_import_batches_hash_idx
  ON analytics_import_batches (tenant_id, file_hash, created_at DESC)
  WHERE file_hash IS NOT NULL;
