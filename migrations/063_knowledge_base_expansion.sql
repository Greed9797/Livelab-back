-- Migration 063: Knowledge Base — evolução do módulo `manuais`
-- Adiciona suporte a Markdown inline, vídeo embedado (YouTube/Panda),
-- categorias como entidade, status editorial (draft/published/archived),
-- slug único, autoria e tags.
-- Compat: a tabela `manuais` continua existindo. Endpoints /v1/manuais
-- continuam funcionando. Novos endpoints /v1/knowledge/* expandem o módulo.

-- 1. Nova tabela de categorias (substitui o TEXT em manuais.categoria)
CREATE TABLE IF NOT EXISTS knowledge_categories (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  slug        TEXT        UNIQUE NOT NULL,
  description TEXT,
  icon        TEXT,
  sort_order  INTEGER     DEFAULT 0,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS knowledge_categories_active_idx
  ON knowledge_categories(is_active, sort_order);

-- 2. Expansão da tabela manuais (sem rename — preserva código atual)
ALTER TABLE manuais
  ADD COLUMN IF NOT EXISTS slug                   TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS excerpt                TEXT,
  ADD COLUMN IF NOT EXISTS content_markdown       TEXT,
  ADD COLUMN IF NOT EXISTS cover_image_url        TEXT,
  ADD COLUMN IF NOT EXISTS video_provider         TEXT
    CHECK (video_provider IN ('youtube', 'panda', 'none')) DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS video_url              TEXT,
  ADD COLUMN IF NOT EXISTS tags                   TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS status                 TEXT NOT NULL DEFAULT 'published'
    CHECK (status IN ('draft', 'published', 'archived')),
  ADD COLUMN IF NOT EXISTS sort_order             INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_read_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS published_at           TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS created_by             UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS updated_by             UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS category_id            UUID REFERENCES knowledge_categories(id);

CREATE INDEX IF NOT EXISTS manuais_status_idx ON manuais(status, published_at DESC);
CREATE INDEX IF NOT EXISTS manuais_category_id_idx ON manuais(category_id);
CREATE INDEX IF NOT EXISTS manuais_slug_idx ON manuais(slug);

-- 3. Backfill: gera slug a partir do título quando ausente
UPDATE manuais
   SET slug = lower(regexp_replace(
     translate(titulo, 'áàãâäéèêëíìîïóòõôöúùûüçÁÀÃÂÄÉÈÊËÍÌÎÏÓÒÕÔÖÚÙÛÜÇ',
                       'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'),
     '[^a-zA-Z0-9]+', '-', 'g'
   )) || '-' || substring(id::text, 1, 8)
 WHERE slug IS NULL;

-- 4. Backfill: cria knowledge_categories a partir do TEXT antigo manuais.categoria
INSERT INTO knowledge_categories (name, slug)
  SELECT DISTINCT
    categoria,
    lower(regexp_replace(
      translate(categoria, 'áàãâäéèêëíìîïóòõôöúùûüçÁÀÃÂÄÉÈÊËÍÌÎÏÓÒÕÔÖÚÙÛÜÇ',
                          'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'),
      '[^a-zA-Z0-9]+', '-', 'g'
    ))
  FROM manuais
  WHERE categoria IS NOT NULL
ON CONFLICT (slug) DO NOTHING;

-- 5. Backfill: linka manuais.category_id ao knowledge_categories
UPDATE manuais m
   SET category_id = c.id
  FROM knowledge_categories c
 WHERE m.categoria = c.name
   AND m.category_id IS NULL;
