-- Migration 133: datas de contrato da marca, para rateio do fixo por dias.
-- Apresentadoras já têm data_inicio/data_fim (migration 041); marcas não tinham.
-- Regra (financeiro.js/marcaFixoMensalSql): fixo mensal rateado por dias dentro de
-- [data_inicio, data_fim]. Datas NULL → mês cheio (comportamento pré-133, retrocompatível).

ALTER TABLE marcas ADD COLUMN IF NOT EXISTS data_inicio DATE;
ALTER TABLE marcas ADD COLUMN IF NOT EXISTS data_fim DATE;

COMMENT ON COLUMN marcas.data_inicio IS 'Início do contrato da marca. Rateia o fixo no mês de entrada (dias ativos/dias do mês). NULL = sem recorte inicial.';
COMMENT ON COLUMN marcas.data_fim IS 'Fim do contrato da marca. Rateia o fixo no mês de saída e zera os meses seguintes. NULL = contrato em aberto.';
