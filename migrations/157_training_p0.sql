-- Migration 157 — P0 training catalog + learner state.
-- Catalog is global (same as `manuais`). Progress/bookmarks are tenant+user scoped.
-- Trail % is computed from required lessons only. No certificates, streaks, or popularity.

ALTER TABLE IF EXISTS knowledge_materials
  ADD COLUMN IF NOT EXISTS cover_image_url TEXT
    CHECK (cover_image_url IS NULL OR cover_image_url ~* '^https://'),
  ADD COLUMN IF NOT EXISTS duration_minutes INTEGER
    CHECK (duration_minutes IS NULL OR (duration_minutes BETWEEN 1 AND 600)),
  ADD COLUMN IF NOT EXISTS difficulty TEXT
    CHECK (difficulty IS NULL OR difficulty IN ('iniciante', 'intermediario', 'avancado')),
  ADD COLUMN IF NOT EXISTS objectives TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS prerequisites TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS audience_roles TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS topics TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS platforms TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE IF EXISTS manuais
  ADD COLUMN IF NOT EXISTS difficulty TEXT
    CHECK (difficulty IS NULL OR difficulty IN ('iniciante', 'intermediario', 'avancado')),
  ADD COLUMN IF NOT EXISTS objectives TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS prerequisites TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS audience_roles TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS topics TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS platforms TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS training_trails (
  id               UUID PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  title            TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 2 AND 240),
  outcome          TEXT NOT NULL CHECK (length(trim(outcome)) BETWEEN 2 AND 280),
  audience_roles   TEXT[] NOT NULL DEFAULT '{}',
  topics           TEXT[] NOT NULL DEFAULT '{}',
  difficulty       TEXT NOT NULL DEFAULT 'iniciante'
                   CHECK (difficulty IN ('iniciante', 'intermediario', 'avancado')),
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR (duration_minutes BETWEEN 1 AND 600)),
  featured         BOOLEAN NOT NULL DEFAULT false,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS training_modules (
  id         UUID PRIMARY KEY,
  trail_id   UUID NOT NULL REFERENCES training_trails(id) ON DELETE CASCADE,
  title      TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 2 AND 240),
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (trail_id, sort_order)
);

CREATE TABLE IF NOT EXISTS training_lessons (
  id               UUID PRIMARY KEY,
  module_id        UUID NOT NULL REFERENCES training_modules(id) ON DELETE CASCADE,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  required         BOOLEAN NOT NULL DEFAULT true,
  title            TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 2 AND 240),
  excerpt          TEXT CHECK (excerpt IS NULL OR length(excerpt) <= 500),
  outcome          TEXT CHECK (outcome IS NULL OR length(outcome) <= 280),
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR (duration_minutes BETWEEN 1 AND 600)),
  difficulty       TEXT CHECK (difficulty IS NULL OR difficulty IN ('iniciante', 'intermediario', 'avancado')),
  format           TEXT NOT NULL DEFAULT 'playbook'
                   CHECK (format IN ('video', 'aula_pratica', 'checklist', 'playbook', 'documento')),
  audience_roles   TEXT[] NOT NULL DEFAULT '{}',
  topics           TEXT[] NOT NULL DEFAULT '{}',
  platforms        TEXT[] NOT NULL DEFAULT '{tiktok}',
  objectives       TEXT[] NOT NULL DEFAULT '{}',
  prerequisites    TEXT[] NOT NULL DEFAULT '{}',
  featured         BOOLEAN NOT NULL DEFAULT false,
  source_kind      TEXT NOT NULL DEFAULT 'none'
                   CHECK (source_kind IN ('none', 'network_article', 'unit_material')),
  source_slug      TEXT,
  source_title     TEXT,
  UNIQUE (module_id, sort_order)
);

