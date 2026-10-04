-- 175: lives.cliente_id herdado da marca tipo='cliente' (cadastro unificado, F3).
--
-- Lives importadas (analytics/TikTok Studio) nascem só com marca_id; sem cliente_id
-- elas não aparecem no portal do cliente nem nas métricas por cliente. Este gatilho
-- preenche NEW.cliente_id quando:
--   - cliente_id veio NULL, e
--   - a marca é tipo='cliente' com cliente_id (mesmo tenant), e
--   - em UPDATE, marca_id realmente mudou.
-- Nunca sobrescreve um cliente_id informado. Não age em live de união
-- (uniao_id / uniao_destino_id / uniao_desfeita_em — migration 150).
--
-- Lê SÓ marcas.id, tenant_id, tipo e cliente_id: o papel livelab_portal_runtime
-- (migration 145) tem SELECT nessas colunas e NÃO em `sistema` — por isso o gatilho
-- não consulta `sistema` (marca-sistema é tipo 'propria', fica de fora pelo tipo).
--
-- Ordem: gatilhos BEFORE do mesmo evento rodam em ordem alfabética de nome;
-- guard_live_uniao (150) roda antes de lives_cliente_da_marca e já bloqueia
-- mudança de marca em live de união.
--
-- Reaplicável: CREATE OR REPLACE + DROP TRIGGER IF EXISTS / CREATE TRIGGER.
-- Rollback manual: docs/ops/rollback-175-176-lives-cliente-id.sql.

CREATE OR REPLACE FUNCTION lives_cliente_da_marca() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_cliente UUID;
BEGIN
  IF NEW.cliente_id IS NOT NULL OR NEW.marca_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.marca_id IS NOT DISTINCT FROM OLD.marca_id THEN
    RETURN NEW;
  END IF;
  IF NEW.uniao_id IS NOT NULL OR NEW.uniao_destino_id IS NOT NULL OR NEW.uniao_desfeita_em IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT m.cliente_id INTO v_cliente
    FROM marcas m
   WHERE m.id = NEW.marca_id
     AND m.tenant_id = NEW.tenant_id
     AND m.tipo = 'cliente'
     AND m.cliente_id IS NOT NULL;

  IF v_cliente IS NOT NULL THEN
    NEW.cliente_id := v_cliente;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS lives_cliente_da_marca ON lives;
CREATE TRIGGER lives_cliente_da_marca
  BEFORE INSERT OR UPDATE OF marca_id ON lives
  FOR EACH ROW EXECUTE FUNCTION lives_cliente_da_marca();

COMMENT ON FUNCTION lives_cliente_da_marca() IS
  'Migration 175: preenche lives.cliente_id (só quando NULL) com o cliente da marca tipo=cliente. '
  'Não age em live de união. Rollback: docs/ops/rollback-175-176-lives-cliente-id.sql.';
