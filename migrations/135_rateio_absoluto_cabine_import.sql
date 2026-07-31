-- 135: rateio por valor absoluto + cabine escolhida por linha do import
--
-- Contexto: até aqui o split de uma live entre apresentadoras era só percentual
-- (live_apresentadoras_v2.percentual_rateio NUMERIC(5,2)). Quem opera não pensa em
-- porcentagem: pensa "a Ana fez 4h e vendeu R$ 3.000, a Bia fez 5h e vendeu R$ 2.000".
-- Converter isso para % e voltar introduz erro de arredondamento justamente onde há dinheiro.
--
-- percentual_rateio NÃO é removida: continua gravada (derivada do GMV) porque é o que
-- src/services/commission-engine.js lê hoje, e porque linhas antigas dependem dela.
-- As colunas novas são a fonte precisa; o percentual vira espelho.

ALTER TABLE live_apresentadoras_v2
  -- NUMERIC(15,2) = mesma escala de lives.fat_gerado e vendas_atribuidas.gmv.
  -- Não cabe em percentual_rateio NUMERIC(5,2), que estoura em R$ 1.000,00.
  ADD COLUMN IF NOT EXISTS gmv_rateado NUMERIC(15,2),
  -- Segundos, não horas: a duração da live vem de encerrado_em - iniciado_em e de
  -- analytics_import_rows.duration_seconds, ambos em segundos. Converter para horas
  -- decimais aqui perderia precisão sem ganhar nada — a UI é que formata em h/min.
  ADD COLUMN IF NOT EXISTS segundos_rateio INTEGER;

COMMENT ON COLUMN live_apresentadoras_v2.gmv_rateado IS
  'GMV em R$ atribuído a esta apresentadora nesta live. Quando preenchido, tem precedência sobre percentual_rateio no commission-engine.';
COMMENT ON COLUMN live_apresentadoras_v2.segundos_rateio IS
  'Segundos de live atribuídos a esta apresentadora. A soma das linhas fecha a duração da live.';

-- Cabine por linha, não por lote.
-- lives.cabine_id é NOT NULL, então criar live pelo import sempre precisou de uma cabine.
-- Até aqui ela era ADIVINHADA uma única vez por lote (resolveCabinePadrao em
-- src/routes/analytics.js): todas as linhas caíam na mesma cabine, mesmo vindo de cabines
-- diferentes. Com a coluna abaixo o usuário confirma cabine linha a linha; quando fica NULL,
-- o fallback antigo continua valendo.
ALTER TABLE analytics_import_rows
  ADD COLUMN IF NOT EXISTS cabine_id UUID REFERENCES cabines(id);

COMMENT ON COLUMN analytics_import_rows.cabine_id IS
  'Cabine confirmada na revisão. NULL = usa a cabine padrão inferida no apply.';
