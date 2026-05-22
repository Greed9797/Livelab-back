-- Unifica a fonte do TikTok:
-- - clientes.tiktok_username: fonte canônica para marcas do tipo cliente
-- - marcas.tiktok_username: fonte canônica apenas para marcas não-cliente
-- - contratos.tiktok_username: legado, mantido para leitura/fallback durante rollout

UPDATE marcas
   SET tiktok_username = NULL,
       atualizado_em = NOW()
 WHERE tiktok_username IS NOT NULL
   AND btrim(tiktok_username) = '';

UPDATE marcas
   SET tiktok_username = regexp_replace(btrim(tiktok_username), '^@+', '')
 WHERE tiktok_username IS NOT NULL
   AND tiktok_username <> regexp_replace(btrim(tiktok_username), '^@+', '');

UPDATE marcas
   SET tiktok_username = NULL,
       atualizado_em = NOW()
 WHERE tiktok_username IS NOT NULL
   AND tiktok_username !~ '^[a-zA-Z0-9_.]{2,24}$';

WITH ranked_contracts AS (
  SELECT tenant_id,
         cliente_id,
         tiktok_username,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, cliente_id
           ORDER BY (status = 'ativo') DESC,
                    ativado_em DESC NULLS LAST,
                    criado_em DESC
         ) AS rn
    FROM contratos
   WHERE cliente_id IS NOT NULL
     AND tiktok_username IS NOT NULL
     AND tiktok_username ~ '^[a-zA-Z0-9_.]{2,24}$'
)
UPDATE clientes c
   SET tiktok_username = rc.tiktok_username,
       atualizado_em = NOW()
  FROM ranked_contracts rc
 WHERE rc.rn = 1
   AND c.tenant_id = rc.tenant_id
   AND c.id = rc.cliente_id
   AND c.tiktok_username IS NULL;

WITH ranked_client_brands AS (
  SELECT tenant_id,
         cliente_id,
         tiktok_username,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, cliente_id
           ORDER BY (status = 'ativa') DESC,
                    atualizado_em DESC NULLS LAST,
                    criado_em DESC
         ) AS rn
    FROM marcas
   WHERE tipo = 'cliente'
     AND cliente_id IS NOT NULL
     AND tiktok_username IS NOT NULL
     AND tiktok_username ~ '^[a-zA-Z0-9_.]{2,24}$'
)
UPDATE clientes c
   SET tiktok_username = rb.tiktok_username,
       atualizado_em = NOW()
  FROM ranked_client_brands rb
 WHERE rb.rn = 1
   AND c.tenant_id = rb.tenant_id
   AND c.id = rb.cliente_id
   AND c.tiktok_username IS NULL;

UPDATE marcas
   SET tiktok_username = NULL,
       atualizado_em = NOW()
 WHERE tipo = 'cliente'
   AND cliente_id IS NOT NULL
   AND tiktok_username IS NOT NULL;

UPDATE contratos
   SET tiktok_username = NULL
 WHERE tiktok_username IS NOT NULL;

DO $$
BEGIN
  ALTER TABLE marcas
    DROP CONSTRAINT IF EXISTS marcas_tiktok_username_format;

  ALTER TABLE marcas
    ADD CONSTRAINT marcas_tiktok_username_format
    CHECK (tiktok_username IS NULL OR tiktok_username ~ '^[a-zA-Z0-9_.]{2,24}$');
END $$;

COMMENT ON COLUMN clientes.tiktok_username IS 'Fonte canônica do TikTok para cliente e marcas do tipo cliente.';
COMMENT ON COLUMN marcas.tiktok_username IS 'Fonte canônica do TikTok apenas para marcas não-cliente.';
COMMENT ON COLUMN contratos.tiktok_username IS 'LEGADO: não escrever novos valores; mantido temporariamente para compatibilidade.';
