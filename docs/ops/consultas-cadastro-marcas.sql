-- SOMENTE LEITURA - NÃO ALTERA DADOS
-- =============================================================================
--
-- Diagnóstico de cadastro: marcas que explicam receita comercial zerada
-- (fixo mensal e/ou comissão de franquia).
--
-- NÃO executar em produção como passo de deploy. Copiar o SELECT desejado
-- para sessão read-only. Este arquivo não contém INSERT/UPDATE/DELETE/
-- TRUNCATE/ALTER/DROP/COPY FROM.
--
-- "hoje" = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
-- Escopo opcional: descomentar AND m.tenant_id = '<uuid>'::uuid
--
-- Schema (migrations):
--   marcas.tipo / status              080  (+ 'arquivada' em 121)
--   marcas.valor_fixo_minimo          090  (semântica de fixo mensal em 116)
--   marcas.sistema                    104
--   marcas.tipo_cobranca              132
--   marcas.data_inicio / data_fim     133
--   marca_condicoes_comerciais        151  (vencimentos em 165)
--
-- Alinhado a src/lib/receita-marca-sql.js:
--   fixo por vigência E comissão (GMV × %) só entram para tipo = 'cliente' AND sistema = false
--   (marcaGeraReceitaSql; antes a comissão não tinha esse filtro — ver consulta 7)
--   condição vigente = cancelled_at IS NULL AND inicio_vigencia <= data,
--     ORDER BY inicio_vigencia DESC LIMIT 1
--   status não apaga dinheiro histórico; aqui entra só como cadastro inativo
--   status operacional deriva do cliente (src/lib/entity-status.js)
--
-- Cada SELECT abaixo é independente.

-- ---------------------------------------------------------------------------
-- 1) tipo <> 'cliente'
--    Afiliada / própria / parceira não geram fixo por vigência.
--    tipo IN ('cliente','afiliada','propria','parceira') — migration 080.
-- ---------------------------------------------------------------------------
SELECT
  m.tenant_id,
  m.id AS marca_id,
  m.nome,
  m.tipo,
  m.status,
  m.sistema,
  m.cliente_id,
  m.valor_fixo_minimo,
  m.data_inicio,
  m.data_fim
FROM marcas m
WHERE m.tipo <> 'cliente'
-- AND m.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
ORDER BY m.tenant_id, m.nome;

-- ---------------------------------------------------------------------------
-- 2) sistema = true
--    Marca fallback "Livelab Sistema" por tenant (migration 104).
--    receita-marca-sql.js exige COALESCE(m.sistema, false) = false.
-- ---------------------------------------------------------------------------
SELECT
  m.tenant_id,
  m.id AS marca_id,
  m.nome,
  m.tipo,
  m.status,
  m.sistema,
  m.cliente_id,
  m.valor_fixo_minimo,
  m.data_inicio,
  m.data_fim
FROM marcas m
WHERE m.sistema = true
-- AND m.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
ORDER BY m.tenant_id, m.nome;

-- ---------------------------------------------------------------------------
-- 3) data_fim anterior a hoje OU status inativo
--    data_fim (133): contrato encerrado zera meses seguintes.
--    status da marca (080+121): ativa | inativa | pausada | arquivada.
--    status operacional: cliente arquivado/cancelado/reprovado espelha a marca.
-- ---------------------------------------------------------------------------
SELECT
  m.tenant_id,
  m.id AS marca_id,
  m.nome,
  m.tipo,
  m.status AS status_marca,
  CASE
    WHEN m.tipo = 'cliente' AND c.status = 'arquivado' THEN 'arquivada'
    WHEN m.tipo = 'cliente' AND c.status IN ('cancelado', 'cancelado_automaticamente', 'reprovado') THEN 'inativa'
    ELSE m.status
  END AS status_operacional,
  c.status AS status_cliente,
  m.sistema,
  m.data_inicio,
  m.data_fim,
  (NOW() AT TIME ZONE 'America/Sao_Paulo')::date AS hoje
FROM marcas m
LEFT JOIN clientes c
  ON c.id = m.cliente_id
 AND c.tenant_id = m.tenant_id
