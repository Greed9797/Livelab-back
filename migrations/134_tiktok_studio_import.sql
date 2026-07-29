-- 134_tiktok_studio_import.sql
-- Importação do relatório "Creator Live Performance" (TikTok Studio).
-- Estende o pipeline de import que já existe (113) para um segundo formato de planilha
-- e adiciona a decisão por linha exigida pela tela de revisão pré-importação.

-- 1) Novo source_type. A constraint de 113 só aceitava 'tiktok_ads'.
ALTER TABLE analytics_import_batches
  DROP CONSTRAINT IF EXISTS analytics_import_batches_source_type_check;
ALTER TABLE analytics_import_batches
  ADD CONSTRAINT analytics_import_batches_source_type_check
  CHECK (source_type IN ('tiktok_ads', 'tiktok_studio'));

-- 2) Contexto escolhido no upload (o Creator Live Performance não traz a marca).
ALTER TABLE analytics_import_batches
  ADD COLUMN IF NOT EXISTS marca_id UUID REFERENCES marcas(id),
  ADD COLUMN IF NOT EXISTS apresentadora_id UUID REFERENCES apresentadoras(id);

-- 3) Decisão por linha, definida pelo usuário na revisão antes do apply.
ALTER TABLE analytics_import_rows
  ADD COLUMN IF NOT EXISTS decisao TEXT NOT NULL DEFAULT 'pendente',
  ADD COLUMN IF NOT EXISTS marca_id UUID REFERENCES marcas(id),
  ADD COLUMN IF NOT EXISTS apresentadoras JSONB;

COMMENT ON COLUMN analytics_import_rows.apresentadoras IS
  'Rateio da live: [{"apresentadora_id": uuid, "percentual": numeric}]. Soma dos percentuais = 100.';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'analytics_import_rows_decisao_check'
  ) THEN
    ALTER TABLE analytics_import_rows
      ADD CONSTRAINT analytics_import_rows_decisao_check
      CHECK (decisao IN ('pendente', 'vincular', 'criar', 'ignorar'));
  END IF;
END $$;

-- 4) Pacote fiel das métricas do Studio.
-- As taxas do TikTok não são reproduzíveis a partir dos absolutos (cada uma usa um
-- denominador diferente: Comment rate usa Views, Like rate e Follow rate usam
-- espectadores únicos, que não vêm na planilha). Por isso são guardadas como vieram.
ALTER TABLE lives
  ADD COLUMN IF NOT EXISTS studio_metrics JSONB;

COMMENT ON COLUMN lives.studio_metrics IS
  'Métricas do relatório Creator Live Performance preservadas como vieram (taxas, GPM, CTR, AOV, room_title).';

-- 5) Idempotência: reimportar a mesma planilha atualiza a live, não duplica.
CREATE UNIQUE INDEX IF NOT EXISTS lives_tenant_room_id_uniq
  ON lives (tenant_id, tiktok_room_id)
  WHERE tiktok_room_id IS NOT NULL;
