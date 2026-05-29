-- Sanity cleanup: zera fixos absurdos (>R$ 1 milhão) inseridos por bug histórico.
-- Idempotente: roda em qualquer tenant; só afeta linhas com valor fora da realidade operacional.
UPDATE apresentadoras SET fixo = 0 WHERE fixo > 1000000;
UPDATE apresentadoras SET meta_diaria_gmv = 0 WHERE meta_diaria_gmv > 100000000;