WHERE (
    (m.data_fim IS NOT NULL
     AND m.data_fim < (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)
    OR m.status IN ('inativa', 'pausada', 'arquivada')
    OR (
      m.tipo = 'cliente'
      AND c.status IN ('arquivado', 'cancelado', 'cancelado_automaticamente', 'reprovado')
    )
  )
-- AND m.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
ORDER BY m.tenant_id, m.data_fim NULLS LAST, m.nome;

-- ---------------------------------------------------------------------------
-- 4) fixo zerado / nulo
--    Fonte da receita: COALESCE(condicao.fixo_mensal, marcas.valor_fixo_minimo).
--    valor_fixo_minimo é NOT NULL DEFAULT 0 (090); fixo_mensal NOT NULL DEFAULT 0 (151).
--    IS NULL fica por defesa (schema legado / restore parcial).
-- ---------------------------------------------------------------------------
SELECT
  m.tenant_id,
  m.id AS marca_id,
  m.nome,
  m.tipo,
  m.status,
  m.sistema,
  m.valor_fixo_minimo AS marca_valor_fixo_minimo,
  cv.id AS condicao_id,
  cv.inicio_vigencia,
  cv.fixo_mensal AS condicao_fixo_mensal,
  cv.origem AS condicao_origem,
  COALESCE(cv.fixo_mensal, m.valor_fixo_minimo, 0) AS fixo_efetivo
FROM marcas m
LEFT JOIN LATERAL (
  SELECT c.id, c.inicio_vigencia, c.fixo_mensal, c.origem
    FROM marca_condicoes_comerciais c
   WHERE c.tenant_id = m.tenant_id
     AND c.marca_id = m.id
     AND c.inicio_vigencia <= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
     AND c.cancelled_at IS NULL
   ORDER BY c.inicio_vigencia DESC
   LIMIT 1
) cv ON true
WHERE COALESCE(cv.fixo_mensal, m.valor_fixo_minimo, 0) = 0
-- AND m.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
ORDER BY m.tenant_id, m.nome;

-- ---------------------------------------------------------------------------
-- 5) sem condição comercial vigente
--    Vigente = cancelled_at IS NULL AND inicio_vigencia <= hoje (151 / 165).
--    Baseline técnico 1900-01-01 conta como vigente; esta lista é só ausência
--    real (nenhuma linha, só canceladas, ou só futura).
-- ---------------------------------------------------------------------------
SELECT
  m.tenant_id,
  m.id AS marca_id,
  m.nome,
  m.tipo,
  m.status,
  m.sistema,
  m.valor_fixo_minimo,
  m.data_inicio,
  m.data_fim,
  (
    SELECT COUNT(*)::int
      FROM marca_condicoes_comerciais c
     WHERE c.tenant_id = m.tenant_id
       AND c.marca_id = m.id
       AND c.cancelled_at IS NULL
  ) AS condicoes_nao_canceladas,
  (
    SELECT MIN(c.inicio_vigencia)
      FROM marca_condicoes_comerciais c
     WHERE c.tenant_id = m.tenant_id
       AND c.marca_id = m.id
       AND c.cancelled_at IS NULL
  ) AS proxima_ou_unica_inicio_vigencia
FROM marcas m
LEFT JOIN LATERAL (
  SELECT c.id
    FROM marca_condicoes_comerciais c
   WHERE c.tenant_id = m.tenant_id
     AND c.marca_id = m.id
     AND c.inicio_vigencia <= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
     AND c.cancelled_at IS NULL
   ORDER BY c.inicio_vigencia DESC
   LIMIT 1
) cv ON true
WHERE cv.id IS NULL
-- AND m.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
ORDER BY m.tenant_id, m.nome;

