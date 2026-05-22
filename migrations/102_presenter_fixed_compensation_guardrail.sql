-- Guardrail operacional: valores fixos de apresentadora acima de R$ 10 mil
-- costumam vir de digitação sem separador decimal (ex: 270000).
UPDATE apresentadoras
SET fixo = 2700
WHERE COALESCE(fixo, 0) <= 0
   OR fixo > 10000;
