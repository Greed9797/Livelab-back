-- Backfill da escada padrão de comissão por GMV mensal das apresentadoras.
-- Regra (cliff exclusivo, decidida 2026-05-25):
--   GMV mensal     →  comissão
--     0     – 50k  →  0,5%
--    50k+   – 150k →  1,0%
--   150k+   – 500k →  1,5%
--   500k+          →  2,0%
-- Aplica apenas em apresentadoras ATIVAS que ainda não têm faixa registrada,
-- mantendo customizações existentes intactas. Idempotente.

DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT a.id AS apresentadora_id, a.tenant_id
      FROM apresentadoras a
     WHERE a.ativo IS TRUE
       AND NOT EXISTS (
         SELECT 1 FROM apresentadora_comissao_faixas f
          WHERE f.apresentadora_id = a.id
            AND f.tenant_id = a.tenant_id
       )
  LOOP
    INSERT INTO apresentadora_comissao_faixas
      (tenant_id, apresentadora_id, gmv_inicio, gmv_fim, comissao_pct, ativo)
    VALUES
      (rec.tenant_id, rec.apresentadora_id,      0,      50000, 0.5, true),
      (rec.tenant_id, rec.apresentadora_id,  50000.01, 150000, 1.0, true),
      (rec.tenant_id, rec.apresentadora_id, 150000.01, 500000, 1.5, true),
      (rec.tenant_id, rec.apresentadora_id, 500000.01,   NULL, 2.0, true);
  END LOOP;
END $$;

-- Função reusável: aplica default em UMA apresentadora (chamada pelo backend
-- quando provisiona perfil novo). Não falha se já houver faixas.
CREATE OR REPLACE FUNCTION apply_default_apresentadora_faixas(
  p_apresentadora_id UUID,
  p_tenant_id UUID
) RETURNS VOID AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM apresentadora_comissao_faixas
     WHERE apresentadora_id = p_apresentadora_id
       AND tenant_id = p_tenant_id
  ) THEN
    RETURN;
  END IF;

  INSERT INTO apresentadora_comissao_faixas
    (tenant_id, apresentadora_id, gmv_inicio, gmv_fim, comissao_pct, ativo)
  VALUES
    (p_tenant_id, p_apresentadora_id,      0,      50000, 0.5, true),
    (p_tenant_id, p_apresentadora_id,  50000.01, 150000, 1.0, true),
    (p_tenant_id, p_apresentadora_id, 150000.01, 500000, 1.5, true),
    (p_tenant_id, p_apresentadora_id, 500000.01,   NULL, 2.0, true);
END $$ LANGUAGE plpgsql;
