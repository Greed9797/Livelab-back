# Fase 1 — Marca obrigatória + status não apaga dinheiro — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar impossível uma live existir sem marca e fazer com que nenhum status (`marcas.status`) zere comissão silenciosamente — invertendo "resolve-ou-zera" para "exige-ou-erra".

**Architecture:** Backend Node/Fastify + Postgres. A comissão de franquia passa a ser sempre `gmv × marca.comissao_franquia_pct`, resolvida por um predicado único compartilhado (sem filtro de status). Os 3 caminhos de criação de live resolvem/criam a marca (via `ensureClienteMarca`) antes do INSERT e erram se não conseguirem. Migration torna `lives.marca_id NOT NULL`. Um script recalcula todo o histórico.

**Tech Stack:** Node ESM, Fastify, `pg`, Vitest (mocka `db.query`), migrations SQL aplicadas por `apply_migrations.js`.

## Global Constraints
- Comissão de franquia por live = `gmv × marca.comissao_franquia_pct / 100` (fonte: `comissao.js:calcularComissaoFranquia`). Nunca usar a coluna estagnada `lives.comissao_calculada` como fonte em telas de dinheiro.
- Predicado de resolução de marca (idêntico em todo lugar): `(m.id = l.marca_id OR (l.marca_id IS NULL AND m.cliente_id = l.cliente_id))`, marca mais antiga primeiro (`ORDER BY m.criado_em ASC LIMIT 1`). **SEM** filtro `m.status='ativa'`.
- `gmv` da live = `COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)` (`metric-sql.js:liveGmvSql`).
- Erro de criação sem marca: HTTP **422**, `code: 'MARCA_OBRIGATORIA'`.
- Toda a suíte (`npx vitest run`, hoje 397) deve continuar verde a cada commit.
- Comandos git via `rtk` (ex.: `rtk git push`). Commits terminam com a linha `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Branch: `codex/blumenau-operational-fase1` (deploy Railway no push). Migrations precisam entrar em `MIGRATIONS_LIST` em `apply_migrations.js` e ser idempotentes.

---

## File Structure
- Create: `src/lib/marca-sql.js` — predicado único + LATERAL de resolução de marca (resolvedor compartilhado).
- Modify: `src/services/commission-engine.js` — usa o predicado; remove `status='ativa'`; throw quando faltar marca; remove auto-heal.
- Modify: `src/routes/financeiro.js` — usa o LATERAL compartilhado (sem `status='ativa'`) em `/resumo` e `/faturamento`.
- Modify: `src/routes/lives.js` — marca obrigatória nos paths start e manual (resolve via `ensureClienteMarca`, erro 422).
- Modify: `src/jobs/agenda_autostart.js` — não cria live sem marca (skip + log).
- Create: `migrations/117_lives_marca_obrigatoria.sql` — backfill + `NOT NULL` + FK `ON DELETE RESTRICT`.
- Modify: `apply_migrations.js` — registra a migration 117.
- Create: `scripts/reprocessar_todas_comissoes.js` — recálculo histórico.
- Test: `test/financeiro_comissao_inline.test.js` (estende), `test/commission_engine.test.js` (estende), `test/marca_obrigatoria.test.js` (novo).

---

## Task 1: Resolvedor único de marca + remover gate `status='ativa'`

**Files:**
- Create: `src/lib/marca-sql.js`
- Modify: `src/routes/financeiro.js` (resumo LATERAL ~`:80-91`, faturamento LATERAL ~`:230-241`)
- Modify: `src/services/commission-engine.js:49-51`
- Test: `test/financeiro_comissao_inline.test.js`, `test/commission_engine.test.js`

**Interfaces:**
- Produces: `MARCA_RESOLVE_PREDICATE` (string), `marcaResolveLateralSql(tenantParam='$3')` (string) em `src/lib/marca-sql.js`.

- [ ] **Step 1: Escrever o teste falho (financeiro sem `status='ativa'`)**

Em `test/financeiro_comissao_inline.test.js`, adicionar ao `describe` existente:

```js
  it('resumo e faturamento NÃO filtram marca por status (status não apaga dinheiro)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{}] })
    const { app } = buildApp({ queryMock: query })
    await app.register(financeiroRoutes)

    for (const url of ['/v1/financeiro/resumo?inicio=2026-06&fim=2026-06',
                       '/v1/financeiro/faturamento?inicio=2026-06&fim=2026-06']) {
      await app.inject({ method: 'GET', url })
    }
    for (const [sql] of query.mock.calls) {
      expect(String(sql)).not.toContain("m.status = 'ativa'")
    }
    await app.close()
  })
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run test/financeiro_comissao_inline.test.js`
Expected: FAIL — o SQL inline atual ainda tem `m.status = 'ativa'` no LATERAL.

> NOTA: confirme que o LATERAL que você adicionou hoje em `financeiro.js` (resumo e faturamento) contém `AND m.status = 'ativa'`. Se já não contiver, ajuste o teste para refletir a string exata e siga.

- [ ] **Step 3: Criar o resolvedor compartilhado**

Criar `src/lib/marca-sql.js`:

```js
// Resolução canônica da marca de uma live (mesma regra do commission-engine),
// compartilhada por financeiro (resumo + faturamento) para não haver drift.
// IMPORTANTE: SEM filtro de status — status nunca apaga dinheiro.
export const MARCA_RESOLVE_PREDICATE =
  '(m.id = l.marca_id OR (l.marca_id IS NULL AND m.cliente_id = l.cliente_id))'

