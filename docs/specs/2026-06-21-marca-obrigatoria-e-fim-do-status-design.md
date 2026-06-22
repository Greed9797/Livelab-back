# Design — Marca obrigatória + fim do enum `lives.status`

**Data:** 2026-06-21 · **Autor:** Leonardo + Claude · **Repos:** `Greed9797/Livelab-back` (Fastify+Postgres) · `Greed9797/Livelab-Front` (React/Vite)
**Objetivo:** tornar o sistema **mais robusto e mais simples**, eliminando duas fontes de erro silencioso: (1) live sem marca → comissão some sem erro; (2) status (`marcas.status='ativa'`, `lives.status`) que silenciosamente exclui dinheiro.

---

## 1. Princípio

> **Exige-ou-erra**, nunca **resolve-ou-zera**. Toda live tem exatamente uma marca; comissão é sempre `gmv × pct` da marca; **nenhum status remove dinheiro de uma live que existe**.

## 2. Como está hoje (as-is, resumido)

- **Marca é opcional** nos 3 caminhos de criação de live (start `lives.js:621`, manual `lives.js:884`, autostart `agenda_autostart.js:148`); o banco permite (`lives.marca_id` nullable, FK `ON DELETE SET NULL`, índice parcial em migration `093`).
- Sem marca resolvível, `commission-engine.js:59-68` faz `comissao_calculada=0` (UPDATE com `.catch(()=>{})`) e retorna `[]` — **sem erro**. A live mantém GMV mas contribui 0.
- O motor e o Financeiro só resolvem marca `status='ativa'` (`commission-engine.js:49-51`, `financeiro.js:84-91`/`248-256`). Cancelar cliente (`clientes.js:541-547`) e deletar marca (`marcas.js:439`) flipam a marca pra `inativa` → **zeram retroativamente** todo o histórico daquele cliente nas telas de dinheiro.
- `lives.status` (`em_andamento`/`encerrada`/`cancelada`, migration `007`) é o gate "essa live conta": **todo** rollup filtra `status='encerrada'` (`performance-rollups.js:120/228`, `financeiro.js:93/125/200`, `comissoes.js:78`, `billing_engine.js:74`). "Finalizado/faturado" **não é status** — é o timestamp `lives.faturado_em`.

## 3. Decisões registradas (escolhas do dono)

| Tema | Decisão |
|---|---|
| Escopo | Robustez + simplificação **focada** (não dropar `marcas.status`, não colapsar `status_publicacao`). |
| Histórico | **Reprocessar tudo** (recalcular comissão de todo o histórico, inclusive clientes cancelados). |
| `lives.status` | **Remover o enum** — trocar por sinais que já existem (`encerrado_em`). |
| Cancelamento de live | **Não existe** — erro se corrige editando/apagando a linha; linhas `cancelada` antigas são removidas no backfill. |

---

## 4. Fase 1 — Robustez de marca (conserta o dinheiro)

### 4.1 Marca obrigatória na criação (exige-ou-erra)
Nos 3 INSERTs de live, **dentro da transação**, resolver a marca antes de inserir:
- **cliente:** `ensureClienteMarca(db, { tenantId, clienteId })` (`client-brand.js`) garante/reativa a marca-espelho e devolve um `marca_id` não-nulo.
- **afiliado/teste:** marca direta do payload, com fallback à **marca-sistema** do tenant (já existe; já erra se a marca-sistema faltar).
- Se nenhuma marca resolve → **`ROLLBACK` + HTTP 4xx `MARCA_OBRIGATORIA`**. Nunca insere `marca_id NULL`.
- Alvos: `lives.js:621-637` (start), `lives.js:884-904` (manual), `agenda_autostart.js:148-164` (autostart — passa a exigir `locked.marca_id`, senão não cria a live e loga).

### 4.2 Banco
- **Backfill** das lives com `marca_id NULL` existentes (resolver via cliente; afiliado/teste → marca-sistema; o que não resolver é listado pra decisão manual — ver §6).
- Migration: `lives.marca_id SET NOT NULL` + trocar FK para **`ON DELETE RESTRICT`** (marca em uso não some por baixo do histórico).
- Pré-check obrigatório de contagem de `marca_id NULL` antes do `SET NOT NULL` (a migration falha se sobrar nulo).

### 4.3 Status nunca apaga dinheiro
- **Remover o filtro `m.status='ativa'`** dos resolvedores de dinheiro: `commission-engine.js:50`, `financeiro.js:87`, `financeiro.js:248`, e a versão inline já adicionada em `financeiro.js` (resumo) hoje (`52c56ca`). A comissão resolve pela marca **independente do status**.
- Consequência: os flips de marca pra `inativa` (cancelar cliente `clientes.js:541-547`; deletar marca `marcas.js:439`) **deixam de afetar dinheiro** — **não precisam ser alterados** (viram só sinal operacional/UI). A coluna `marcas.status` permanece.
- `marcas` continua com soft-delete (`status='inativa'`); como `status` não gateia mais dinheiro, o histórico resolve normalmente.

### 4.4 Trocar silêncio por erro + apagar gambiarra
Com `marca_id` garantido não-nulo, **apagar** o código que só existia pra compensar marca-nula:
- braço `l.marca_id IS NULL` na resolução de marca (motor + financeiro);
- os 3 auto-heal pós-insert (`lives.js:662-704`, `lives.js:937-957`, `commission-engine.js:70-78`);
- o sink "zera-e-retorna" (`commission-engine.js:59-68`) → substituir por **`throw`** quando faltar config real (ex.: `comissao_franquia_pct` nulo), pra virar erro observável no log em vez de dinheiro sumindo.

