-- Diagnostico seguro da unidade Blumenau.
-- Rode primeiro para descobrir o tenant_id real antes de qualquer limpeza.

-- 1. Identificar tenant Blumenau.
SELECT id, nome, slug, status
FROM tenants
WHERE nome ILIKE '%blumenau%' OR slug ILIKE '%blumenau%'
ORDER BY nome;

-- 2. Cabines por tenant para detectar contaminacao/globalizacao.
SELECT tenant_id,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE ativo IS NOT FALSE) AS ativas
FROM cabines
GROUP BY tenant_id
ORDER BY total DESC;

-- 3. Substitua o placeholder abaixo pelo tenant_id da consulta 1.
-- Cabines Blumenau.
SELECT id, numero, nome, status, ativo, live_atual_id, criado_em
FROM cabines
WHERE tenant_id = '<TENANT_BLUMENAU>'::uuid
ORDER BY numero;

-- 4. Historico de lives por cabine.
SELECT cabine_id, COUNT(*) AS total_lives
FROM lives
WHERE tenant_id = '<TENANT_BLUMENAU>'::uuid
GROUP BY cabine_id
ORDER BY total_lives DESC;

-- 5. Eventos de agenda por cabine.
SELECT cabine_id, COUNT(*) AS total_eventos
FROM agenda_eventos
WHERE tenant_id = '<TENANT_BLUMENAU>'::uuid
GROUP BY cabine_id
ORDER BY total_eventos DESC;