export function marcaResolveLateralSql(tenantParam = '$3') {
  return `LEFT JOIN LATERAL (
            SELECT m.id, m.comissao_franquia_pct
            FROM marcas m
            WHERE m.tenant_id = ${tenantParam}::uuid
              AND ${MARCA_RESOLVE_PREDICATE}
            ORDER BY m.criado_em ASC
            LIMIT 1
          ) mc ON true`
}
```

- [ ] **Step 4: Usar o resolvedor em `financeiro.js`**

No topo: `import { marcaResolveLateralSql, MARCA_RESOLVE_PREDICATE } from '../lib/marca-sql.js'`.
No `/resumo`, substituir o bloco `LEFT JOIN LATERAL (...) mc ON true` (o que você adicionou hoje, com `m.status='ativa'`) por `${marcaResolveLateralSql('$3')}`.
No `/faturamento`, idem (substituir o LATERAL hand-written por `${marcaResolveLateralSql('$3')}`).
Resultado: nenhum dos dois LATERAL contém `m.status='ativa'`.

- [ ] **Step 5: Remover o gate no `commission-engine.js`**

Em `src/services/commission-engine.js:49-51`, trocar:

```js
     LEFT JOIN marcas m     ON m.tenant_id = $1::uuid
                            AND m.status = 'ativa'
                            AND (m.id = l.marca_id OR (l.marca_id IS NULL AND m.cliente_id = l.cliente_id))
```

por (importando o predicado no topo: `import { MARCA_RESOLVE_PREDICATE } from '../lib/marca-sql.js'`):

```js
     LEFT JOIN marcas m     ON m.tenant_id = $1::uuid
                            AND ${MARCA_RESOLVE_PREDICATE}
```

> Mantém o join de `contratos c ... AND c.status='ativo'` (linha 48) — o gate de contrato é loud e fora de escopo.

- [ ] **Step 6: Teste falho no engine (marca inativa resolve)**

Em `test/commission_engine.test.js`, adicionar um caso que afirma que a query do engine não filtra `m.status = 'ativa'`:

```js
  it('resolve marca independentemente do status (status não zera comissão)', async () => {
    const calls = []
    const db = { query: async (sql, params) => { calls.push(String(sql)); 
      if (String(sql).includes('FROM lives l')) return { rows: [{ id: 'L', marca_id: 'M', comissao_franquia_pct: 10 }] }
      return { rows: [] } } }
    await calcularComissoesDaLive(db, { liveId: 'L', tenantId: 'T', gmv: 1000, pedidos: 1 }).catch(() => {})
    const joinSql = calls.find(s => s.includes('LEFT JOIN marcas m'))
    expect(joinSql).toBeTruthy()
    expect(joinSql).not.toContain("m.status = 'ativa'")
  })
