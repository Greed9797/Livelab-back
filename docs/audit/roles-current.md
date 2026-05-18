# Roles Atuais vs Oficiais

> Auditoria gerada em: 2026-05-18
> Branch: `stabilization/core-restructure`
> Fontes: `src/config/role_groups.js`, `src/routes/usuarios.js`, `src/routes/*.js`, `src/plugins/auth.js`

---

## Roles no código atual

### Roles definidas no schema Zod (convidarSchema — `src/routes/usuarios.js` linha 23–28)
Estes são os papéis que podem ser **criados via convite** (pela UI/API):
1. `gerente`
2. `gerente_comercial`
3. `financeiro`
4. `operacional`
5. `apresentador`
6. `apresentadora`
7. `cliente_parceiro`

### Roles protegidas (criadas apenas via fluxos específicos)
- `franqueado` — criado em `POST /v1/tenants` (apenas `franqueador_master`)
- `franqueador_master` — nunca atribuível via API (provisionamento manual de infra)

### Roles adicionais definidas em `src/config/role_groups.js`
Presentes nos grupos de acesso, mas **não listadas no Zod de convite**:
- `gerente_regional` — referenciado em `src/plugins/auth.js` (requireTenantAccess, linha 120)
- `financeiro_readonly` — aparece em READ_FINANCEIRO, READ_BOLETOS etc.
- `auditor` — aparece em READ_* de múltiplos domínios
- `suporte` — aparece em READ_BOLETOS, READ_CLIENTES etc.
- `produtor_live` — aparece em WRITE_CABINES, WRITE_LIVES, WRITE_SOLICITACOES
- `marketing` — aparece em READ_CLIENTES, READ_LEADS, READ_LIVES etc.
- `comercial_readonly` — aparece em READ_CLIENTES, READ_CONTRATOS etc.

### Roles no frontend (`src/utils/access.ts` — tipos e grupos)
Definidas no type `Role` em `src/types/models.ts`:
- `franqueador_master`, `admin_master`, `gerente_regional`
- `franqueado`, `gerente`, `gerente_comercial`
- `financeiro`, `financeiro_readonly`
- `operacional`, `auditor`, `suporte`
- `produtor_live`, `marketing`, `comercial_readonly`
- `apresentador`, `apresentadora`, `cliente_parceiro`
- `string` (fallback genérico)

**Roles extras no frontend ausentes no backend Zod**: `admin_master` (aparece em `access.ts:masterRoles` e `AppRouter.tsx:87` mas não no backend)

---

## Roles oficiais do plano (5)

| Role Oficial | Descrição |
|---|---|
| `franqueador_master` | Nível raiz — visão global de toda a rede |
| `franqueado` | Dono da unidade franqueada |
| `operacional` | Equipe operacional da unidade |
| `apresentador` | Apresentador/closer da live |
| `cliente_parceiro` | Cliente com acesso ao portal próprio |

---

## Inventário completo das roles atuais vs as 5 oficiais

| Role atual | Status vs plano | Onde aparece no código |
|---|---|---|
| `franqueador_master` | **Oficial** | auth.js, tenants.js, role_groups.js, usuarios.js, access.ts |
| `franqueado` | **Oficial** | role_groups.js, usuarios.js, clientes.js, access.ts |
| `operacional` | **Oficial** | role_groups.js (READ/WRITE_APRESENTADORAS, WRITE_AGENDA), access.ts |
| `apresentador` | **Oficial** (mas ver nota) | role_groups.js (READ_CABINES, READ_LIVES, WRITE_LIVES), usuarios.js |
| `apresentadora` | **Duplicata de apresentador** | role_groups.js, usuarios.js — mesmo grupo de permissões que `apresentador` |
| `cliente_parceiro` | **Oficial** | role_groups.js, usuarios.js, clientes.js, AppRouter.tsx, access.ts |
| `gerente` | **A descontinuar** (não é oficial) | ADMIN base group, role_groups.js, home.js, clientes.js, live_apresentadores.js |
| `gerente_comercial` | **A descontinuar** | ADMIN_COMERCIAL group, role_groups.js, usuarios.js |
| `financeiro` | **A descontinuar** | role_groups.js READ/WRITE_FINANCEIRO, usuarios.js |
| `financeiro_readonly` | **A descontinuar** | role_groups.js READ_FINANCEIRO, READ_BOLETOS, READ_CONTRATOS |
| `auditor` | **A descontinuar** | role_groups.js múltiplos READ_* |
| `suporte` | **A descontinuar** | role_groups.js READ_BOLETOS, READ_CLIENTES, READ_LEADS |
| `produtor_live` | **A descontinuar** | role_groups.js WRITE_CABINES, WRITE_LIVES, WRITE_SOLICITACOES |
| `marketing` | **A descontinuar** | role_groups.js READ_LEADS, READ_CLIENTES, READ_LIVES |
| `comercial_readonly` | **A descontinuar** | role_groups.js múltiplos READ_* |
| `gerente_regional` | **A descontinuar** | auth.js requireTenantAccess, access.ts masterRoles, models.ts |
| `admin_master` | **Apenas no frontend** | access.ts, AppRouter.tsx — não existe no backend |

