-- 176: backfill de lives.cliente_id a partir da marca tipo='cliente' (cadastro unificado, F3).
--
-- Alvo: lives com cliente_id NULL cuja marca é tipo='cliente' com cliente_id
-- (invariante I6 de docs/ops/consultas-unificacao-cadastro.sql). EXCLUI lives de
-- união (uniao_id / uniao_destino_id / uniao_desfeita_em NOT NULL — migration 150):
-- o guard_live_uniao recusaria o UPDATE e abortaria o start.
--
-- Não mexe em dinheiro: receita/comissão resolvem por marca_id, não por cliente_id.
-- Não toca receita_titulos.
--
-- Seguro para o deploy:
--   - tabela de backup migr176_lives_cliente_id_backup guarda cada live alterada
--     (rollback: docs/ops/rollback-175-176-lives-cliente-id.sql);
--   - roda por tenant com app.tenant_id setado (funciona com ou sem BYPASSRLS);
--   - cada tenant num subbloco com EXCEPTION: erro vira WARNING e o start segue
--     (aquele tenant fica sem backfill; reaplique o bloco manualmente depois);
--   - idempotente: INSERT ... ON CONFLICT DO NOTHING + UPDATE só onde ainda é NULL.
--     Rodar duas vezes não altera nada na segunda.

CREATE TABLE IF NOT EXISTS migr176_lives_cliente_id_backup (
  live_id         UUID PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  marca_id        UUID NOT NULL,
  cliente_id_novo UUID NOT NULL,
  aplicado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS migr176_lives_cliente_id_backup_tenant
  ON migr176_lives_cliente_id_backup (tenant_id);

ALTER TABLE migr176_lives_cliente_id_backup ENABLE ROW LEVEL SECURITY;
ALTER TABLE migr176_lives_cliente_id_backup FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS migr176_lives_cliente_id_backup_tenant ON migr176_lives_cliente_id_backup;
CREATE POLICY migr176_lives_cliente_id_backup_tenant ON migr176_lives_cliente_id_backup
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMENT ON TABLE migr176_lives_cliente_id_backup IS
  'Backup da migration 176 (lives.cliente_id preenchido pela marca tipo=cliente). '
  'Rollback: docs/ops/rollback-175-176-lives-cliente-id.sql. Não é lida pela aplicação.';

DO $$
DECLARE
  r RECORD;
  v_backup BIGINT;
  v_update BIGINT;
  v_total_backup BIGINT := 0;
  v_total_update BIGINT := 0;
  v_pulados_uniao BIGINT := 0;
BEGIN
  FOR r IN SELECT id FROM tenants ORDER BY id LOOP
    BEGIN
      PERFORM set_config('app.tenant_id', r.id::text, true);

      INSERT INTO migr176_lives_cliente_id_backup (live_id, tenant_id, marca_id, cliente_id_novo)
      SELECT l.id, l.tenant_id, l.marca_id, m.cliente_id
        FROM lives l
        JOIN marcas m ON m.id = l.marca_id AND m.tenant_id = l.tenant_id
       WHERE l.tenant_id = r.id
         AND m.tenant_id = r.id
         AND l.cliente_id IS NULL
         AND m.tipo = 'cliente'
         AND m.cliente_id IS NOT NULL
         AND l.uniao_id IS NULL
         AND l.uniao_destino_id IS NULL
         AND l.uniao_desfeita_em IS NULL
      ON CONFLICT (live_id) DO NOTHING;
      GET DIAGNOSTICS v_backup = ROW_COUNT;

      UPDATE lives l
         SET cliente_id = b.cliente_id_novo
        FROM migr176_lives_cliente_id_backup b
       WHERE b.tenant_id = r.id
         AND l.tenant_id = r.id
         AND l.id = b.live_id
         AND l.cliente_id IS NULL
         AND l.uniao_id IS NULL
         AND l.uniao_destino_id IS NULL
         AND l.uniao_desfeita_em IS NULL;
      GET DIAGNOSTICS v_update = ROW_COUNT;

      v_total_backup := v_total_backup + v_backup;
      v_total_update := v_total_update + v_update;
      IF v_update > 0 OR v_backup > 0 THEN
        RAISE NOTICE '[176] tenant %: % live(s) no backup, % atualizada(s)', r.id, v_backup, v_update;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[176] tenant % sem backfill (%): %. Nada deste tenant foi alterado.', r.id, SQLSTATE, SQLERRM;
    END;
  END LOOP;

  -- Diagnóstico (com BYPASSRLS conta todos os tenants; sem, só o último setado).
  SELECT count(*) INTO v_pulados_uniao
    FROM lives l
    JOIN marcas m ON m.id = l.marca_id AND m.tenant_id = l.tenant_id
   WHERE l.cliente_id IS NULL AND m.tipo = 'cliente' AND m.cliente_id IS NOT NULL
     AND (l.uniao_id IS NOT NULL OR l.uniao_destino_id IS NOT NULL OR l.uniao_desfeita_em IS NOT NULL);

  RAISE NOTICE '[176] total: % live(s) no backup, % atualizada(s); % live(s) de união sem cliente_id (não tocadas)',
    v_total_backup, v_total_update, v_pulados_uniao;
END $$;