CREATE TABLE IF NOT EXISTS training_updates (
  id                 UUID PRIMARY KEY,
  title              TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 2 AND 240),
  what_changed       TEXT NOT NULL CHECK (length(trim(what_changed)) BETWEEN 2 AND 800),
  what_to_do_today   TEXT NOT NULL CHECK (length(trim(what_to_do_today)) BETWEEN 2 AND 800),
  effective_on       DATE,
  audience_roles     TEXT[] NOT NULL DEFAULT '{}',
  topics             TEXT[] NOT NULL DEFAULT '{}',
  official_url       TEXT CHECK (official_url IS NULL OR official_url ~* '^https://'),
  owner              TEXT,
  last_reviewed_at   DATE,
  next_review_at     DATE,
  lesson_id          UUID REFERENCES training_lessons(id) ON DELETE SET NULL,
  network_slug       TEXT,
  featured           BOOLEAN NOT NULL DEFAULT false,
  published_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active          BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS training_lesson_progress (
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id       UUID NOT NULL REFERENCES training_lessons(id) ON DELETE CASCADE,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_opened_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, user_id, lesson_id)
);

CREATE INDEX IF NOT EXISTS training_progress_user_last_idx
  ON training_lesson_progress (tenant_id, user_id, last_opened_at DESC);

CREATE TABLE IF NOT EXISTS training_bookmarks (
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id   UUID NOT NULL REFERENCES training_lessons(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, user_id, lesson_id)
);

ALTER TABLE training_lesson_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_lesson_progress FORCE ROW LEVEL SECURITY;
ALTER TABLE training_bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_bookmarks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS training_progress_tenant ON training_lesson_progress;
CREATE POLICY training_progress_tenant ON training_lesson_progress
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

DROP POLICY IF EXISTS training_bookmarks_tenant ON training_bookmarks;
CREATE POLICY training_bookmarks_tenant ON training_bookmarks
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Starter trail: Primeira Live que converte. Lessons reuse existing materials by
-- slug/title when present; they do not copy Markdown or invent finance numbers.
INSERT INTO training_trails (
  id, slug, title, outcome, audience_roles, topics, difficulty,
  duration_minutes, featured, sort_order
) VALUES (
  'a1111111-1111-4111-8111-111111111111',
  'primeira-live-que-converte',
  'Primeira Live que converte',
  'Preparar, abrir e encerrar a primeira live no TikTok com um roteiro curto.',
  ARRAY['apresentadora', 'operacao']::text[],
  ARRAY['live', 'shop']::text[],
  'iniciante',
  28,
  true,
  1
) ON CONFLICT (id) DO NOTHING;

