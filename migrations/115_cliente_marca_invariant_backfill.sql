-- Migration 115: Invariante "todo cliente possui UMA marca tipo='cliente'".
--
-- Causa-raiz dos bugs de comissão: a comissão vive em `marcas`, mas a marca-espelho
-- do cliente só nascia de forma lazy (ao agendar uma cabine). Cliente cadastrado e
-- não-agendado ficava sem marca -> commission-engine não resolvia marca -> lives sem
-- comissão -> não somavam. Esta migration:
--   1) cria a marca tipo='cliente' para todo cliente que não tem;
--   2) sincroniza campos básicos do cliente na marca;
--   3) deduplica marcas tipo='cliente' do mesmo cliente (repontando referências);
--   4) preenche lives.marca_id antigas a partir da marca do cliente;
--   5) cria índice único parcial garantindo 1 marca-cliente por cliente/tenant.
-- Idempotente: pode rodar mais de uma vez sem efeito colateral.

-- 1) Backfill: marca tipo='cliente' para cliente sem nenhuma.
--    tiktok_username fica NULL: o cliente é a fonte canônica do @ (migration 103).
INSERT INTO marcas (
  tenant_id, cliente_id, nome, tipo, status, tiktok_username, site, logo_url, observacoes, criado_em, atualizado_em
)
SELECT
  c.tenant_id, c.id, c.nome, 'cliente',
  CASE WHEN c.status = 'cancelado' THEN 'inativa' ELSE 'ativa' END,
  NULL, c.site, c.logo_url,
  'Criada automaticamente pela migration 115 (invariante cliente->marca).',
  NOW(), NOW()
FROM clientes c
WHERE c.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM marcas m
    WHERE m.tenant_id = c.tenant_id AND m.cliente_id = c.id AND m.tipo = 'cliente'
  );

-- 2) Sincroniza campos do cliente na marca quando faltam (não sobrescreve dados já preenchidos).
--    tiktok_username NÃO é sincronizado de propósito (cliente é a fonte canônica do @, migration 103).
UPDATE marcas m
SET nome          = COALESCE(NULLIF(m.nome, ''), c.nome),
    site          = COALESCE(m.site, c.site),
    logo_url      = COALESCE(m.logo_url, c.logo_url),
    atualizado_em = NOW()
FROM clientes c
WHERE m.tenant_id = c.tenant_id
  AND m.cliente_id = c.id
  AND m.tipo = 'cliente'
  AND (
       NULLIF(m.nome, '') IS NULL
    OR (m.site IS NULL AND c.site IS NOT NULL)
    OR (m.logo_url IS NULL AND c.logo_url IS NOT NULL)
  );

-- 3) Dedupe: mapeia marcas tipo='cliente' duplicadas (mesmo cliente) -> marca canônica.
--    Canônica = ativa > atualizada mais recente > criada mais cedo (mesma regra do ensureClienteMarca).
CREATE TEMP TABLE _dupe_marca_map ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    m.id,
    FIRST_VALUE(m.id) OVER (
      PARTITION BY m.tenant_id, m.cliente_id
      ORDER BY (m.status = 'ativa') DESC, m.atualizado_em DESC NULLS LAST, m.criado_em ASC, m.id
    ) AS canonical_id
  FROM marcas m
  WHERE m.tipo = 'cliente' AND m.cliente_id IS NOT NULL
)
SELECT id AS dupe_id, canonical_id
FROM ranked
WHERE id <> canonical_id;

-- 4) Repointa TODAS as referências das marcas duplicadas para a canônica
--    (5 tabelas que referenciam marcas: lives, vendas_atribuidas, video_registros,
--     agenda_eventos, apresentadora_marcas) antes de remover as duplicadas.
UPDATE lives l
   SET marca_id = d.canonical_id
  FROM _dupe_marca_map d
 WHERE l.marca_id = d.dupe_id;

UPDATE vendas_atribuidas va
   SET marca_id = d.canonical_id
  FROM _dupe_marca_map d
 WHERE va.marca_id = d.dupe_id;

UPDATE video_registros vr
   SET marca_id = d.canonical_id
  FROM _dupe_marca_map d
 WHERE vr.marca_id = d.dupe_id;

UPDATE agenda_eventos ae
   SET marca_id = d.canonical_id
  FROM _dupe_marca_map d
 WHERE ae.marca_id = d.dupe_id;

-- apresentadora_marcas: UNIQUE(marca_id, apresentadora_id). Repointa só quando a canônica
-- ainda não tem aquela apresentadora; o resto é descartado (vínculo já existe na canônica).
UPDATE apresentadora_marcas am
   SET marca_id = d.canonical_id
  FROM _dupe_marca_map d
 WHERE am.marca_id = d.dupe_id
   AND NOT EXISTS (
     SELECT 1 FROM apresentadora_marcas am2
     WHERE am2.marca_id = d.canonical_id
       AND am2.apresentadora_id = am.apresentadora_id
   );
DELETE FROM apresentadora_marcas am
 USING _dupe_marca_map d
 WHERE am.marca_id = d.dupe_id;

-- 5) Remove as marcas duplicadas (agora sem referências).
DELETE FROM marcas m
 USING _dupe_marca_map d
 WHERE m.id = d.dupe_id;

-- 6) Backfill lives.marca_id para lives com cliente mas sem marca resolvida.
UPDATE lives l
   SET marca_id = m.id
  FROM marcas m
 WHERE l.marca_id IS NULL
   AND l.cliente_id IS NOT NULL
   AND m.tenant_id = l.tenant_id
   AND m.cliente_id = l.cliente_id
   AND m.tipo = 'cliente';

-- 7) Garante 1 marca tipo='cliente' por cliente por tenant (impede futuras duplicatas).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_marca_cliente_por_tenant
  ON marcas (tenant_id, cliente_id)
  WHERE tipo = 'cliente' AND cliente_id IS NOT NULL;
