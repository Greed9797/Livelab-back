-- Portal da apresentadora: registro de vídeo pelo próprio portal.
-- O executor do portal (livelab_portal_runtime) só lia video_registros. Agora
-- escreve as colunas do registro e pode apagar a venda pendente do vídeo
-- (quando o GMV é zerado ou o registro é excluído). A rota restringe à própria
-- apresentadora; a policy abaixo impede que o papel apague qualquer venda que
-- não seja de vídeo ou que já esteja fechada financeiramente.
GRANT INSERT (tenant_id, marca_id, apresentadora_id, data, quantidade, plataforma,
  campanha, gmv_atribuido, pedidos_atribuidos, observacoes, criado_por),
  UPDATE (marca_id, data, quantidade, plataforma, campanha, gmv_atribuido,
  pedidos_atribuidos, observacoes),
  DELETE
  ON video_registros TO livelab_portal_runtime;

GRANT DELETE ON vendas_atribuidas TO livelab_portal_runtime;

DROP POLICY IF EXISTS vendas_atribuidas_portal_delete_video ON vendas_atribuidas;
CREATE POLICY vendas_atribuidas_portal_delete_video ON vendas_atribuidas
  AS RESTRICTIVE FOR DELETE TO livelab_portal_runtime
  USING (origem = 'video' AND COALESCE(status_aprovacao, 'pendente_aprovacao') NOT IN ('aprovada', 'fechada', 'faturada'));