### 4.5 Reprocessar tudo (histórico)
- Job/migration recalcula `vendas_atribuidas` + `lives.comissao_calculada` de **todas** as lives finalizadas sob as regras novas. Comissões e Financeiro passam a refletir o histórico correto.
- **Boletos:** não há boletos emitidos em produção ainda (`billing_engine`/`faturado_em` é código **inerte**). Logo o reprocessamento é **livre** — sem risco de re-cobrança. `faturado_em` permanece como está (não usado).

---

## 5. Fase 2 — Remover o enum `lives.status`

Trocar o enum por sinais que já existem (coordenado com as mesmas queries de dinheiro da Fase 1, pra mexer uma vez só onde der):

| Hoje | Vira |
|---|---|
| `status='encerrada'` (conta pro dinheiro) | `encerrado_em IS NOT NULL` |
| `status='em_andamento'` (rodando) | `encerrado_em IS NULL` |
| `status='cancelada'` | **deixa de existir** |

### 5.1 Banco / backfill
- Garantir `encerrado_em` nas finalizadas: `encerrado_em = COALESCE(encerrado_em, previsto_fim, iniciado_em)` onde `status='encerrada'`.
- O caminho manual passa a **sempre** gravar `encerrado_em` (default = `iniciado_em`).
- Linhas `status='cancelada'` existentes → **removidas** (nunca contaram em dinheiro; remoção não altera nenhum total financeiro).
- Depois: **dropar a coluna `lives.status`** e o CHECK.

### 5.2 Código
- Trocar **todo** `status='encerrada'` por `encerrado_em IS NOT NULL` nos rollups e leituras: `performance-rollups.js`, `financeiro.js`, `comissoes.js`, `billing_engine.js`, `operacional.js`, `reports.js`, `home.js`, `franqueado.js`, portais do cliente, etc.
- Remover transições de status (`lives.js:1163-1167`, encerrar `lives.js:1910`) → encerrar passa a só setar `encerrado_em`. Remover/repurpor `encerrar_lives_zumbi.js` (vira: carimbar `encerrado_em` em live rodando há tempo demais).
- `publicar`: o check `MARCA_OBRIGATORIA_PUBLICAR` (`lives.js:2178`) fica **redundante** (marca já é obrigatória na criação) — pode sair.
- Limpar status-fantasma: `status='faturada'` (`lives.js:1464-1466`) e `status='agendada'` (`apresentadora_disponibilidade.js:111`), que não casam com nada.

### 5.3 Front
- Badges/filtros que mostram `lives.status` derivam de `encerrado_em` (finalizada vs em andamento) ou somem. Remover opções de filtro por `cancelada`.

---

## 6. O que NÃO muda
- `lives.faturado_em` / `billing_engine` — carimbo de cobrança ("finalizado" é isso, não um status). **Inerte** (boletos não estão em uso ainda). Mantido como está.
- `marcas.status` — mantido como sinal operacional/UI (sem poder sobre dinheiro).
- `status_publicacao` (rascunho/revisado/publicado) — mantido (escopo focado).
- `contratos.status`, `clientes.status` — gates **loud** (já erram), fora de escopo.

## 7. Testes
- Cada caminho de criação **rejeita** live sem marca (erro 4xx; nenhuma linha criada).
- Comissão **resolve** para marca `inativa` (não zera) após remover o gate.
- Reprocessamento recalcula histórico; números de Financeiro/Comissões batem com Analytics.
- Fase 2: rollups contam por `encerrado_em IS NOT NULL`; live rodando (sem `encerrado_em`) não conta.
- Suíte atual (397) verde + novos testes. SQL novo validado no parser do Postgres.

## 8. Riscos
1. `marca_id NOT NULL` falha se sobrar nulo → backfill + pré-check antes (§4.2).
2. Remover o gate `status='ativa'` **muda números históricos** (reativa comissão de clientes cancelados) — decisão já tomada (reprocessar tudo); aval é do dono.
3. FK `ON DELETE RESTRICT`: marca com lives não pode ser hard-deletada (o endpoint já é soft-delete, então sem conflito).
4. ~~Reprocessar não deve re-emitir boletos~~ — **N/A**: não há boletos emitidos (billing inerte), reprocessamento é livre.
5. Marca-sistema precisa existir em **todo** tenant (migration 104) antes de exigir marca, senão afiliado/teste erram na criação.
6. Os 3+ resolvedores de comissão duplicados (motor + financeiro x2 + chaveamento do fixo) mudam **juntos** — divergência re-introduz erro silencioso. (Considerar extrair pra um único helper SQL — ver §10.)
7. Fase 2 toca ~todos os rollups + front/portais; mudança coordenada back+front.
8. Remover `status` exige garantir `encerrado_em` em 100% das finalizadas (backfill) — senão finalizada vira "em andamento".

## 9. Decisões resolvidas
1. **Boletos:** ✅ não existem boletos em prod (billing inerte) → reprocessamento livre, sem re-cobrança.
2. **Lives órfãs no backfill** (sem cliente e sem marca): ✅ **listar pra correção manual** (migration falha de forma controlada listando-as; não apaga, não inventa marca).
3. **Linhas `cancelada` antigas:** ✅ **hard-delete** no backfill da Fase 2 (financeiramente neutro — nunca contaram).

## 10. Oportunidade (fora do escopo imediato, mas recomendado)
Extrair a resolução de marca + cálculo de comissão de franquia para **um único helper** (SQL/JS) reusado por motor, financeiro (resumo + faturamento) e rollups — elimina a duplicação que causa drift (risco #6). Pode entrar como passo da Fase 1.

---

## Ordem de execução
**Fase 1** (independente, conserta o dinheiro) → **Fase 2** (remove o enum). Cada fase: branch/commit próprios, testes verdes, deploy Railway (back) e Vercel (front, só Fase 2).
