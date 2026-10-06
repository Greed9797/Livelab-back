-- 180 — FIN-03A: fatos individuais de liquidação e estorno.
--
-- Base estritamente aditiva: não altera escritores, não faz backfill e não cria
-- conta/ledger ou fechamento. A obrigação de origem permanece polimórfica por
-- natureza + tipo + UUID; a validação da existência do alvo fica para o writer
-- canônico, porque as obrigações atuais vivem em tabelas diferentes.
--
-- Idempotência: a chave é única por tenant e por operação (uma tabela por
-- operação). O payload JSONB preserva o conteúdo normalizado para que o writer
-- possa distinguir replay idêntico de conflito sem inventar essa política aqui.
--
-- Precisão: PostgreSQL arredonda casas excedentes ao converter para NUMERIC(15,2)
-- antes dos CHECKs. O writer canônico deve validar o valor exato com
-- exactMoneyToCents (src/lib/money.js) e rejeitar mais de duas casas antes do INSERT.

CREATE TABLE IF NOT EXISTS financeiro_liquidacoes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  natureza              TEXT NOT NULL,
  origem_tipo           TEXT NOT NULL,
  origem_id             UUID NOT NULL,
  valor                 NUMERIC(15,2) NOT NULL,
  data_liquidacao       DATE NOT NULL,
  comando_origem        TEXT NOT NULL,
  ator_tipo             TEXT NOT NULL,
  ator_id               TEXT NOT NULL,
  motivo                TEXT,
  idempotencia_chave    TEXT NOT NULL,
  idempotencia_payload  JSONB NOT NULL,
  registrado_em         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT financeiro_liquidacoes_natureza_check
    CHECK (natureza IN ('receita', 'custo')),
  CONSTRAINT financeiro_liquidacoes_origem_tipo_check
    CHECK (btrim(origem_tipo) <> ''),
  CONSTRAINT financeiro_liquidacoes_valor_check
    CHECK (valor > 0),
  CONSTRAINT financeiro_liquidacoes_comando_origem_check
    CHECK (btrim(comando_origem) <> ''),
  CONSTRAINT financeiro_liquidacoes_ator_tipo_check
    CHECK (btrim(ator_tipo) <> ''),
  CONSTRAINT financeiro_liquidacoes_ator_id_check
    CHECK (btrim(ator_id) <> ''),
  CONSTRAINT financeiro_liquidacoes_idempotencia_chave_check
    CHECK (btrim(idempotencia_chave) <> ''),
  CONSTRAINT financeiro_liquidacoes_idempotencia_payload_check
    CHECK (jsonb_typeof(idempotencia_payload) = 'object'),
  CONSTRAINT financeiro_liquidacoes_tenant_id_uk
    UNIQUE (tenant_id, id),
  CONSTRAINT financeiro_liquidacoes_idempotencia_uk
    UNIQUE (tenant_id, idempotencia_chave)
);

CREATE INDEX IF NOT EXISTS financeiro_liquidacoes_origem_idx
  ON financeiro_liquidacoes (tenant_id, origem_tipo, origem_id, data_liquidacao);
CREATE INDEX IF NOT EXISTS financeiro_liquidacoes_data_idx
  ON financeiro_liquidacoes (tenant_id, data_liquidacao);

CREATE TABLE IF NOT EXISTS financeiro_estornos (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  liquidacao_id         UUID NOT NULL,
  valor                 NUMERIC(15,2) NOT NULL,
  data_estorno          DATE NOT NULL,
  comando_origem        TEXT NOT NULL,
  ator_tipo             TEXT NOT NULL,
  ator_id               TEXT NOT NULL,
  motivo                TEXT,
  idempotencia_chave    TEXT NOT NULL,
  idempotencia_payload  JSONB NOT NULL,
  registrado_em         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT financeiro_estornos_liquidacao_fk
    FOREIGN KEY (tenant_id, liquidacao_id)
    REFERENCES financeiro_liquidacoes (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT financeiro_estornos_valor_check
    CHECK (valor > 0),
  CONSTRAINT financeiro_estornos_comando_origem_check
    CHECK (btrim(comando_origem) <> ''),
  CONSTRAINT financeiro_estornos_ator_tipo_check
    CHECK (btrim(ator_tipo) <> ''),
  CONSTRAINT financeiro_estornos_ator_id_check
    CHECK (btrim(ator_id) <> ''),
  CONSTRAINT financeiro_estornos_idempotencia_chave_check
    CHECK (btrim(idempotencia_chave) <> ''),
  CONSTRAINT financeiro_estornos_idempotencia_payload_check
    CHECK (jsonb_typeof(idempotencia_payload) = 'object'),
  CONSTRAINT financeiro_estornos_idempotencia_uk
    UNIQUE (tenant_id, idempotencia_chave)
);

CREATE INDEX IF NOT EXISTS financeiro_estornos_liquidacao_idx
  ON financeiro_estornos (tenant_id, liquidacao_id, data_estorno);
CREATE INDEX IF NOT EXISTS financeiro_estornos_data_idx
  ON financeiro_estornos (tenant_id, data_estorno);

COMMENT ON TABLE financeiro_liquidacoes IS
  'FIN-03A: fatos individuais e imutáveis de liquidação; sem conta/ledger, fechamento ou backfill legado.';
COMMENT ON COLUMN financeiro_liquidacoes.origem_tipo IS
  'Discriminador da obrigação polimórfica; origem_id guarda o UUID do registro de origem.';
COMMENT ON COLUMN financeiro_liquidacoes.valor IS
  'Writer deve validar valor exato com no máximo 2 casas antes do INSERT; NUMERIC(15,2) arredonda excesso de casas.';
COMMENT ON COLUMN financeiro_liquidacoes.idempotencia_payload IS
  'Payload normalizado persistido para comparação de replay/conflito pelo writer canônico futuro.';
COMMENT ON TABLE financeiro_estornos IS
  'FIN-03A: fatos individuais e imutáveis de estorno, sempre vinculados a uma liquidação do mesmo tenant.';
COMMENT ON COLUMN financeiro_estornos.valor IS
  'Valor individual do estorno; writer deve validar no máximo 2 casas antes do INSERT. Limites agregados dependem de regra posterior.';

ALTER TABLE financeiro_liquidacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE financeiro_liquidacoes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS financeiro_liquidacoes_tenant ON financeiro_liquidacoes;
CREATE POLICY financeiro_liquidacoes_tenant ON financeiro_liquidacoes
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE financeiro_estornos ENABLE ROW LEVEL SECURITY;
ALTER TABLE financeiro_estornos FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS financeiro_estornos_tenant ON financeiro_estornos;
CREATE POLICY financeiro_estornos_tenant ON financeiro_estornos
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION bloquear_mutacao_financeiro_evento_180()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'eventos financeiros FIN-03A são imutáveis'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS financeiro_liquidacoes_immutable ON financeiro_liquidacoes;
CREATE TRIGGER financeiro_liquidacoes_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON financeiro_liquidacoes
  FOR EACH STATEMENT EXECUTE FUNCTION bloquear_mutacao_financeiro_evento_180();

DROP TRIGGER IF EXISTS financeiro_estornos_immutable ON financeiro_estornos;
CREATE TRIGGER financeiro_estornos_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON financeiro_estornos
  FOR EACH STATEMENT EXECUTE FUNCTION bloquear_mutacao_financeiro_evento_180();
