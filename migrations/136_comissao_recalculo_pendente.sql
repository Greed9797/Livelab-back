-- Comissão que congela errada em silêncio.
--
-- Ao editar o GMV de uma live, o recálculo de comissão é disparado FORA da transação, em
-- fire-and-forget (src/routes/lives.js). Se ele falha — ou se o processo morre entre o
-- COMMIT e a chamada — a vendas_atribuidas fica com o valor ANTIGO, não-zero.
--
-- E o cron de reconciliação (src/jobs/recalcular_comissoes.js) só varre
-- `COALESCE(va.comissao_apresentadora, 0) = 0`. Comissão errada mas não-zero nunca é
-- reprocessada: fica errada para sempre, sem erro, sem log, sem ninguém saber.
--
-- Esta coluna é a intenção durável ("esta live precisa de recálculo"), gravada DENTRO da
-- mesma transação da edição e limpa só quando o recálculo confirma. Assim a marca sobrevive
-- a falha de rede, a erro do engine e a queda do processo — os três casos em que hoje o
-- número simplesmente para de bater.
ALTER TABLE lives
  ADD COLUMN IF NOT EXISTS comissao_recalculo_pendente BOOLEAN NOT NULL DEFAULT FALSE;

-- Índice PARCIAL: a varredura do cron busca só as pendentes, que são pouquíssimas. Um índice
-- sobre a tabela inteira custaria escrita em toda live sem benefício de leitura.
CREATE INDEX IF NOT EXISTS lives_comissao_recalculo_pendente_idx
  ON lives (tenant_id, encerrado_em DESC)
  WHERE comissao_recalculo_pendente;

COMMENT ON COLUMN lives.comissao_recalculo_pendente IS
  'TRUE = o GMV/marca/apresentadora mudou e o recálculo de comissão ainda não confirmou. '
  'Gravada na transação da edição, limpa pelo recálculo bem-sucedido. O cron '
  'recalcular_comissoes reprocessa quem ficar marcado.';
