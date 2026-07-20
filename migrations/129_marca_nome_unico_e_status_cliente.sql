-- Migration 129 — Higiene de dados: (1) unicidade de nome de marca por tenant,
-- (2) diagnóstico dos status legados de cliente.
--
-- Molde de auto-proteção copiado da migration 127: nada aqui aborta o deploy
-- por causa de dado sujo em produção. Quando o dado impede a mudança, contamos
-- o problema, emitimos RAISE WARNING com a instrução de correção e PULAMOS a
-- alteração. Reaplicar a migration depois da limpeza é seguro (idempotente).

-- ─────────────────────────────────────────────────────────────────────────────
-- L4-2 — UNIQUE INDEX (tenant_id, lower(nome)) em marcas
--
-- Por quê: o analytics-import casa linha de planilha com marca POR NOME. Duas
-- marcas com o mesmo nome no mesmo tenant tornam esse matching não-determinístico
-- (a importação atribui GMV para a marca errada, silenciosamente).
--
-- lower(nome) e não nome: 'Boca Rosa' e 'boca rosa' são a mesma marca para quem
-- digita, e o matching do import normaliza caixa.
--
-- ⚠️ RISCO DE DUPLICATA JÁ GRAVADA EM PRODUÇÃO
-- Se existir qualquer (tenant_id, lower(nome)) repetido, o CREATE UNIQUE INDEX
-- falha e derruba o deploy inteiro. Esta migration conta as duplicatas antes e,
-- se houver, só avisa — NÃO cria o índice e NÃO faz dedupe automático.
-- Dedupe é decisão de negócio: apagar ou renomear marca move GMV, comissão e
-- vínculo de apresentadora. Quem decide é o operador, não a migration.
--
-- Se o log do deploy mostrar o WARNING, listar os casos com:
--
--   SELECT tenant_id, lower(nome) AS nome, COUNT(*), array_agg(id) AS marca_ids
--     FROM marcas GROUP BY 1, 2 HAVING COUNT(*) > 1;
--
-- decidir marca a marca (renomear a secundária, ou migrar lives/vídeos/vendas
-- para a principal e arquivar a outra) e então reaplicar esta migration.
--
-- Nota de escopo: o índice cobre TODAS as marcas, inclusive status='inativa'
-- (soft-delete do DELETE /v1/marcas) e 'arquivada'. Isso é intencional — a
-- marca soft-deletada continua existindo para o matching por nome, então
-- permitir um homônimo novo recriaria exatamente a ambiguidade que o índice
-- existe para impedir.

DO $$
DECLARE
  dups bigint;
BEGIN
  IF to_regclass('public.marcas') IS NULL THEN
    RAISE NOTICE '[migration 129] tabela marcas não existe — skip';
    RETURN;
  END IF;

  IF to_regclass('public.uniq_marca_nome_por_tenant') IS NOT NULL THEN
    RAISE NOTICE '[migration 129] índice uniq_marca_nome_por_tenant já existe — skip';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO dups
    FROM (
      SELECT tenant_id, lower(nome)
        FROM marcas
       GROUP BY tenant_id, lower(nome)
      HAVING COUNT(*) > 1
    ) d;

  IF dups > 0 THEN
    RAISE WARNING '[migration 129] % nome(s) de marca duplicado(s) por tenant — índice único NÃO criado. Resolver os duplicados à mão (ver query no comentário desta migration) e reaplicar. Enquanto isso, a API rejeita nomes repetidos com HTTP 409 via checagem explícita em src/routes/marcas.js.', dups;
    RETURN;
  END IF;

  CREATE UNIQUE INDEX uniq_marca_nome_por_tenant
    ON marcas (tenant_id, lower(nome));

  RAISE NOTICE '[migration 129] índice uniq_marca_nome_por_tenant criado';
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- L4-3 — Status de cliente: diagnóstico, sem alterar o CHECK
--
-- A migration 042 deixou o CHECK de clientes.status com 13 valores. Só 9 são
-- escritos ou lidos pelo código hoje (lista em src/routes/clientes.js →
-- CLIENTE_STATUS_VIVOS). Os outros 4 — 'enviado', 'em_analise', 'aprovado',
-- 'risco_assumido' — são status de CONTRATO que vazaram para o CHECK de cliente
-- na migration 016 e nunca chegam a clientes.status por nenhum caminho de código.
--
-- O aperto real foi feito na BORDA (z.enum no PATCH /v1/clientes/:id), não no
-- banco. O CHECK fica como está de propósito:
--   - encolher o CHECK torna INVÁLIDA qualquer linha legada que ainda esteja
--     em um dos 4 estados mortos, e o ALTER ... ADD CONSTRAINT valida a tabela
--     inteira → derrubaria o deploy;
--   - o UPDATE de migração ('em_analise' → 'negociacao', 'aprovado' → 'ativo',
--     'enviado' → 'negociacao', 'risco_assumido' → 'ativo') é plausível mas
--     NÃO é reversível: depois de sobrescrito, o estado original some e não há
--     coluna de histórico em clientes para restaurá-lo.
-- Ou seja: o CHECK largo passa a ser apenas tolerância a legado; nenhum caminho
-- de escrita novo consegue produzir um dos 4 mortos.
--
-- Este bloco só CONTA e reporta. Se o log mostrar contagem > 0, decidir o
-- mapeamento com o time comercial e escrever uma migration 130 dedicada que
-- salve o valor anterior antes do UPDATE.

DO $$
DECLARE
  legados bigint;
  detalhe text;
BEGIN
  IF to_regclass('public.clientes') IS NULL THEN
    RAISE NOTICE '[migration 129] tabela clientes não existe — skip diagnóstico de status';
    RETURN;
  END IF;

  SELECT COUNT(*), string_agg(DISTINCT status, ', ')
    INTO legados, detalhe
    FROM clientes
   WHERE status IN ('enviado', 'em_analise', 'aprovado', 'risco_assumido');

  IF legados > 0 THEN
    RAISE WARNING '[migration 129] % cliente(s) em status legado (%) — CHECK mantido largo de propósito. Nenhuma escrita nova produz esses valores (z.enum no PATCH). Migrar exige decisão de negócio + migration dedicada que preserve o valor anterior.', legados, detalhe;
  ELSE
    RAISE NOTICE '[migration 129] nenhum cliente em status legado — CHECK pode ser enxugado em uma migration futura com segurança';
  END IF;
END $$;
