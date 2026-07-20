# Feature: Briefing do Cliente

> Status: **especificado, não implementado** ("adicionar depois"). Cross-repo (back + front).
> Escopo: Medium. Design inline abaixo — pronto pra executar sem re-explorar.

## Objetivo

Cada cliente tem **1 área de Briefing**: um documento único de texto rico (Markdown),
preenchido e lido pelo **time interno** na tela Comercial. O cliente final
(`cliente_parceiro`) **não** vê no portal dele.

## Decisões do usuário (congeladas)

| # | Decisão |
|---|---------|
| D1 | Rich text = **textarea + Markdown + preview**. Sem editor WYSIWYG. Zero dep no armazenamento. |
| D2 | **Só time interno** escreve e lê (tela Comercial). Portal do cliente não recebe nada. |

## Requisitos

- **R1** — Documento **único por cliente** (1:1, sobrescreve). Sem timeline, sem versão.
- **R2** — Conteúdo guardado como **Markdown puro** (texto). Seguro em repouso.
- **R3** — Ver + editar dentro do **modal do cliente** em `ComercialPage` (aba "ativos").
- **R4** — RBAC: leitura = `READ_CLIENTES`; escrita = `WRITE_CLIENTES` (= `ADMIN_COMERCIAL`).
  **Reusar constantes existentes** — nenhuma constante nova.
- **R5** — Mostrar **quem atualizou e quando** ("atualizado por X em DD/MM HH:mm").
- **R6** — Preview/render do Markdown **sanitizado (anti-XSS)** no front. Nunca rolar sanitizer à mão.

## Design inline (para execução posterior)

Molde: `cliente_notas` (migration 064 + `src/routes/cliente_notas.js`) — mesmo padrão de tenant,
RLS e RBAC, adaptado de "N notas" para "1 briefing".

### Backend — `~/dev/Livelab-back`

**1. Migration `124_cliente_briefing.sql`** (próximo número; convenção `NNN_snake_case.sql`)
```sql
CREATE TABLE IF NOT EXISTS cliente_briefing (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cliente_id         UUID NOT NULL UNIQUE REFERENCES clientes(id) ON DELETE CASCADE, -- UNIQUE = 1:1
  conteudo           TEXT NOT NULL DEFAULT '',
  atualizado_por_id  UUID REFERENCES users(id),
  atualizado_por_nome TEXT,
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cliente_briefing_tenant ON cliente_briefing(tenant_id);
ALTER TABLE cliente_briefing ENABLE ROW LEVEL SECURITY;
-- 4 policies (SELECT/INSERT/UPDATE/DELETE), espelhando migration 064 :50-62:
--   USING / WITH CHECK: tenant_id = current_setting('app.tenant_id', true)::uuid
```
> **Não esquecer**: `apply_migrations.js` NÃO faz dir-scan — anexar `'124_cliente_briefing.sql'`
> ao array `MIGRATIONS_LIST` (hoje termina em `'123_leads_crm_summary_index.sql'`, ~linha 120).
> Tabela separada (não coluna em `clientes`) **de propósito**: a listagem de `clientes` é rota
> quente do plano de perf — não arrastar o blob de Markdown pro SELECT da lista.

**2. Rota `src/routes/cliente_briefing.js`** (copiar estrutura de `cliente_notas.js`)
- `GET /v1/clientes/:clienteId/briefing` — `onRequest: [app.authenticate, app.requirePapel(READ_CLIENTES)]`.
  Retorna a linha do briefing **ou `null`** se não existe ainda.
- `PUT /v1/clientes/:clienteId/briefing` — `onRequest: [app.authenticate, app.requirePapel(WRITE_CLIENTES)]`.
  **Upsert**: `INSERT ... ON CONFLICT (cliente_id) DO UPDATE SET conteudo=..., atualizado_por_id=..., atualizado_por_nome=..., atualizado_em=NOW()`.
  Validar que o cliente pertence ao tenant antes (espelhar `cliente_notas.js:57-63`).
  `atualizado_por_*` vêm de `req.user.sub` / `req.user.nome`.
  Zod: `z.object({ conteudo: z.string().max(20000) })` (permite string vazia p/ limpar).
  Audit: `app.audit?.log?.(req, { action: 'cliente_briefing.save', ... })`.
