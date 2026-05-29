-- Webhook replay protection: dedup nonces por janela de 5min.
-- Usado por webhook_bio_crm.js (ativado via WEBHOOK_REPLAY_PROTECTION=true).
-- Garbage collection: limpar rows mais velhas que 7d em cron job.

CREATE TABLE IF NOT EXISTS webhook_replay_log (
  source       text        NOT NULL,
  nonce        text        NOT NULL,
  recebido_em  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, nonce)
);

CREATE INDEX IF NOT EXISTS webhook_replay_log_recebido_em_idx
  ON webhook_replay_log(recebido_em);

-- Não é tabela de tenant — não precisa RLS.
