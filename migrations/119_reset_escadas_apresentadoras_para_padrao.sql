-- Migration 119: reset de TODAS as escadas por apresentadora para o padrão do tenant.
--
-- Contexto (caso Edja, 2026-07-03): a migration 118 preservou escadas
-- "personalizadas" de propósito — mas as personalizações existentes eram resíduo
-- de edições manuais de junho sobre a escada ANTIGA (0,5/1/1,5/2), na qual a
-- faixa 50k–150k paga 1% — por isso apresentadoras que cruzavam 70k continuavam
-- em 1% em vez de subir para 1,5%.
--
-- Decisão de negócio (Lucas, 2026-07-03): NENHUMA apresentadora tem comissão
-- negociada individualmente — todas seguem a escada padrão do tenant.
-- Personalizações futuras continuam possíveis pela tela de Usuários (e passam a
-- ser propagáveis/detectáveis pelo badge Padrão/Personalizada).
--
-- Após o deploy: rodar "Fechamento do mês" (julho e, se junho ainda estiver
-- pendente, junho) para re-aplicar a escada aos valores já gravados —
-- vendas APROVADAS não são tocadas pelo recálculo, por design.

-- 1) Zera as escadas por apresentadora (inclui personalizadas residuais).
DELETE FROM apresentadora_comissao_faixas;

-- 2) Rematerializa o padrão do tenant para toda apresentadora ATIVA
--    (inativas recebem lazy via ensureDefaultPresenterCommissionTiers no GET).
INSERT INTO apresentadora_comissao_faixas
  (tenant_id, apresentadora_id, gmv_inicio, gmv_fim, comissao_pct, ativo)
SELECT a.tenant_id, a.id, d.gmv_inicio, d.gmv_fim, d.comissao_pct, true
  FROM apresentadoras a
  JOIN tenant_comissao_faixas_default d ON d.tenant_id = a.tenant_id
 WHERE a.ativo IS TRUE;
