# Auditoria LiveLab Franqueado - Sessao 1

Este documento e um roteiro seguro de auditoria para dados duplicados, vinculos quebrados e codigo morto. Ele nao executa limpeza automatica. O unico merge permitido nesta fase e o endpoint restrito `POST /v1/clientes/merge-restrito`, que exige mesmo tenant e match forte por CNPJ ou e-mail.

## Dados duplicados

Clientes duplicados por tenant e nome normalizado:

```sql
SELECT tenant_id,
       lower(regexp_replace(unaccent(nome), '\s+', ' ', 'g')) AS nome_normalizado,
       COUNT(*) AS total,
       json_agg(json_build_object('id', id, 'nome', nome, 'email', email, 'cnpj', cnpj, 'deleted_at', deleted_at)) AS clientes
FROM clientes
WHERE deleted_at IS NULL
GROUP BY tenant_id, lower(regexp_replace(unaccent(nome), '\s+', ' ', 'g'))
HAVING COUNT(*) > 1
ORDER BY total DESC;
```

Clientes duplicados por e-mail:

```sql
SELECT tenant_id, lower(trim(email)) AS email_normalizado, COUNT(*) AS total, array_agg(id) AS ids
FROM clientes
WHERE deleted_at IS NULL AND nullif(trim(email), '') IS NOT NULL
GROUP BY tenant_id, lower(trim(email))
HAVING COUNT(*) > 1;
```

Clientes duplicados por CNPJ:

```sql
SELECT tenant_id, regexp_replace(cnpj, '\D', '', 'g') AS cnpj_normalizado, COUNT(*) AS total, array_agg(id) AS ids
FROM clientes
WHERE deleted_at IS NULL AND nullif(regexp_replace(cnpj, '\D', '', 'g'), '') IS NOT NULL
GROUP BY tenant_id, regexp_replace(cnpj, '\D', '', 'g')
HAVING COUNT(*) > 1;
```

Marcas duplicadas ou orfas:

```sql
SELECT m.tenant_id, lower(trim(m.nome)) AS marca_normalizada, COUNT(*) AS total, array_agg(m.id) AS ids
FROM marcas m
WHERE m.status <> 'inativa'
GROUP BY m.tenant_id, lower(trim(m.nome))
HAVING COUNT(*) > 1;

SELECT m.*
FROM marcas m
LEFT JOIN clientes c ON c.id = m.cliente_id AND c.tenant_id = m.tenant_id
WHERE m.cliente_id IS NOT NULL
  AND c.id IS NULL;
```

## Vinculos operacionais

Lives sem venda atribuida:

```sql
SELECT l.id, l.tenant_id, l.marca_id, l.cliente_id, l.fat_gerado, l.encerrado_em
FROM lives l
LEFT JOIN vendas_atribuidas va
  ON va.tenant_id = l.tenant_id
 AND va.origem = 'live'
 AND va.origem_id = l.id
WHERE l.status = 'encerrada'
  AND va.id IS NULL;
```

Videos sem venda atribuida:

```sql
SELECT vr.id, vr.tenant_id, vr.marca_id, vr.gmv_atribuido, vr.data
FROM video_registros vr
LEFT JOIN vendas_atribuidas va
  ON va.tenant_id = vr.tenant_id
 AND va.origem = 'video'
 AND va.origem_id = vr.id
WHERE COALESCE(vr.gmv_atribuido, 0) > 0
  AND va.id IS NULL;
```

Vendas atribuidas sem marca valida:

```sql
SELECT va.*
FROM vendas_atribuidas va
LEFT JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
WHERE m.id IS NULL;
```

Clientes ativos que nao aparecem em Comercial:

```sql
SELECT c.*
FROM clientes c
WHERE c.deleted_at IS NULL
  AND c.status IN ('ativo', 'inadimplente', 'cancelado')
  AND c.tenant_id = '<TENANT_ID>'::uuid
ORDER BY c.criado_em DESC;
```

## Codigo morto e duplicatas

Comandos recomendados antes de remover qualquer arquivo:

```sh
rg "LiveManualPage|AnalyticsPage|CabinesPage|ApresentadorasPage" react-app/src
rg "get[A-Za-z]+\\(" react-app/src/services/domain.ts
rg "app\\.(get|post|patch|delete)" src/routes
rg --files react-app/src/pages react-app/src/components src/routes | sort
```

Critério para remocao nesta fase:

- sem rota ativa;
- sem import ativo;
- sem referencia em testes;
- substituto funcional ja ativo.

Qualquer caso ambiguo deve ficar apenas neste relatório para revisão manual.
