-- Migration 114: Painel operacional do cliente
-- Adiciona campos de status operacional, comissão de apresentadora por live,
-- e configuração de metas na tabela clientes.
-- Idempotente: usa ADD COLUMN IF NOT EXISTS e DO block para CHECKs.

-- ── lives: campos de status operacional por sessão ───────────────────────
ALTER TABLE lives
  ADD COLUMN IF NOT EXISTS status_operacional TEXT,
  ADD COLUMN IF NOT EXISTS problema           TEXT,
  ADD COLUMN IF NOT EXISTS proxima_acao       TEXT,
  ADD COLUMN IF NOT EXISTS comissao_apresentadora_pct   NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS comissao_apresentadora_valor NUMERIC(15,2);

-- CHECK constraint idempotente via DO block
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lives_status_operacional_check'
       AND conrelid = 'lives'::regclass
  ) THEN
    ALTER TABLE lives
      ADD CONSTRAINT lives_status_operacional_check
      CHECK (status_operacional IN ('ok','atencao','critico','dados_incompletos'));
  END IF;
END $$;

-- ── clientes: metas de performance para o painel ─────────────────────────
-- NOTA: clicks NÃO adicionado aqui — codex já tem lives.product_clicks da
-- migration 111 (canônico). Não duplicar.
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS meta_gmv_hora NUMERIC(12,2) DEFAULT 500,
  ADD COLUMN IF NOT EXISTS margem_pct    NUMERIC(5,2);

-- NOTA pré-existente (não corrigir): há dois arquivos com prefixo 104_ em
-- migrations/ (104_live_agenda_bidirectional_backfill.sql e
-- 104_marca_sistema_por_tenant.sql) — versionamento descontínuo intencional
-- durante refactor de schema.
