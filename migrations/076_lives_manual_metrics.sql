-- Migration 076: adiciona colunas de métricas manuais à tabela lives
-- Permite registrar likes, visualizações, pedidos e GMV capturados manualmente
-- ao encerrar uma live (dados não coletados automaticamente via TikTok connector).

ALTER TABLE lives ADD COLUMN IF NOT EXISTS manual_likes   INTEGER;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS manual_views   INTEGER;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS manual_orders  INTEGER;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS manual_gmv     DECIMAL(12,2);
