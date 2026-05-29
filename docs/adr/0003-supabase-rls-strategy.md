# ADR 0003 — Multi-tenancy via Supabase Postgres RLS + filtro explícito

**Status**: Aceito (com débito conhecido)
**Data**: 2026-05-08
**Decisor**: Tech lead

## Contexto

LiveShop SaaS é multi-tenant: cada franqueador tem seu próprio `tenant_id` (UUID). 17 tabelas têm coluna `tenant_id`:

```
cabines, lives, live_snapshots, live_apresentadores, live_requests,
clientes, contratos, custos, boletos, apresentadoras, leads,
recomendacoes, tenant_contact_history, cliente_metas,
cliente_metricas_mensais, pacotes, audit_log
```

JWT do user contém `tenant_id`; backend deve garantir que cada request veja **apenas** dados do tenant do user logado.

## Decisão

**Defesa em camadas**: RLS Postgres + filtro `WHERE tenant_id` explícito em cada query.

### Camada 1 — RLS policies

Cada tabela multi-tenant tem RLS habilitada com policy:

```sql
CREATE POLICY tabela_tenant ON tabela
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

`WITH CHECK` garantido em todas via migration `060_rls_with_check.sql` (idempotente).

### Camada 2 — `withTenant` no Fastify

Plugin `src/plugins/db.js` decora `app.withTenant(tenantId, fn)`:

```js
app.decorate('withTenant', async (tenantId, fn) => {
  const client = await pool.connect()
  await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId])
  try { return await fn({ query: ... }) }
  finally { client.release() }
})
```

Toda rota autenticada multi-tenant usa `app.withTenant(request.user.tenant_id, ...)`.

### Camada 3 — `WHERE tenant_id` explícito em SQL

```sql
SELECT * FROM cabines WHERE tenant_id = $1::uuid
```

Não confiar apenas em RLS. Por quê: ver "Limitação crítica" abaixo.

## Alternativas consideradas

### Schema-per-tenant

Cada tenant tem schema próprio (`tenant_abc.cabines`).

**Prós**: isolamento físico forte, backup per-tenant trivial
**Contras**: 1000 tenants = 1000 schemas duplicados; migrations × N; queries cross-tenant (master) virou nightmare; conexões PG limit hit fast

Rejeitado.

### Database-per-tenant

Cada tenant tem DB Postgres próprio.

**Prós**: isolamento absoluto
**Contras**: custo Supabase 100×; sem queries cross-tenant; analítica multi-tenant impossível

Rejeitado.

### Foreign Data Wrappers / Citus / sharding

Overkill pra escala atual (~50 tenants estimados).

Rejeitado.

## Limitação crítica (débito técnico aceito)

⚠️ **Role `postgres` do Supabase tem `rolbypassrls = true`** por default. Isso significa:

- Backend conecta como `postgres` via `DATABASE_URL`
- `app.withTenant` seta `app.tenant_id` corretamente
- Mas **policies RLS são IGNORADAS** porque a role bypassa

Evidência reproduzida (2026-05-07):

```
$ psql "$DATABASE_URL"
SELECT set_config('app.tenant_id', 'f2ecb6fc-...', false);
SELECT id, tenant_id FROM cabines;
# Retorna 11 rows: 10 do tenant 00000000 + 1 do tenant f2ecb6fc
# Esperado: 1 row
```

**Por isso a Camada 3 (filtro explícito) é OBRIGATÓRIA**, não defesa em profundidade opcional.

### Mitigação atual

13/27 rotas hardenadas (commits `8fdf01e` + `0b2e37e` + `c4bbe53`):
- `analytics.js`, `home.js`, `clientes.js`, `boletos.js`, `apresentadoras.js`, `cabines.js`, `contratos.js`, `financeiro.js`, `recomendacoes.js`, `excelencia.js`, `pacotes.js`, `cliente_portal.js`, `solicitacoes.js`

Cada uma com `WHERE tabela.tenant_id = $1::uuid` ou `current_setting('app.tenant_id', true)::uuid` explícito.

### Fix definitivo pendente (P0 — manual user)

Criar role `liveshop_app NOBYPASSRLS LOGIN` no Supabase Dashboard + atualizar `DATABASE_URL` Railway. Quando feita:
- RLS policies passam a filtrar real
- Camada 3 vira defesa em profundidade (não obrigatória)
- Restantes ~14 rotas ficam protegidas só por RLS (suficiente)

## Consequências

### Positivas

- Isolamento por padrão em todas as queries via Camada 3
- Migrations únicas (uma tabela serve todos tenants)
- Analítica cross-tenant trivial (`/v1/master/dashboard` só joga `WHERE tenant_id` fora)
- Backup unificado Supabase

### Negativas (aceitas)

- **Boilerplate** em cada query SQL — `WHERE tenant_id = $1::uuid` repetido. Aceito porque previne RLS leak histórico.
- **Performance** — index `(tenant_id, ...)` em todas tabelas multi-tenant. Custo de storage marginal; queries planejam uso de index.
- **Erro humano** — dev novo pode esquecer `WHERE tenant_id`. Mitigação: `scripts/audit-rls.js` detecta queries sem WHERE; CI pode rodar audit em PRs.
- **`audit_log` cross-tenant** — tabela tem `tenant_id NULL` para ações system-wide (login, etc). RLS policy adapta com `OR tenant_id IS NULL`.

## Padrão estabelecido

Toda rota nova multi-tenant:

```js
app.get('/v1/recurso',
  { preHandler: [app.authenticate, app.requirePapel(['franqueado'])] },
  async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const r = await db.query(
        `SELECT col FROM tabela
         WHERE tenant_id = $1::uuid
           AND filtro = $2
         ORDER BY criado_em DESC`,
        [tenant_id, filtro]
      )
      return r.rows
    })
  }
)
```

## Verificação

- `node scripts/audit-rls.js` — reporta tabelas sem RLS, queries sem WHERE explícito
- `psql "$DATABASE_URL" -c "SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname=current_user"` — checar BYPASSRLS atual
- Migration `060_rls_with_check.sql` — confirma todas policies têm WITH CHECK

## Revisão

Re-avaliar:
- Após P0.1+P0.2 (role NOBYPASSRLS criada): re-confirmar que Camada 3 ainda é necessária ou pode ser relaxada como pure defense-in-depth
- Se escala chegar >500 tenants: avaliar Citus ou sharding
- Se vazamento real for detectado: rotação de senha + audit completo

## Referências

- `migrations/006_create_cabines.sql` — primeira RLS policy
- `migrations/060_rls_with_check.sql` — WITH CHECK em todas
- `scripts/audit-rls.js` — drift detection
- `src/plugins/db.js` — `withTenant` decorator
- `~/security-report.md` — CRITICAL FINDING seção (RLS leak documentado)
- INCIDENT_PLAYBOOK.md — seção 5 RLS leak procedures
