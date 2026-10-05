# Handoff para o Codex — Livelab (05/10/2026)

**Dono:** Lucas · **Repos:** `Greed9797/Livelab-back` (API) e `Greed9797/Livelab-Front` (telas)
Leia antes de qualquer coisa: `CLAUDE.md` e `AGENTS.md` dos dois repositórios.

## 1. Estado atual (o que já está no ar)

| Repo | Branch de produção | Publica em | Último merge |
|---|---|---|---|
| Back | `codex/blumenau-operational-fase1` | Railway (merge roda `apply_migrations.js` e publica) | #69 (limpeza de lixo de ferramenta) |
| Front | `feat/multi-apresentadora-agenda` | Vercel via GitHub Actions (`frontend-deploy.yml`) | #58 (remoção do Flutter) |

Entregue entre 04 e 05/10:
- **Back #68** — cadastro unificado (`/v1/cadastros`, `lives.cliente_id` herdado da marca), correção "Rosa do Deserto" (marca não-cliente não gera receita nem comissão de franquia), comissão por linha, e os ajustes do financeiro (caixa no DRE, cancelar/reativar pagamento de apresentadora e imposto, cliente inativo sai da Receita, janela de comissão). Migrations **174–179** aplicadas em produção.
  - Atenção: duas entregas criavam 174–176 diferentes; as do financeiro foram renumeradas para **177–179**. Os docs antigos `PLANO-FINANCEIRO-AJUSTES-2026-10*.md` citam os números originais.
