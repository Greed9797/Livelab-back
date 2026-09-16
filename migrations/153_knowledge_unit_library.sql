-- Migration 153 — Biblioteca Base por unidade.
--
-- `manuais` e `knowledge_categories` permanecem como conteúdo legado global.
-- Conteúdo novo vive em tabelas próprias com tenant_id: adicionar tenant_id a
-- `manuais` faria o endpoint legado vazar/ocultar linhas durante a janela de
-- compatibilidade. RLS é defesa em profundidade; as rotas também filtram o
-- tenant explicitamente e aplicam o escopo de papel.

CREATE TABLE IF NOT EXISTS knowledge_unit_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  slug        TEXT NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  description TEXT,
  icon        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS knowledge_unit_categories_active_idx
  ON knowledge_unit_categories(tenant_id, is_active, sort_order, name);

CREATE TABLE IF NOT EXISTS knowledge_materials (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category_id           UUID,
  title                 TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 2 AND 240),
  slug                  TEXT NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  excerpt               TEXT CHECK (excerpt IS NULL OR length(excerpt) <= 500),
  content_markdown      TEXT CHECK (content_markdown IS NULL OR length(content_markdown) <= 50000),
  material_type         TEXT NOT NULL DEFAULT 'playbook'
                        CHECK (material_type IN ('playbook', 'study', 'video', 'document', 'link')),
  external_url          TEXT,
  video_provider        TEXT NOT NULL DEFAULT 'none'
                        CHECK (video_provider IN ('youtube', 'panda', 'none')),
  video_id              TEXT,
  tags                  TEXT[] NOT NULL DEFAULT '{}',
  status                TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'published', 'archived')),
  revision              INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  idempotency_key       TEXT,
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  published_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, slug),
  UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT knowledge_materials_category_same_tenant_fk
    FOREIGN KEY (tenant_id, category_id)
    REFERENCES knowledge_unit_categories (tenant_id, id)
    ON DELETE SET NULL,
  CONSTRAINT knowledge_materials_external_url_check
    CHECK (external_url IS NULL OR external_url ~* '^https://')
);

CREATE INDEX IF NOT EXISTS knowledge_materials_browse_idx
  ON knowledge_materials(tenant_id, status, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS knowledge_materials_category_idx
  ON knowledge_materials(tenant_id, category_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_materials_tags_idx
  ON knowledge_materials USING GIN(tags);

CREATE TABLE IF NOT EXISTS knowledge_material_attachments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  material_id    UUID NOT NULL,
  storage_key    TEXT NOT NULL UNIQUE,
  original_name  TEXT NOT NULL CHECK (length(trim(original_name)) BETWEEN 1 AND 255),
  mime_type      TEXT NOT NULL CHECK (mime_type = 'application/pdf'),
  byte_size      BIGINT NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
  state          TEXT NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending', 'ready', 'orphaned')),
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at       TIMESTAMPTZ,
  orphaned_at    TIMESTAMPTZ,
  UNIQUE (tenant_id, id),
  CONSTRAINT knowledge_attachment_material_same_tenant_fk
    FOREIGN KEY (tenant_id, material_id)
    REFERENCES knowledge_materials (tenant_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS knowledge_attachments_material_idx
  ON knowledge_material_attachments(tenant_id, material_id, state, created_at DESC);

ALTER TABLE knowledge_unit_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_material_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS knowledge_unit_categories_tenant ON knowledge_unit_categories;
CREATE POLICY knowledge_unit_categories_tenant ON knowledge_unit_categories
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

DROP POLICY IF EXISTS knowledge_materials_tenant ON knowledge_materials;
CREATE POLICY knowledge_materials_tenant ON knowledge_materials
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

DROP POLICY IF EXISTS knowledge_attachments_tenant ON knowledge_material_attachments;
CREATE POLICY knowledge_attachments_tenant ON knowledge_material_attachments
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