INSERT INTO training_modules (id, trail_id, title, sort_order) VALUES
  ('a1111111-1111-4111-8111-111111111121', 'a1111111-1111-4111-8111-111111111111', 'Preparação', 1),
  ('a1111111-1111-4111-8111-111111111122', 'a1111111-1111-4111-8111-111111111111', 'Ao vivo', 2),
  ('a1111111-1111-4111-8111-111111111123', 'a1111111-1111-4111-8111-111111111111', 'Pós-live', 3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO training_lessons (
  id, module_id, sort_order, required, title, excerpt, outcome,
  duration_minutes, difficulty, format, audience_roles, topics, platforms,
  objectives, prerequisites, featured, source_kind, source_slug, source_title
) VALUES
  (
    'a1111111-1111-4111-8111-111111111131',
    'a1111111-1111-4111-8111-111111111121',
    1, true,
    'Checklist técnico antes de entrar ao vivo',
    'Iluminação, áudio, conexão e os 5 minutos que antecedem o ao vivo.',
    'Chegar no ar com equipamento e roteiro prontos.',
    6, 'iniciante', 'checklist',
    ARRAY['apresentadora', 'operacao']::text[],
    ARRAY['live']::text[],
    ARRAY['tiktok']::text[],
    ARRAY['Conferir iluminação, câmera e áudio', 'Validar conexão e cupom do dia', 'Abrir a live com o primeiro produto em mãos'],
    ARRAY[]::text[],
    true,
    'network_article',
    'como-iniciar-uma-live-com-sucesso-seed',
    'Como iniciar uma live com sucesso'
  ),
  (
    'a1111111-1111-4111-8111-111111111132',
    'a1111111-1111-4111-8111-111111111121',
    2, true,
    'Oferta, estoque e cupom no TikTok Shop',
    'Conferir pin de produto, estoque e cupom antes de abrir a sala.',
    'Entrar ao vivo só com oferta e estoque conferidos.',
    5, 'iniciante', 'checklist',
    ARRAY['apresentadora', 'operacao']::text[],
    ARRAY['shop']::text[],
    ARRAY['tiktok']::text[],
    ARRAY['Listar os 3 produtos de destaque', 'Confirmar estoque e pin no Shop', 'Ativar o cupom do dia'],
    ARRAY['Checklist técnico antes de entrar ao vivo'],
    false,
    'unit_material',
    NULL,
    'Oferta, estoque e cupom no TikTok Shop'
  ),
  (
    'a1111111-1111-4111-8111-111111111133',
    'a1111111-1111-4111-8111-111111111122',
    1, true,
    'Hook dos primeiros 30 segundos',
    'Saudação curta, 3 destaques e o primeiro produto em mãos.',
    'Segurar a sala nos primeiros 30 segundos sem discurso longo.',
    4, 'iniciante', 'video',
    ARRAY['apresentadora']::text[],
    ARRAY['live', 'conteudo']::text[],
    ARRAY['tiktok']::text[],
    ARRAY['Saudar em menos de 10 segundos', 'Anunciar 3 destaques', 'Mostrar o primeiro produto com preço'],
    ARRAY[]::text[],
    true,
    'network_article',
    'como-iniciar-uma-live-com-sucesso-seed',
    'Como iniciar uma live com sucesso'
  ),
  (
    'a1111111-1111-4111-8111-111111111134',
    'a1111111-1111-4111-8111-111111111122',
    2, true,
    'Demonstração, prova e CTA',
    'Mostrar o produto, provar o benefício e pedir a ação no Shop.',
    'Fechar um ciclo demonstração → prova → CTA sem sair do produto.',
    7, 'iniciante', 'aula_pratica',
    ARRAY['apresentadora']::text[],
    ARRAY['live', 'shop']::text[],
    ARRAY['tiktok']::text[],
    ARRAY['Demonstrar o produto em uso', 'Dar uma prova observável', 'Pedir o clique no pin ou cupom'],
    ARRAY['Hook dos primeiros 30 segundos'],
    false,
    'none',
    NULL,
    NULL
  ),
  (
    'a1111111-1111-4111-8111-111111111135',
    'a1111111-1111-4111-8111-111111111123',
    1, true,
    'Leitura de retenção, clique e GMV',
    'Depois da live, anotar retenção, cliques e GMV declarado — sem inventar meta.',
    'Sair da sala com três números observados e um ajuste para a próxima.',
    6, 'iniciante', 'playbook',
    ARRAY['apresentadora', 'operacao', 'gestor']::text[],
    ARRAY['live']::text[],
    ARRAY['tiktok']::text[],
    ARRAY['Registrar retenção e cliques observados', 'Registrar o GMV declarado no encerramento', 'Escolher um ajuste para a próxima live'],
    ARRAY[]::text[],
    false,
    'network_article',
    'onboarding-de-nova-apresentadora-seed',
    'Onboarding de nova apresentadora'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO training_updates (
  id, title, what_changed, what_to_do_today, effective_on,
  audience_roles, topics, official_url, owner, last_reviewed_at, next_review_at,
  lesson_id, network_slug, featured, published_at
) VALUES (
  'a1111111-1111-4111-8111-111111111141',
  'Política de uso da plataforma — releia a conduta ao vivo',
  'A política vigente descreve conduta da apresentadora, conteúdo permitido e o que não pode ser dito ou promovido na live.',
  'Abrir a aula/política, conferir as proibições de conduta e aplicar na próxima live.',
  DATE '2026-05-01',
  ARRAY['apresentadora', 'operacao', 'gestor']::text[],
  ARRAY['politicas']::text[],
  NULL,
  'Legal LiveLab',
  DATE '2026-05-09',
  DATE '2026-11-01',
  'a1111111-1111-4111-8111-111111111131',
  'politica-de-uso-da-plataforma-seed',
  true,
  TIMESTAMPTZ '2026-05-09 12:00:00+00'
) ON CONFLICT (id) DO NOTHING;