```

> Ajuste o import/uso de `calcularComissoesDaLive` ao topo do arquivo conforme já feito nos outros testes do arquivo.

- [ ] **Step 7: Rodar tudo verde**

Run: `npx vitest run test/financeiro_comissao_inline.test.js test/commission_engine.test.js`
Expected: PASS. Depois `npx vitest run` → 397+ verde.

- [ ] **Step 8: Commit**

```bash
rtk git add src/lib/marca-sql.js src/routes/financeiro.js src/services/commission-engine.js test/financeiro_comissao_inline.test.js test/commission_engine.test.js
git commit -m "fix(comissao): status nao apaga dinheiro — resolvedor de marca unico, sem gate status=ativa

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Marca obrigatória — start live (POST /v1/lives)

**Files:**
- Modify: `src/routes/lives.js` (entre o fallback marca-sistema `:582-596` e o INSERT `:621`)
- Test: `test/marca_obrigatoria.test.js` (novo)

**Interfaces:**
- Consumes: `ensureClienteMarca(db, { tenantId, clienteId })` → `Promise<string|null>` (id da marca ou null) de `src/services/client-brand.js`.

- [ ] **Step 1: Teste falho — start sem marca resolvível → 422**

Criar `test/marca_obrigatoria.test.js`. Modelar o harness pelo `test/lives_start.test.js` existente (mesma forma de mockar `withTenant`/`db.query` e auth). O caso:

```js
// Pseudoestrutura — siga o harness real de test/lives_start.test.js para os mocks de cabine/contrato.
it('POST /v1/lives (cliente) sem marca resolvível responde 422 MARCA_OBRIGATORIA', async () => {
  // db.query mockado: cabine/contrato OK, cliente OK (não inadimplente),
  // e TODAS as buscas de marca (inclusive as de ensureClienteMarca) retornam rows: []
  const res = await app.inject({ method: 'POST', url: '/v1/lives', payload: { cabine_id, cliente_id, tipo: 'cliente' } })
  expect(res.statusCode).toBe(422)
  expect(res.json().code).toBe('MARCA_OBRIGATORIA')
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run test/marca_obrigatoria.test.js`
Expected: FAIL — hoje a live é criada com `marca_id NULL` e responde 200/201.

- [ ] **Step 3: Implementar a exigência**

Em `src/routes/lives.js`, importar no topo: `import { ensureClienteMarca } from '../services/client-brand.js'`.
Logo após o bloco "fim fallback marca sistema" (depois da linha 596) e antes do INSERT (621), inserir:

```js
        // ── Marca obrigatória: toda live tem marca (exige-ou-erra) ──
        if (!resolvedMarcaId && resolvedTipo === 'cliente' && resolvedClienteId) {
          resolvedMarcaId = await ensureClienteMarca(db, { tenantId: tenant_id, clienteId: resolvedClienteId })
        }
        if (!resolvedMarcaId) {
          await db.query('ROLLBACK')
          return reply.code(422).send({
            error: 'Live sem marca: cadastre/vincule a marca do cliente antes de iniciar a live',
            code: 'MARCA_OBRIGATORIA',
          })
        }
        // ── fim marca obrigatória ──
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run test/marca_obrigatoria.test.js`
Expected: PASS. Depois `npx vitest run` → suíte verde (verifique que `test/lives_start.test.js` continua passando — se algum caso criava live de cliente sem marca esperando sucesso, ajuste o fixture para incluir a marca).

- [ ] **Step 5: Commit**