- **Front #57** — lista "Clientes" com coluna Tipo (atrás de `VITE_CADASTRO_UNIFICADO`, **desligada**), aviso de marca não-cliente na Receita, cabeçalho fixo, caixa no DRE, janela de comissão.
- **Limpeza do GitHub:** Flutter e lixo de ferramenta removidos dos dois repos, docs reescritos, 97 branches mergeadas/antigas apagadas (restauração em `restore-ramos-*.sh`, guardados pelo Lucas), PRs obsoletos fechados (back #1, #10, #65, #66, #67; front #55, #56).
- **Sem segredo no histórico:** gitleaks nos dois repos, só placeholders.

## 2. Regras inegociáveis
1. Nunca push direto nem merge em `codex/blumenau-operational-fase1` (back) ou `feat/multi-apresentadora-agenda` / `migration/react-vercel` (front) sem ok explícito do Lucas. Trabalhe em branch própria + PR.
2. Sem force-push em branch alheia, sem reescrever histórico, sem pular/desativar teste.
3. Migration nova: próxima é **`180_*`**, registrar no fim de `MIGRATIONS_LIST` (`apply_migrations.js`), idempotente, testada duas vezes num Postgres real. Confira se nenhum PR aberto usa o mesmo número.
4. Gates antes de abrir PR — back: `npx vitest run` (+ `*.pg.test.js` com `TEST_PG_URL` e `--no-file-parallelism` se mexer em SQL); front: `cd react-app && npm run typecheck && npm run test && npm run build`.
5. Telas que acusam pessoas (vermelho, "falta", "devido"): na dúvida, prefira falso negativo (ver `AGENTS.md` do front).

## 3. Tarefas para o Codex (por prioridade)

**Alta**
1. **Botão "Gerar títulos" na aba Receita.** O endpoint existe (`POST /v1/financeiro/receitas/gerar?mes=YYYY-MM`, `src/routes/financeiro_receitas.js`), mas nenhuma tela chama. Sem ele, título antigo de marca não-cliente só some marcando "perdido" (⊘) à mão. Adicionar em `react-app/src/components/financeiro/ReceitaPanel.tsx` (padrão: "Gerar mês" em `RecorrentesPanel.tsx`), com confirmação e toast com `criados/atualizados/removidos/perdidos_preservados`.
2. **Telas de criar/editar cadastro usando `/v1/cadastros`.** Hoje usam `/v1/clientes` e `/v1/marcas`; se o back responder 409 `USE_CADASTRO_ENDPOINT` (`src/routes/marcas.js`), a tela só mostra o erro. Pré-requisito para o Lucas ligar `VITE_CADASTRO_UNIFICADO=true`.
3. **CI do front não roda em PR para `feat/multi-apresentadora-agenda`.** Incluir essa base em `pull_request.branches` de `.github/workflows/frontend-ci.yml`. Hoje o primeiro teste é no deploy, depois do merge.

**Média**
4. **Promover marca a cliente** não preenche `lives.cliente_id` das lives antigas daquela marca (o gatilho da 175 só age em insert/update; o backfill da 176 rodou uma vez). Avaliar backfill pontual no fluxo de promoção.
5. **Card de Pendentes (Comissões)** soma a `comissao_franquia` gravada, enquanto detalhe e export já zeram marca não-cliente — números podem divergir na mesma tela (`src/routes/comissoes.js`).
6. **Margem de contribuição** no DRE ainda não desconta perdas.
7. **Chip "atrasados de meses anteriores"** (front) olha 12 meses; o painel do back olha 2 meses antes do corte — alinhar a janela.
8. **DRE:** anual sem saldo de caixa mês a mês; mensal mostra "R$ 0,00" no caixa quando não há data de corte (deveria mostrar "não configurado").

**Baixa / técnica**
9. `npm run test:integration` falha em `assiduidade_union` (`l.arquivada_em`) — pré-existente.
10. Deadlock da migration 165 obriga `--no-file-parallelism` nos `*.pg.test.js`.
11. Confirmar `FORCE ROW LEVEL SECURITY` em `custos_recorrentes`, `apresentadora_pagamentos`, `gateway_transacoes`.
12. PRs abertos para revisar/fechar com o Lucas — front: #25, #28, #29 (já incorporados na produção), #31, #45; back: #18, #29. Branches `cursor/*` de 20–21/09 ficaram de propósito; revisar junto.
13. Nunca houve teste das telas novas contra o backend real com login — rodar o Playwright (`npm run e2e`) apontando para produção com usuário de teste.

## 4. Fora de escopo (decisão do Lucas — não fazer sem pedir)
- Trocar a branch default do back (`master` está defasada) — mexe no Railway.
- Unificar a produção do front em `migration/react-vercel` (está defasada de `feat/multi-apresentadora-agenda`).
- Poda de tags.

## 5. Só o Lucas pode fazer (não é código)
- Tornar os dois repos privados (GitHub → Settings → Change visibility) e proteger as branches de produção (bloquear force-push/delete) + ligar "delete branch on merge".
- Desativar `livelab-3601f.web.app` no Firebase Hosting.
- No app: marcar como perdido (⊘) os títulos antigos da Rosa do Deserto antes de outubro; criar nova versão da condição comercial da Pure Up e da Popô Baby com janela início dia 16, pagamento dia 20; cadastrar saldo do caixa (corte 01/10); importar a planilha de custos (dry-run antes); trocar a chave do Asaas que circulou em conversa.
- Conferir se o saldo inicial de 01/10 também foi lançado como aporte (contado duas vezes). Se aparecer um aporte com o mesmo valor de `financeiro_saldo_abertura`, apagar o aporte:
  ```sql
  SELECT ra.id, ra.descricao, ra.valor_previsto, ra.competencia, ra.data_vencimento,
         t.financeiro_saldo_abertura, t.financeiro_data_corte
    FROM receitas_avulsas ra JOIN tenants t ON t.id = ra.tenant_id
   WHERE ra.tenant_id = '<tenant_id>'::uuid AND ra.grupo = 'aporte'
     AND (ra.competencia = DATE '2026-10-01'
          OR ra.data_vencimento BETWEEN DATE '2026-10-01' AND DATE '2026-10-31');
  ```
- Conferir no Mac que `~/Livelab-back` não tem commits só locais (`git rev-list --count HEAD --not --remotes` = 0).
