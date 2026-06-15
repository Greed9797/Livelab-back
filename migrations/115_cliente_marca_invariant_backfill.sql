-- Garante a invariavel operacional: todo cliente possui uma marca tipo=cliente.

INSERT INTO marcas (
  tenant_id, cliente_id, nome, tipo, status, tiktok_username, site, logo_url, observacoes, criado_em, atualizado_em
)
SELECT
  c.tenant_id,
  c.id,
  c.nome,
  'cliente',
  CASE WHEN c.status = 'cancelado' THEN 'inativa' ELSE 'ativa' END,
  c.tiktok_username,
  c.site,
  c.logo_url,
  'Criada automaticamente pela migration 115 para garantir cliente como marca.',
  NOW(),
  NOW()
FROM clientes c
WHERE NOT EXISTS (
  SELECT 1
  FROM marcas m
  WHERE m.tenant_id = c.tenant_id
    AND m.cliente_id = c.id
    AND m.tipo = 'cliente'
);

UPDATE marcas m
SET
  status = CASE WHEN c.status = 'cancelado' THEN m.status ELSE 'ativa' END,
  nome = COALESCE(NULLIF(m.nome, ''), c.nome),
  tiktok_username = COALESCE(m.tiktok_username, c.tiktok_username),
  site = COALESCE(m.site, c.site),
  logo_url = COALESCE(m.logo_url, c.logo_url),
  atualizado_em = NOW()
FROM clientes c
WHERE m.tenant_id = c.tenant_id
  AND m.cliente_id = c.id
  AND m.tipo = 'cliente'
  AND (
    (c.status <> 'cancelado' AND m.status <> 'ativa')
    OR NULLIF(m.nome, '') IS NULL
    OR (m.tiktok_username IS NULL AND c.tiktok_username IS NOT NULL)
    OR (m.site IS NULL AND c.site IS NOT NULL)
    OR (m.logo_url IS NULL AND c.logo_url IS NOT NULL)
  );

WITH preferred_cliente_marcas AS (
  SELECT DISTINCT ON (m.tenant_id, m.cliente_id)
    m.tenant_id,
    m.cliente_id,
    m.id AS marca_id
  FROM marcas m
  WHERE m.tipo = 'cliente'
    AND m.cliente_id IS NOT NULL
  ORDER BY m.tenant_id, m.cliente_id, (m.status = 'ativa') DESC, m.atualizado_em DESC NULLS LAST, m.criado_em ASC
)
UPDATE lives l
SET marca_id = pcm.marca_id
FROM preferred_cliente_marcas pcm
WHERE l.tenant_id = pcm.tenant_id
  AND l.cliente_id = pcm.cliente_id
  AND l.marca_id IS NULL;
