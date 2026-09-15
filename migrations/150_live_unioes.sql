-- Additive only. No existing live is consolidated by this migration.
-- Deploy compatible readers before enabling LIVE_MERGE_TENANT_ALLOWLIST.
ALTER TABLE lives
  ADD COLUMN IF NOT EXISTS uniao_destino_id UUID,
  ADD COLUMN IF NOT EXISTS uniao_id UUID,
  ADD COLUMN IF NOT EXISTS uniao_desfeita_em TIMESTAMPTZ;
ALTER TABLE live_apresentadoras_v2
  ADD COLUMN IF NOT EXISTS pedidos_rateados INTEGER CHECK (pedidos_rateados >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS lives_tenant_id_id_uniao ON lives(tenant_id, id);
CREATE TABLE IF NOT EXISTS live_unioes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  live_destino_id UUID NOT NULL,
  request_id UUID NOT NULL,
  request_hash TEXT NOT NULL,
  preview_token TEXT NOT NULL,
  origens JSONB NOT NULL,
  resultado JSONB NOT NULL,
  motivo TEXT NOT NULL,
  criado_por UUID REFERENCES users(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  desfeito_por UUID REFERENCES users(id),
  desfeito_em TIMESTAMPTZ,
  desfeito_motivo TEXT,
  desfeito_request_id UUID,
  UNIQUE(tenant_id, id),
  UNIQUE(tenant_id, request_id),
  UNIQUE(tenant_id, live_destino_id),
  FOREIGN KEY (tenant_id, live_destino_id) REFERENCES lives(tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS live_unioes_undo_request
  ON live_unioes(tenant_id, desfeito_request_id) WHERE desfeito_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lives_uniao_destino ON lives(tenant_id, uniao_destino_id) WHERE uniao_destino_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lives_uniao ON lives(tenant_id, uniao_id) WHERE uniao_id IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='lives_uniao_destino_fk') THEN
    ALTER TABLE lives ADD CONSTRAINT lives_uniao_destino_fk
      FOREIGN KEY (tenant_id, uniao_destino_id) REFERENCES lives(tenant_id,id);
    ALTER TABLE lives ADD CONSTRAINT lives_uniao_fk
      FOREIGN KEY (tenant_id, uniao_id) REFERENCES live_unioes(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
    ALTER TABLE lives ADD CONSTRAINT lives_uniao_shape CHECK (
      (uniao_destino_id IS NULL OR (uniao_destino_id <> id AND uniao_id IS NULL AND uniao_desfeita_em IS NULL))
      AND (uniao_desfeita_em IS NULL OR uniao_id IS NOT NULL)
    );
  END IF;
END $$;

ALTER TABLE live_unioes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS live_unioes_tenant ON live_unioes;
CREATE POLICY live_unioes_tenant ON live_unioes
  USING (tenant_id = current_setting('app.tenant_id',true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id',true)::uuid);

-- Every mutation path (including imports/jobs) obeys the same freeze. Only the
-- transactional merge service sets this connection-local flag. It is not an API input.
CREATE OR REPLACE FUNCTION guard_live_uniao() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE derived TEXT[] := ARRAY['comissao_calculada','comissao_apresentadora_valor',
  'comissao_apresentadora_pct','comissao_recalculo_pendente','atualizado_em','faturado_em','boleto_id'];
BEGIN
  IF current_setting('livelab.live_merge_write',true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.uniao_id IS NOT NULL OR NEW.uniao_destino_id IS NOT NULL OR NEW.uniao_desfeita_em IS NOT NULL THEN
      RAISE EXCEPTION 'Use a operação de união para consolidar lives.' USING ERRCODE='23514', CONSTRAINT='live_uniao_protected';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.uniao_destino_id IS NOT NULL OR OLD.uniao_desfeita_em IS NOT NULL THEN
    RAISE EXCEPTION 'Registro histórico de união: não pode ser alterado.' USING ERRCODE='23514', CONSTRAINT='live_uniao_protected';
  END IF;
  IF OLD.uniao_id IS NOT NULL THEN
    IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) - derived) = (to_jsonb(NEW) - derived) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Desfaça a união antes de editar ou excluir esta live.' USING ERRCODE='23514', CONSTRAINT='live_uniao_protected';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.uniao_id IS NOT NULL OR NEW.uniao_destino_id IS NOT NULL OR NEW.uniao_desfeita_em IS NOT NULL) THEN
    RAISE EXCEPTION 'Use a operação de união para consolidar lives.' USING ERRCODE='23514', CONSTRAINT='live_uniao_protected';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS guard_live_uniao ON lives;
CREATE TRIGGER guard_live_uniao BEFORE INSERT OR UPDATE OR DELETE ON lives
  FOR EACH ROW EXECUTE FUNCTION guard_live_uniao();

CREATE OR REPLACE FUNCTION guard_live_uniao_participacao() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent lives; row_data RECORD;
BEGIN
  IF current_setting('livelab.live_merge_write',true) = 'on' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  -- Check both parents on reparenting. Locking the live serializes this change
  -- with a concurrent consolidation; a stale writer cannot revive an origin.
  FOR row_data IN
    SELECT DISTINCT value->>'live_id' AS live_id, value->>'tenant_id' AS tenant_id
    FROM jsonb_array_elements(CASE WHEN TG_OP='INSERT' THEN jsonb_build_array(to_jsonb(NEW))
      WHEN TG_OP='DELETE' THEN jsonb_build_array(to_jsonb(OLD))
      ELSE jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW)) END)
    ORDER BY live_id
  LOOP
    SELECT * INTO parent FROM lives WHERE id=row_data.live_id::uuid AND tenant_id=row_data.tenant_id::uuid FOR UPDATE;
    IF parent.uniao_id IS NOT NULL OR parent.uniao_destino_id IS NOT NULL OR parent.uniao_desfeita_em IS NOT NULL THEN
      RAISE EXCEPTION 'Desfaça a união antes de alterar os trechos ou participantes.' USING ERRCODE='23514', CONSTRAINT='live_uniao_protected';
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS guard_live_uniao_participacao ON live_apresentadoras_v2;
CREATE TRIGGER guard_live_uniao_participacao BEFORE INSERT OR UPDATE OR DELETE ON live_apresentadoras_v2
  FOR EACH ROW EXECUTE FUNCTION guard_live_uniao_participacao();
DROP TRIGGER IF EXISTS guard_live_uniao_participacao ON live_apresentadores;
CREATE TRIGGER guard_live_uniao_participacao BEFORE INSERT OR UPDATE OR DELETE ON live_apresentadores
  FOR EACH ROW EXECUTE FUNCTION guard_live_uniao_participacao();

-- Evidence remains on original IDs, read-only while the union exists.
DO $$ DECLARE relation TEXT; BEGIN
  FOREACH relation IN ARRAY ARRAY['live_products','live_snapshots','live_metric_revisions'] LOOP
    IF to_regclass(relation) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS guard_live_uniao_evidence ON %I', relation);
      EXECUTE format('CREATE TRIGGER guard_live_uniao_evidence BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_live_uniao_participacao()', relation);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION guard_live_uniao_venda() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent lives; row_data RECORD; existing vendas_atribuidas;
BEGIN
  IF current_setting('livelab.live_merge_write',true) = 'on' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  FOR row_data IN
    SELECT DISTINCT value->>'origem_id' AS live_id, value->>'tenant_id' AS tenant_id
    FROM jsonb_array_elements(CASE WHEN TG_OP='INSERT' THEN jsonb_build_array(to_jsonb(NEW))
      WHEN TG_OP='DELETE' THEN jsonb_build_array(to_jsonb(OLD))
      ELSE jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW)) END)
    WHERE value->>'origem'='live' ORDER BY live_id
  LOOP
    SELECT * INTO parent FROM lives WHERE id=row_data.live_id::uuid AND tenant_id=row_data.tenant_id::uuid FOR UPDATE;
    IF parent.uniao_destino_id IS NOT NULL OR parent.uniao_desfeita_em IS NOT NULL THEN
      RAISE EXCEPTION 'Atribuição de trecho absorvido por união não pode ser alterada.' USING ERRCODE='23514', CONSTRAINT='live_uniao_protected';
    END IF;
    IF parent.uniao_id IS NOT NULL THEN
      IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'Desfaça a união antes de excluir a atribuição.' USING ERRCODE='23514', CONSTRAINT='live_uniao_protected';
      END IF;
      IF TG_OP='UPDATE' THEN existing := OLD;
      ELSE
        SELECT * INTO existing FROM vendas_atribuidas WHERE tenant_id=NEW.tenant_id AND origem=NEW.origem
          AND origem_id=NEW.origem_id AND apresentadora_id IS NOT DISTINCT FROM NEW.apresentadora_id;
      END IF;
      IF existing.id IS NULL OR NEW.origem IS DISTINCT FROM existing.origem
        OR NEW.origem_id IS DISTINCT FROM existing.origem_id OR NEW.tenant_id IS DISTINCT FROM existing.tenant_id
        OR NEW.apresentadora_id IS DISTINCT FROM existing.apresentadora_id
        OR to_jsonb(NEW)->'marca_id' IS DISTINCT FROM to_jsonb(existing)->'marca_id'
        OR to_jsonb(NEW)->'data' IS DISTINCT FROM to_jsonb(existing)->'data'
        OR NEW.gmv IS DISTINCT FROM existing.gmv OR NEW.pedidos IS DISTINCT FROM existing.pedidos THEN
        RAISE EXCEPTION 'Desfaça a união antes de alterar GMV, pedidos ou titular da atribuição.' USING ERRCODE='23514', CONSTRAINT='live_uniao_protected';
      END IF;
      -- Monthly commission recalculation and approval remain legitimate.
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS guard_live_uniao_venda ON vendas_atribuidas;
CREATE TRIGGER guard_live_uniao_venda BEFORE INSERT OR UPDATE OR DELETE ON vendas_atribuidas
  FOR EACH ROW EXECUTE FUNCTION guard_live_uniao_venda();