- Envolver DB em `app.withTenant(tenant_id, async (db) => …)`; passar `tenant_id` explícito nas queries (defense-in-depth), como em notas.

**3. Registro `src/app.js`** — 2 linhas espelhando `cliente_notas`:
- import: `import { clienteBriefingRoutes } from './routes/cliente_briefing.js'`
- boot: `await app.register(clienteBriefingRoutes)` (após `clientesRoutes`, ~linha 246).

**4. Testes `test/cliente_briefing.test.js`** (padrão `app.inject`, mock de `withTenant`/`authenticate`):
- GET sem briefing → `null`.
- PUT cria; PUT de novo → **atualiza, não duplica** (upsert; `cliente_id` UNIQUE).
- RBAC: papel fora de `WRITE_CLIENTES` → 403 no PUT; fora de `READ_CLIENTES` → 403 no GET.
- Isolamento: tenant A não lê briefing de tenant B.

### Frontend — `~/dev/Livelab-Front/react-app`

**5. `src/services/domain.ts`** (espelhar `getClienteOperacional`/`updateCliente`):
```ts
export const getClienteBriefing = (id: string) => apiGet<Briefing | null>(`/clientes/${id}/briefing`)
export const saveClienteBriefing = (id: string, conteudo: string) =>
  apiPut(`/clientes/${id}/briefing`, { conteudo })
```
**6. `src/services/query-keys.ts`**: `clienteBriefing: (id: string) => ['cliente-briefing', id] as const,`

**7. Componente `src/components/comercial/BriefingSection.tsx`** — renderizado como novo
`<section>` no modal do cliente em `ComercialPage.tsx` (~linha 813, após o form de edição;
só quando `kind === 'cliente'`):
- `useQuery({ queryKey: QK.clienteBriefing(id), queryFn: () => getClienteBriefing(id), enabled: modalOpen && kind==='cliente' })`.
- `<textarea className="design-input">` (Markdown) + toggle **Editar / Preview**.
- `useMutation({ mutationFn: (c) => saveClienteBriefing(id, c), onSuccess: () => { invalidateQueries(QK.clienteBriefing(id)); toast "Salvo ✓" } })` — padrão de `CadastroQuickEdit.tsx`.
- Rodapé: "atualizado por {atualizado_por_nome} em {atualizado_em}".
- **Preview seguro (R6)**: `marked` + `dompurify` (2 deps minúsculas). `DOMPurify.sanitize(marked.parse(md))`.
  Fallback ainda mais lazy: entregar só o textarea sem preview visual na v1 (armazenamento
  já é Markdown puro; preview vira incremento). **Não** rolar sanitizer próprio.

## Fora de escopo (registrado)

- Portal do cliente **não** recebe briefing (D2).
- Sem versionamento/histórico — 1 doc, sobrescreve. Adicionar depois se pedirem.
- Sem upload de anexo/imagem.
- Sem editor WYSIWYG (D1).

## Done when

- [ ] Migration aplica idempotente (`node apply_migrations.js` 2x = sem erro).
- [ ] GET retorna briefing ou `null`; PUT cria e atualiza (mesma chamada 2x = upsert, sem duplicar).
- [ ] RBAC nega papel errado (403) em GET e PUT.
- [ ] Isolamento de tenant verificado.
- [ ] Modal do cliente mostra, edita, salva e persiste ao reabrir; badge "atualizado por/em".
- [ ] `npx vitest run` verde no back; `flutter`/vite build ok no front.

## Estimativa

~6 tarefas (migration, rota+zod, wire app.js, testes back, domain+QK, componente). ~½ dia.