-- ---------------------------------------------------------------------------
-- 6) consolidada: uma linha por marca, com todos os motivos que se aplicam
-- ---------------------------------------------------------------------------
SELECT
  m.tenant_id,
  m.id AS marca_id,
  m.nome,
  m.tipo,
  m.status AS status_marca,
  CASE
    WHEN m.tipo = 'cliente' AND c.status = 'arquivado' THEN 'arquivada'
    WHEN m.tipo = 'cliente' AND c.status IN ('cancelado', 'cancelado_automaticamente', 'reprovado') THEN 'inativa'
    ELSE m.status
  END AS status_operacional,
  m.sistema,
  m.data_fim,
  m.valor_fixo_minimo AS marca_valor_fixo_minimo,
  cv.id AS condicao_vigente_id,
  cv.inicio_vigencia AS condicao_inicio_vigencia,
  cv.fixo_mensal AS condicao_fixo_mensal,
  ARRAY_REMOVE(ARRAY[
    CASE WHEN m.tipo <> 'cliente' THEN 'tipo_nao_cliente' END,
    CASE WHEN m.sistema = true THEN 'marca_sistema' END,
    CASE WHEN m.data_fim IS NOT NULL
              AND m.data_fim < (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
         THEN 'contrato_encerrado' END,
    CASE WHEN m.status IN ('inativa', 'pausada', 'arquivada')
           OR (m.tipo = 'cliente' AND c.status IN ('arquivado', 'cancelado', 'cancelado_automaticamente', 'reprovado'))
         THEN 'status_inativo' END,
    CASE WHEN COALESCE(cv.fixo_mensal, m.valor_fixo_minimo, 0) = 0 THEN 'fixo_zerado_ou_nulo' END,
    CASE WHEN cv.id IS NULL THEN 'sem_condicao_vigente' END
  ], NULL) AS motivos
FROM marcas m
LEFT JOIN clientes c
  ON c.id = m.cliente_id
 AND c.tenant_id = m.tenant_id
LEFT JOIN LATERAL (
  SELECT c2.id, c2.inicio_vigencia, c2.fixo_mensal
    FROM marca_condicoes_comerciais c2
   WHERE c2.tenant_id = m.tenant_id
     AND c2.marca_id = m.id
     AND c2.inicio_vigencia <= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
     AND c2.cancelled_at IS NULL
   ORDER BY c2.inicio_vigencia DESC
   LIMIT 1
) cv ON true
WHERE m.tipo <> 'cliente'
   OR m.sistema = true
   OR (m.data_fim IS NOT NULL AND m.data_fim < (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)
   OR m.status IN ('inativa', 'pausada', 'arquivada')
   OR (m.tipo = 'cliente' AND c.status IN ('arquivado', 'cancelado', 'cancelado_automaticamente', 'reprovado'))
   OR COALESCE(cv.fixo_mensal, m.valor_fixo_minimo, 0) = 0
   OR cv.id IS NULL
-- AND m.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
ORDER BY m.tenant_id, m.nome;

-- ---------------------------------------------------------------------------
-- 7) GMV que pode ter virado receita indevida (ex.: "Rosa do Deserto")
--    a) marca NÃO-cliente (ou sistema) com % de comissão > 0 na condição vigente
--       ou na própria marca — até a correção de marcaGeraReceitaSql a comissão
--       (GMV × %) dessas marcas virava título de receita;
--    b) marca com % >= 50 (ex.: 100% = o GMV inteiro vira receita);
--    c) títulos materializados (receita_titulos) dessas marcas.
--    Trocar o filtro de nome/tenant conforme o caso.
-- ---------------------------------------------------------------------------
SELECT
  m.tenant_id,
  m.id AS marca_id,
  m.nome,
  m.tipo,
  m.sistema,
  m.status,
  m.cliente_id,
  cl.nome AS cliente_nome,
  m.comissao_franquia_pct AS marca_pct,
  m.valor_fixo_minimo AS marca_fixo,
  cv.inicio_vigencia AS condicao_inicio,
  cv.comissao_franquia_pct AS condicao_pct,
  cv.fixo_mensal AS condicao_fixo,
  cv.origem AS condicao_origem
FROM marcas m
LEFT JOIN clientes cl ON cl.id = m.cliente_id AND cl.tenant_id = m.tenant_id
LEFT JOIN LATERAL (
  SELECT c.inicio_vigencia, c.comissao_franquia_pct, c.fixo_mensal, c.origem
    FROM marca_condicoes_comerciais c
   WHERE c.tenant_id = m.tenant_id AND c.marca_id = m.id
     AND c.inicio_vigencia <= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
     AND c.cancelled_at IS NULL
   ORDER BY c.inicio_vigencia DESC
   LIMIT 1
) cv ON true
WHERE m.nome ILIKE '%deserto%'
   OR ((m.tipo <> 'cliente' OR m.sistema = true)
       AND COALESCE(cv.comissao_franquia_pct, m.comissao_franquia_pct, 0) > 0)
   OR COALESCE(cv.comissao_franquia_pct, m.comissao_franquia_pct, 0) >= 50
-- AND m.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
ORDER BY m.tenant_id, m.nome;

-- 7c) títulos já gravados (baixados, perdidos ou só materializados) dessas marcas
SELECT
  rt.tenant_id,
  m.nome AS marca_nome,
  m.tipo,
  m.sistema,
  rt.competencia,
  rt.componente,
  rt.valor_previsto,
  rt.valor_pago,
  rt.data_vencimento,
  rt.data_pagamento,
  rt.perdido_em
FROM receita_titulos rt
JOIN marcas m ON m.id = rt.marca_id AND m.tenant_id = rt.tenant_id
WHERE m.nome ILIKE '%deserto%'
   OR m.tipo <> 'cliente'
   OR m.sistema = true
-- AND rt.tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
ORDER BY rt.tenant_id, m.nome, rt.competencia, rt.componente;