---

## Roles a descontinuar

### Grupo de gestão interna (mapeiam para `franqueado` ou `operacional`)
| Role | Onde aparece | Mapeamento sugerido |
|---|---|---|
| `gerente` | `src/routes/home.js:4`, `src/config/role_groups.js:14` (ADMIN base), `live_apresentadores.js:11,49,71`, `clientes.js:301` | → `franqueado` (tem mesmas permissões) |
| `gerente_comercial` | `role_groups.js:16` (ADMIN_COMERCIAL), `usuarios.js:23,39` | → `operacional` ou novo papel comercial |
| `gerente_regional` | `plugins/auth.js:120`, `access.ts:29`, `models.ts:3` | → `franqueador_master` com restrição de tenant |

### Papéis técnicos sem equivalente nas 5 roles
| Role | Onde aparece | Mapeamento sugerido |
|---|---|---|
| `financeiro` | `role_groups.js:19,21`, `usuarios.js:24` | → `operacional` (com permissão financeira) |
| `financeiro_readonly` | `role_groups.js:18,23,31` | → `operacional` somente-leitura |
| `auditor` | `role_groups.js:18,24,30,37,42,48` | → manter como role técnica OU `franqueador_master` |
| `suporte` | `role_groups.js:24,37,43,48,53,70` | → manter como role técnica |
| `produtor_live` | `role_groups.js:53,60,67,73,80,91,99,101` | → `operacional` |
| `marketing` | `role_groups.js:37,47,51,60,78,93` | → `operacional` somente-leitura |
| `comercial_readonly` | `role_groups.js:32,36,51,59,65,71,78` | → `operacional` somente-leitura |

### Duplicata funcional
| Role | Onde aparece | Mapeamento sugerido |
|---|---|---|
| `apresentadora` | `role_groups.js:50,60,64,66,87` (igual a `apresentador`), `usuarios.js:24,39`, `access.ts:79` | → consolidar com `apresentador` |
| `admin_master` | **Apenas frontend**: `access.ts:27`, `AppRouter.tsx:87`, `models.ts:2` | → remover ou mapear para `franqueador_master` |

---

## Mapeamento sugerido (antiga → nova)

| Role Atual | Role Oficial Destino | Observações |
|---|---|---|
| `gerente` | `franqueado` | Permissões idênticas no ADMIN group |
| `gerente_comercial` | `operacional` | Adicionar acesso a leads/clientes no operacional |
| `gerente_regional` | `franqueador_master` + `allowedTenantIds` | Já modelado em `auth.js` — manter lógica, unificar role |
| `financeiro` | `operacional` | Criar subconjunto de permissões financeiras |
| `financeiro_readonly` | `operacional` | Flag `readonly` no token ou grupos específicos |
| `auditor` | `franqueador_master` (restrito) | Acesso read-only global |
| `suporte` | `operacional` | Mesmas permissões de leitura |
| `produtor_live` | `operacional` | Permissões de escrita em cabines/lives |
| `marketing` | `operacional` | Somente leitura em dados de performance |
| `comercial_readonly` | `operacional` | Somente leitura em clientes/leads/contratos |
| `apresentadora` | `apresentador` | Consolidar — mesmos grupos de permissão |
| `admin_master` | `franqueador_master` | Remover do frontend — não existe no backend |

---

## Resumo de contagem

- **Roles oficiais**: 5 (plano)
- **Roles no backend atualmente**: 16 distintas (17 contando `admin_master` somente frontend)
- **A remover/consolidar**: 11 roles (excluindo as 5 oficiais + `apresentadora` como duplicata)
- **Arquivo principal de roles**: `/tmp/Livelab-back/src/config/role_groups.js`
