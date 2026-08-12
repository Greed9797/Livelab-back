-- 137 — Histórico de vigência do fixo mensal da apresentadora.
--
-- PROBLEMA: apresentadoras.fixo é um único valor "atual". Todo relatório de um mês
-- passado (ranking, /v1/comissoes/apresentadoras, DRE, PDF de fechamento) lia esse
-- valor, então reajustar um salário reescrevia retroativamente a folha de todos os
-- meses já fechados. Quem imprimiu o PDF de julho em agosto via um número; quem
-- imprimisse de novo em setembro veria outro.
--
-- SOLUÇÃO: uma linha por mudança de valor. A próxima linha fecha a anterior — não
-- existe coluna vigencia_fim, que é a fonte clássica de intervalo roto/sobreposto.
-- Consulta = última linha com vigencia_inicio <= data de referência.
--
-- PROPRIEDADE DE SEGURANÇA (o que torna esta migration aplicável com o sistema no ar):
-- o backfill grava o valor ATUAL vigente desde 1900-01-01, e todo leitor faz
-- COALESCE(histórico, apresentadoras.fixo). Logo após aplicar, TODO número exibido —
-- mês corrente e meses passados — continua idêntico. O congelamento só passa a valer
-- a partir da PRÓXIMA alteração de salário.

CREATE TABLE IF NOT EXISTS apresentadora_fixo_historico (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  apresentadora_id UUID NOT NULL REFERENCES apresentadoras(id) ON DELETE CASCADE,
  valor NUMERIC(15,2) NOT NULL,
  vigencia_inicio DATE NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- UNIQUE, não só índice: duas edições no mesmo dia (corrigir um erro de digitação é
-- rotina) empatariam o vigencia_inicio e a leitura "última linha" ficaria sem critério
-- de desempate — o mesmo relatório mudaria de número entre dois refreshes. Com o
-- UNIQUE, a segunda edição do dia sobrescreve a primeira (ON CONFLICT no trigger).
-- Serve também de índice do lookup (tenant + apresentadora + data).
CREATE UNIQUE INDEX IF NOT EXISTS apresentadora_fixo_historico_vigencia_uk
  ON apresentadora_fixo_historico (tenant_id, apresentadora_id, vigencia_inicio);

-- Backfill ANTES de ligar o RLS: o runner de migrations roda pelo pool de sistema, que
-- por invariante NUNCA seta app.tenant_id (src/plugins/db.js). Com o RLS já ativo e um
-- role sem BYPASSRLS, este INSERT gravaria zero linhas SEM erro e a migration ficaria
-- marcada como aplicada para sempre.
-- 1900-01-01 (e não data_inicio do contrato): garante que QUALQUER janela consultada
-- encontre a linha do backfill, que é o que sustenta "nenhum número muda hoje".
-- data_inicio já tem dono — é o rateio por dias de contrato em prorateFatorSql.
INSERT INTO apresentadora_fixo_historico (tenant_id, apresentadora_id, valor, vigencia_inicio)
SELECT a.tenant_id, a.id, COALESCE(a.fixo, 0), DATE '1900-01-01'
  FROM apresentadoras a
 ON CONFLICT (tenant_id, apresentadora_id, vigencia_inicio) DO NOTHING;

-- O registro é feito por TRIGGER na coluna, não nas rotas, por três motivos concretos:
--   1. São 5 caminhos de escrita de apresentadoras.fixo (usuarios.js convite e PATCH,
--      apresentadoras.js PATCH e auto-provisionamento). O caminho dominante é
--      PATCH /v1/usuarios/:id — a maioria das apresentadoras tem login e NÃO passa pelo
--      PATCH de apresentadora. Instrumentar rota por rota deixaria buracos.
--   2. Sobrevive a rollback de deploy: com a tabela criada e o código antigo no ar, as
--      edições continuam deixando rastro. Sem isso, o histórico congelaria no valor
--      velho e a folha ficaria errada em silêncio.
--   3. A invariante é "toda mudança da coluna deixa rastro" — isso pertence ao banco.
-- Data no fuso de São Paulo, não CURRENT_DATE: o processo roda em UTC no Railway e entre
-- 21h e meia-noite a data do servidor já é a de amanhã.
-- criado_por fica de fora de propósito: quem editou já está no audit_log.
-- O PRIMEIRO valor de uma apresentadora abre a vigência em 1900, igual ao backfill: um
-- valor inicial não tem "antes". Carimbar a data de cadastro deixaria todo mês anterior
-- a ela sem linha, caindo no COALESCE para apresentadoras.fixo — que é o valor mutável.
-- Ou seja: quem entrasse depois desta migration continuaria com mês fechado flutuante,
-- e o DRE cobra o fixo cheio de toda apresentadora ativa em todo mês consultado
-- (financeiro.js não filtra por data de contratação).
-- Só a MUDANÇA de valor é datada no dia em que aconteceu.
CREATE OR REPLACE FUNCTION apresentadora_fixo_historico_registrar() RETURNS trigger AS $$
BEGIN
  INSERT INTO apresentadora_fixo_historico (tenant_id, apresentadora_id, valor, vigencia_inicio)
  VALUES (NEW.tenant_id, NEW.id, COALESCE(NEW.fixo, 0),
          CASE WHEN TG_OP = 'INSERT' THEN DATE '1900-01-01'
               ELSE (now() AT TIME ZONE 'America/Sao_Paulo')::date END)
  ON CONFLICT (tenant_id, apresentadora_id, vigencia_inicio)
    DO UPDATE SET valor = EXCLUDED.valor;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Dois triggers, não um com OR: a cláusula WHEN de um trigger de INSERT não enxerga
-- OLD, e TG_OP só existe dentro do corpo da função. Um trigger único
-- "AFTER INSERT OR UPDATE ... WHEN (TG_OP = 'INSERT' OR NEW.fixo IS DISTINCT FROM OLD.fixo)"
-- é recusado pelo Postgres com `column "tg_op" does not exist`.
DROP TRIGGER IF EXISTS apresentadora_fixo_historico_ins ON apresentadoras;
CREATE TRIGGER apresentadora_fixo_historico_ins
AFTER INSERT ON apresentadoras
FOR EACH ROW
EXECUTE FUNCTION apresentadora_fixo_historico_registrar();

-- WHEN evita gravar vigência quando o salvamento não mexeu no salário: o formulário
-- reenvia o fixo em toda edição (foto, nome, telefone).
DROP TRIGGER IF EXISTS apresentadora_fixo_historico_upd ON apresentadoras;
CREATE TRIGGER apresentadora_fixo_historico_upd
AFTER UPDATE OF fixo ON apresentadoras
FOR EACH ROW
WHEN (NEW.fixo IS DISTINCT FROM OLD.fixo)
EXECUTE FUNCTION apresentadora_fixo_historico_registrar();

-- RLS — mesmo padrão das demais tabelas (USING + WITH CHECK por app.tenant_id)
ALTER TABLE apresentadora_fixo_historico ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS apresentadora_fixo_historico_tenant ON apresentadora_fixo_historico;
CREATE POLICY apresentadora_fixo_historico_tenant ON apresentadora_fixo_historico
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
