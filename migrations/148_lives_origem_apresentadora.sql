-- A live criada ao validar um relato do portal preserva sua origem humana.
-- A alteração é aditiva: origens históricas manual/api/bot continuam válidas.
ALTER TABLE lives DROP CONSTRAINT IF EXISTS lives_origem_dados_check;
ALTER TABLE lives ADD CONSTRAINT lives_origem_dados_check
  CHECK (origem_dados IN ('manual', 'api', 'bot', 'apresentadora'));