```bash
rtk git add src/routes/lives.js test/marca_obrigatoria.test.js
git commit -m "feat(lives): marca obrigatoria no start (resolve via ensureClienteMarca; 422 se nao resolver)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Marca obrigatória — manual (POST /v1/lives/manual)

**Files:**
- Modify: `src/routes/lives.js` (após o fallback marca-sistema `:800-814` e o check cliente `:816-822`, antes do INSERT `:884`)
- Test: `test/marca_obrigatoria.test.js`

- [ ] **Step 1: Teste falho — manual sem marca → 422**

Adicionar em `test/marca_obrigatoria.test.js`:

```js
it('POST /v1/lives/manual (cliente) sem marca resolvível responde 422 MARCA_OBRIGATORIA', async () => {
  // db.query: cliente presente; buscas de marca (e as de ensureClienteMarca) retornam rows: []
  const res = await app.inject({ method: 'POST', url: '/v1/lives/manual',
    payload: { cabine_id, cliente_id, tipo: 'cliente', data: '2026-06-10', hora_inicio: '10:00', hora_fim: '11:00', fat_gerado: 1000, qtd_pedidos: 1 } })
  expect(res.statusCode).toBe(422)
  expect(res.json().code).toBe('MARCA_OBRIGATORIA')
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run test/marca_obrigatoria.test.js`
Expected: FAIL (manual cria com `marca_id NULL`).

- [ ] **Step 3: Implementar**

Em `src/routes/lives.js`, no handler `/v1/lives/manual`, logo após o bloco do check `CLIENTE_REQUIRED` (linha 822) e antes do bloco de inadimplência (824), inserir:

```js
        // ── Marca obrigatória (exige-ou-erra) ──
        if (!resolvedMarcaId && d.tipo === 'cliente' && resolvedClienteId) {
          resolvedMarcaId = await ensureClienteMarca(db, { tenantId: tenant_id, clienteId: resolvedClienteId })
        }
        if (!resolvedMarcaId) {
          await db.query('ROLLBACK')
          return reply.code(422).send({
            error: 'Live sem marca: cadastre/vincule a marca do cliente antes de registrar a live',
            code: 'MARCA_OBRIGATORIA',
          })
        }
        // ── fim marca obrigatória ──
```

(`ensureClienteMarca` já importado na Task 2.)

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run test/marca_obrigatoria.test.js && npx vitest run`
Expected: PASS + suíte verde (ajustar fixtures de `test/lives_manual.test.js` que criavam cliente sem marca, se houver).

- [ ] **Step 5: Commit**

```bash
rtk git add src/routes/lives.js test/marca_obrigatoria.test.js
git commit -m "feat(lives): marca obrigatoria no manual (422 se nao resolver)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Marca obrigatória — agenda autostart

**Files:**
- Modify: `src/jobs/agenda_autostart.js` (antes do INSERT `:148`)
- Test: `test/agenda_autostart.test.js` (estende)

- [ ] **Step 1: Teste falho — evento 'live' sem marca não cria live**

Em `test/agenda_autostart.test.js`, adicionar caso onde `locked.marca_id` é null: esperar que NÃO haja `INSERT INTO lives` e que o resultado seja `{ skipped: true }` (siga o shape de retorno usado nos casos existentes do arquivo).

```js
it('não cria live quando o evento não tem marca (skip + log)', async () => {
  // monte o mock com o evento travado SEM marca_id; capture os SQLs
  // expect: nenhuma chamada com 'INSERT INTO lives', resultado skipped
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run test/agenda_autostart.test.js`
Expected: FAIL (hoje insere live com `marca_id NULL`).

- [ ] **Step 3: Implementar**

Em `src/jobs/agenda_autostart.js`, após resolver `clienteId` (linha ~137) e antes do `INSERT INTO lives` (linha 148), inserir:

```js
    if (!locked.marca_id) {
      await client.query('ROLLBACK')
      app.log?.warn?.({ agenda_evento_id: ev.id, cabine_id: cab.id },
        '[agenda autostart] evento de live sem marca — live NÃO criada (marca obrigatória)')
      return { skipped: true, reason: 'sem_marca' }
    }
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run test/agenda_autostart.test.js && npx vitest run`
Expected: PASS + verde.

- [ ] **Step 5: Commit**

```bash
rtk git add src/jobs/agenda_autostart.js test/agenda_autostart.test.js
git commit -m "feat(agenda): autostart nao cria live sem marca (skip+log)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Migration — backfill + `marca_id NOT NULL` + FK RESTRICT

**Files:**
- Create: `migrations/117_lives_marca_obrigatoria.sql`
- Modify: `apply_migrations.js` (array `MIGRATIONS_LIST`)
- Test: `test/migrations_runner.test.js` (verifica que 117 está registrada)

- [ ] **Step 1: Escrever a migration (idempotente, com pré-check)**

Criar `migrations/117_lives_marca_obrigatoria.sql`:

```sql
-- 117: lives.marca_id obrigatório (exige-ou-erra). Idempotente.
-- 1) Backfill: resolve marca-espelho do cliente para lives sem marca.
UPDATE lives l
   SET marca_id = m.id
  FROM marcas m
 WHERE l.marca_id IS NULL
   AND m.tenant_id = l.tenant_id
   AND m.cliente_id = l.cliente_id
   AND m.tipo = 'cliente';

-- 2) Backfill afiliado/teste sem marca → marca-sistema do tenant.
UPDATE lives l
   SET marca_id = ms.id
  FROM marcas ms
 WHERE l.marca_id IS NULL
   AND l.tipo IN ('afiliado','teste')
   AND ms.tenant_id = l.tenant_id
   AND ms.sistema = TRUE;

-- 3) Pré-check: se ainda houver live sem marca, ABORTA e lista (decisão manual).
DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM lives WHERE marca_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'Migration 117 abortada: % live(s) sem marca resolvível. Rode: SELECT id, tenant_id, cliente_id, tipo, status FROM lives WHERE marca_id IS NULL; e corrija manualmente antes de reaplicar.', n;
  END IF;
END $$;

-- 4) Constraint + FK RESTRICT (só aplica se ainda não estiver no estado alvo).
ALTER TABLE lives ALTER COLUMN marca_id SET NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.referential_constraints rc
    JOIN information_schema.key_column_usage k ON k.constraint_name = rc.constraint_name
    WHERE k.table_name='lives' AND k.column_name='marca_id' AND rc.delete_rule='SET NULL'
  ) THEN
    EXECUTE (SELECT 'ALTER TABLE lives DROP CONSTRAINT ' || quote_ident(tc.constraint_name)
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage k ON k.constraint_name = tc.constraint_name
             WHERE tc.table_name='lives' AND k.column_name='marca_id' AND tc.constraint_type='FOREIGN KEY' LIMIT 1);
    ALTER TABLE lives ADD CONSTRAINT lives_marca_id_fkey
      FOREIGN KEY (marca_id) REFERENCES marcas(id) ON DELETE RESTRICT;
  END IF;
END $$;
```

> NOTA: valide o nome real da constraint FK atual de `lives.marca_id` (migration 093) e ajuste o bloco DO se necessário; mantenha idempotente.

- [ ] **Step 2: Registrar em `apply_migrations.js`**

Adicionar `'117_lives_marca_obrigatoria.sql'` ao final do array `MIGRATIONS_LIST`.

- [ ] **Step 3: Verificar registro**

Run: `npx vitest run test/migrations_runner.test.js`
Expected: PASS (se o teste itera a lista/pasta; senão adicione assert que 117 está em `MIGRATIONS_LIST`).

- [ ] **Step 4: Commit**

```bash
rtk git add migrations/117_lives_marca_obrigatoria.sql apply_migrations.js
git commit -m "feat(db): migration 117 — lives.marca_id NOT NULL + FK RESTRICT + backfill

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Engine — throw quando faltar marca + apagar gambiarra de marca-nula

**Files:**
- Modify: `src/lib/marca-sql.js` (simplifica predicado pós-NOT NULL)
- Modify: `src/services/commission-engine.js` (`:59-78`)
- Modify: `src/routes/lives.js` (remover auto-heal `:662-704` e `:937-957`)
- Test: `test/commission_engine.test.js`

- [ ] **Step 1: Teste — engine LANÇA erro se a live não resolve marca**

Em `test/commission_engine.test.js`:

```js
it('lança erro (não zera silenciosamente) quando a live não resolve marca', async () => {
  const db = { query: async (sql) => String(sql).includes('FROM lives l') ? { rows: [{ id: 'L', marca_id: null }] } : { rows: [] } }
  await expect(calcularComissoesDaLive(db, { liveId: 'L', tenantId: 'T', gmv: 1000 }))
    .rejects.toThrow(/marca/i)
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run test/commission_engine.test.js`
Expected: FAIL — hoje zera (`comissao_calculada=0`) e retorna `[]`, não lança.

- [ ] **Step 3: Trocar o sink por throw**

Em `src/services/commission-engine.js`, substituir o bloco `if (!live.marca_id) { ...UPDATE comissao_calculada=0...; return [] }` (`:59-68`) por:

```js
  if (!live.marca_id) {
    // Invariante pós-117: toda live tem marca. Se chegou aqui sem marca, é erro real
    // (não zerar em silêncio) — vira erro observável no log/limite.
    throw new Error(`comissao: live ${liveId} sem marca resolvível (tenant ${tenantId})`)
  }
```

E remover o bloco de auto-cura `if (!live.live_marca_id) { UPDATE lives SET marca_id... }` (`:70-78`) — desnecessário, pois `marca_id` é NOT NULL e sempre resolvido na criação.

- [ ] **Step 4: Remover auto-heal pós-insert em `lives.js`**

Remover o bloco "Evento automático de agenda" parte que preenche `marca_id` por status='ativa' não é mais necessário para resolver marca (a marca já existe). Especificamente: remover o fallback de marca dentro de `lives.js:662-704` que busca marca por cliente (linhas 666-674) — a marca já está em `resolvedMarcaId`. Manter a criação do evento automático usando `resolvedMarcaId`. E remover o bloco equivalente no manual (`:937-957`) se existir.

> NOTA: leia os blocos exatos antes de remover; preserve a criação do evento de agenda (apenas elimine a re-resolução de marca, que virou morta).

- [ ] **Step 5: Simplificar o predicado (braço marca_id IS NULL morto)**

Em `src/lib/marca-sql.js`, agora que `marca_id` é NOT NULL:

```js
export const MARCA_RESOLVE_PREDICATE = 'm.id = l.marca_id'
```

(Isso propaga automaticamente para financeiro e engine — resolvedor único.)

- [ ] **Step 6: Rodar tudo verde**

Run: `npx vitest run`
Expected: PASS (397+). Ajuste testes que dependiam do comportamento antigo de "zera e segue".

- [ ] **Step 7: Commit**

```bash
rtk git add src/services/commission-engine.js src/routes/lives.js src/lib/marca-sql.js test/commission_engine.test.js
git commit -m "refactor(comissao): throw em vez de zerar; apaga auto-heal de marca-nula; predicado simplificado

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Reprocessar todo o histórico

**Files:**
- Create: `scripts/reprocessar_todas_comissoes.js`
- Test: manual (script one-off) — validado pelo diagnóstico SQL.

- [ ] **Step 1: Escrever o script**

Criar `scripts/reprocessar_todas_comissoes.js` (modelar pela conexão/RLS usada em `src/jobs/recalcular_comissoes.js`):

```js
// Recalcula comissão de TODAS as lives finalizadas, sob as regras novas
// (marca sempre resolve; sem gate de status). One-off / idempotente.
import { pool } from '../src/db.js' // ajuste o import de pool/conexão conforme o projeto
import { calcularComissoesDaLive } from '../src/services/commission-engine.js'
import { liveGmvSql } from '../src/lib/metric-sql.js'

const main = async () => {
  const tenants = (await pool.query(`SELECT DISTINCT tenant_id FROM lives WHERE status = 'encerrada'`)).rows
  let ok = 0, fail = 0
  for (const { tenant_id } of tenants) {
    const client = await pool.connect()
    try {
      await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenant_id])
      const lives = (await client.query(
        `SELECT id, ${liveGmvSql('lives')} AS gmv, COALESCE(manual_orders, final_orders_count, 0) AS pedidos
           FROM lives WHERE tenant_id = $1::uuid AND status = 'encerrada'`, [tenant_id])).rows
      for (const lv of lives) {
        try { await calcularComissoesDaLive(client, { liveId: lv.id, tenantId: tenant_id, gmv: Number(lv.gmv), pedidos: Number(lv.pedidos) }); ok++ }
        catch (e) { fail++; console.error('FALHA live', lv.id, e.message) }
      }
    } finally { client.release() }
  }
  console.log(`reprocessamento: ${ok} ok, ${fail} falhas`)
  await pool.end()
}
main().catch((e) => { console.error(e); process.exit(1) })
```

> NOTA: confirme o caminho real do pool/conexão e o mecanismo de RLS (`set_config('app.tenant_id', ...)`) em `src/db.js`/`recalcular_comissoes.js` e ajuste. `calcularComissoesDaLive` respeita `status_aprovacao='aprovada'` (não sobrescreve aprovadas).

- [ ] **Step 2: Rodar em prod após o deploy da Task 6**

Run (no ambiente com `DATABASE_URL` de prod): `node scripts/reprocessar_todas_comissoes.js`
Expected: log `reprocessamento: N ok, 0 falhas` (falhas listam lives a investigar).

- [ ] **Step 3: Validar com o diagnóstico**

Rodar a query de diagnóstico (a mesma do fix de hoje) e conferir que dias 16–20 do Blumenau passam a ter comissão; conferir Financeiro × Comissões batendo.

- [ ] **Step 4: Commit + push (deploy)**

```bash
rtk git add scripts/reprocessar_todas_comissoes.js
git commit -m "chore(comissao): script de reprocessamento historico (one-off)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
rtk git push origin codex/blumenau-operational-fase1
```

---

## Self-Review

**Spec coverage (spec §4):**
- §4.1 marca obrigatória nos 3 paths → Tasks 2, 3, 4 ✅
- §4.2 backfill + NOT NULL + FK RESTRICT → Task 5 ✅
- §4.3 remover gate status='ativa' → Task 1 ✅
- §4.4 apagar gambiarra + throw → Task 6 ✅
- §4.5 reprocessar tudo → Task 7 ✅
- §10 resolvedor único → Task 1 (`marca-sql.js`) ✅

**Placeholders:** Os "NOTA:" são instruções de verificação contra o código real (nomes de constraint FK, harness de teste existente, caminho do pool), não placeholders de conteúdo. Os testes de rota (Tasks 2–4) referenciam o harness existente (`lives_start.test.js`, `lives_manual.test.js`, `agenda_autostart.test.js`) porque o mock de `db.query` desses fluxos é sequencial e deve seguir o padrão já estabelecido.

**Type/contrato consistency:** `ensureClienteMarca(db,{tenantId,clienteId}) → Promise<string|null>` usado igual nas Tasks 2 e 3 (bate com `client-brand.js:13`). `MARCA_RESOLVE_PREDICATE`/`marcaResolveLateralSql` definidos na Task 1 e reusados nas Tasks 1 e 6. `code:'MARCA_OBRIGATORIA'` + HTTP 422 idêntico nas Tasks 2 e 3.

**Ordem:** 1 (gate, independente) → 2,3,4 (marca obrigatória, antes da migration) → 5 (migration) → 6 (throw + limpeza, depois da migration) → 7 (reprocessar, por último). Deploy/push só ao final (Task 7) ou em pontos seguros intermediários.
