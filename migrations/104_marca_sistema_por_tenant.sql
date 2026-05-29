-- Migration 104: Marca Sistema por tenant
-- Cria uma marca fallback "Livelab Sistema" por tenant para lives afiliado/teste sem cliente vinculado

-- 1. Adicionar coluna sistema em marcas (idempotente)
ALTER TABLE marcas ADD COLUMN IF NOT EXISTS sistema BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Índice único parcial: apenas uma marca sistema por tenant
CREATE UNIQUE INDEX IF NOT EXISTS uniq_marca_sistema_por_tenant
  ON marcas(tenant_id) WHERE sistema = TRUE;

-- 3. Inserir marca sistema para cada tenant que ainda não tem
INSERT INTO marcas (id, tenant_id, nome, tipo, status, sistema, criado_em, atualizado_em)
SELECT
  gen_random_uuid(),
  t.id,
  'Livelab Sistema',
  'propria',
  'ativa',
  TRUE,
  NOW(),
  NOW()
FROM tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM marcas m WHERE m.tenant_id = t.id AND m.sistema = TRUE
);

-- 4. Backfill: lives afiliado/teste com marca_id NULL → usar marca sistema do tenant
UPDATE lives l
SET marca_id = (
  SELECT m.id FROM marcas m
  WHERE m.tenant_id = l.tenant_id AND m.sistema = TRUE
  LIMIT 1
)
WHERE l.marca_id IS NULL
  AND l.tipo IN ('afiliado', 'teste');
