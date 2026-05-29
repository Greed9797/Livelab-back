-- Corrige o legado users.papel='apresentador(a)' sem perfil operacional
-- em apresentadoras. A identidade operacional canônica segue sendo
-- apresentadoras.id; users.id é apenas login/acesso.

WITH unique_email_matches AS (
  SELECT
    u.tenant_id,
    u.id AS user_id,
    u.nome AS user_nome,
    u.email AS user_email,
    a.id AS apresentadora_id,
    COUNT(*) OVER (PARTITION BY u.tenant_id, u.id) AS matches_por_usuario,
    COUNT(*) OVER (PARTITION BY a.tenant_id, a.id) AS matches_por_apresentadora
  FROM users u
  JOIN apresentadoras a
    ON a.tenant_id = u.tenant_id
   AND a.user_id IS NULL
   AND NULLIF(TRIM(a.email), '') IS NOT NULL
   AND LOWER(a.email) = LOWER(u.email)
  WHERE u.ativo IS NOT FALSE
    AND u.papel IN ('apresentador', 'apresentadora')
    AND NOT EXISTS (
      SELECT 1
      FROM apresentadoras linked
      WHERE linked.tenant_id = u.tenant_id
        AND linked.user_id = u.id
    )
)
UPDATE apresentadoras a
SET user_id = m.user_id,
    nome = COALESCE(NULLIF(TRIM(a.nome), ''), m.user_nome),
    email = COALESCE(NULLIF(TRIM(a.email), ''), m.user_email),
    ativo = true
FROM unique_email_matches m
WHERE a.id = m.apresentadora_id
  AND a.tenant_id = m.tenant_id
  AND a.user_id IS NULL
  AND m.matches_por_usuario = 1
  AND m.matches_por_apresentadora = 1;

INSERT INTO apresentadoras (
  tenant_id, user_id, nome, email, fixo, comissao_pct, meta_diaria_gmv, ativo
)
SELECT
  u.tenant_id,
  u.id,
  COALESCE(NULLIF(TRIM(u.nome), ''), 'Apresentadora'),
  u.email,
  2700,
  0,
  0,
  true
FROM users u
WHERE u.ativo IS NOT FALSE
  AND u.papel IN ('apresentador', 'apresentadora')
  AND NOT EXISTS (
    SELECT 1
    FROM apresentadoras a
    WHERE a.tenant_id = u.tenant_id
      AND a.user_id = u.id
  );

WITH presenters AS (
  SELECT tenant_id, id AS apresentadora_id
  FROM apresentadoras
  WHERE user_id IS NOT NULL
)
INSERT INTO apresentadora_comissao_faixas (
  tenant_id, apresentadora_id, gmv_inicio, gmv_fim, comissao_pct, ativo
)
SELECT
  p.tenant_id,
  p.apresentadora_id,
  tier.gmv_inicio,
  tier.gmv_fim,
  tier.comissao_pct,
  true
FROM presenters p
CROSS JOIN (
  VALUES
    (0::numeric, 50000::numeric, 0.5::numeric),
    (50000.01::numeric, 150000::numeric, 1::numeric),
    (150000.01::numeric, 500000::numeric, 1.5::numeric),
    (500000.01::numeric, NULL::numeric, 2::numeric)
) AS tier(gmv_inicio, gmv_fim, comissao_pct)
WHERE NOT EXISTS (
  SELECT 1
  FROM apresentadora_comissao_faixas f
  WHERE f.tenant_id = p.tenant_id
    AND f.apresentadora_id = p.apresentadora_id
    AND f.ativo = true
);
