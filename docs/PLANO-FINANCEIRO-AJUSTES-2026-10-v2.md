# Plano v2 — Financeiro: 7 ajustes (out/2026) portados para as bases publicadas

> **Nota (consolidação 04/10/2026):** as migrations deste plano foram renumeradas para não colidir com as do cadastro unificado (174–176): `174_apresentadora_pagamentos_cancelamento` → **177**, `175_marcas_data_fim_inativas` → **178**, `176_condicoes_comissao_janela` → **179**. Os números abaixo são os originais.

Data de referência: 2026-10-04. Substitui `PLANO-FINANCEIRO-AJUSTES-2026-10.md` (v1, branch `backup/financeiro-ajustes-out-v1`, nunca publicada). Decisões do usuário da v1 continuam valendo; o que a produção (2026-10-02) já resolveu NÃO é refeito.

- Back: `/Users/lucas/Livelab-back-fin2` — base `origin/codex/blumenau-operational-fase1` @437e9ed (Railway). Branch `fix/financeiro-ajustes-out-v2`.
- Front: `/Users/lucas/Livelab-Front-fin2/react-app` — base `origin/feat/multi-apresentadora-agenda` @4081df8 (Vercel). Mesma branch.
- Prod já tem a migration `173_perdas_cancelamentos.sql` (`receita_titulos`/`receitas_avulsas.perdido_em TIMESTAMPTZ + perdido_motivo + perdido_por`; `custos.cancelado_em/motivo/por`; CHECK motivo ≤ 300). **Próxima migration livre: 174** (`apply_migrations.js:170` termina em `'173_perdas_cancelamentos.sql'`).
- Cache: todo GET pesado do financeiro passa por `agregadorCache` (`src/routes/financeiro.js:150-159`, namespace `financeiro:agregador`, TTL 30 s) com contador de geração por tenant (`src/lib/dashboard-cache.js:140-160`). **Toda escrita que muda lançamentos, marcas, condições ou fixo de apresentadora chama `invalidateTenant(tenant_id)` (sem lista de namespaces = todos).**
- Testes: `*.test.js` com `db.query` mockado; `*.pg.test.js` só com `TEST_PG_URL` (`describe.skipIf(!url)`), reaplicam a migration no `beforeAll` (padrão `test/financeiro_perdas_ciclo.pg.test.js:1-40`). Um PGlite servido como Postgres via `TEST_PG_URL` roda os mesmos arquivos.

---

## 1. Status por item nas bases novas

| # | Pedido | Status | Evidência (base nova) | O que falta |
|---|---|---|---|---|
| 1 | Projetado Lançamentos = DRE | **Resolvido na UI, resíduo na API** | Aba Lançamentos agora usa `PainelMes` (`FinanceiroPage.tsx:198-207`); `ResumoCards`/`CaixaHoje` foram apagados. `GET /painel` → `competencia.resultado` = `montarDre(...).meses[0].resultado` (`financeiro-agregador.js:1253-1258`), a mesma função do `/dre`. Mas `totalizarLancamentos.saldo_previsto` ainda soma aporte na receita (`:320-336` — `n.previsto` inclui `ehAporte`), enquanto o DRE exclui (`:384`). Nenhum componente consome `totais.saldo_previsto` hoje (só `utils/financeiro.ts:311,343`). | Alinhar `saldo_previsto/saldo_realizado` (back e `utils/financeiro.ts:totalizar`) descontando aportes; teste de invariante card = DRE. Conferência do "aporte em dobro" (SQL da v1 §1) continua manual. |
| 2 | Fixo editado em Configurações → Custos fixos | **Não resolvido** | Back já deriva em leitura (`apresentadora_fixo_historico`). Front: `SettingsUsuariosPanel.tsx:163-169,180-188` invalida só `['usuarios']`/`['apresentadoras']`; queries do financeiro usam `FQK` (`services/financeiro.ts:36`) com `FIN_CACHE.staleTime 60 s` + `keepPreviousData` (`hooks/useFinanceiro.ts:42-55`). Back: `PATCH /v1/usuarios/:id` (`usuarios.js:348`) e `PATCH /v1/apresentadoras/:id` (`apresentadoras.js:276`) **não** chamam `invalidateTenant` → agregador serve 30 s de valor velho. | Front: `invalidateFinanceiro(client)` nas mutações (patch v1 aplica limpo em `useFinanceiro.ts` e `SettingsUsuariosPanel.tsx`). Back: `invalidateTenant` nas duas rotas (e DELETE). |
| 3 | Saldo inicial 01/10 no DRE | **Não resolvido** | `calcularDreMes` (`financeiro-agregador.js:1006-1012`) e `montarDreDetalhe` (`:581-650`) não têm `caixa`; `DrePanel.tsx`/`DreMesInline.tsx` não citam saldo. `FluxoCaixaPanel.tsx:88-92,141-150` mantém input "Saldo inicial" editável (0 → não envia; backend usa o caixa, `routes/financeiro.js:481-487`). | Bloco informativo "Caixa" (decisão v1) no `/dre/mes` + `DreMesInline`; linha no `DrePanel`; input do fluxo somente leitura quando há `data_corte`. |
| 4 | "Perdido" em receber **e** pagar, reversível | **Parcial** | Receitas: `/receitas/:id/perder|desperder` (`financeiro_receitas.js:169-205`), avulsas idem (`financeiro_receitas_avulsas.js:190+`), custos `/custos/:id/cancelar|reativar` (`financeiro_custos.js:407-460`). Status `perdido|cancelado` derivado (`lancamento-status.js:22-36`). Exclusões já valem: `emAberto = 0` para encerrado → fora de a receber/a pagar (`abertosAte :1086-1097`, `resumirAbertos :1167-1188`), do caixa projetado, do fluxo (`:691`), de pendente/atrasado (`:326-328`), do imposto (`:258`) e da conciliação (`conciliacao.js:235-240`). DRE: coluna "Receita perdida" e custos cancelados fora do previsto (`addPrCusto :356`); detalhe lista `encerrados` por natureza (`DreMesInline.tsx:272-370`). **Faltam** apresentadoras e imposto: `normalizarApresentadora` (`:175-191`) e `montarItemImposto` (`:229-255`) não passam por `marcarEncerramento`; `acoesPerda` nega para ambos (`utils/financeiro.ts:499`); `apresentadora_pagamentos` não tem colunas. Pagar item encerrado → 409 em todas as famílias (`receitas-comercial.js:420`, `custos-plano.js:321`, `conciliacao.js:286-290,341,374,426`). | Estender o modelo de prod para apresentadora (`cancelado_*` na tabela, migration 174) e imposto (reusa `custos.cancelado_*`); rotas `/cancelar|/reativar`; front libera as ações. |
| 5 | Botões do topo iguais em todas as abas | **Não resolvido** | `FinanceiroPage.tsx:160-162` (`mostraNovaReceita/mostraNovoCusto`) e `:180-189`. | Header fixo `Mês · Nova receita · Novo custo · Configurar ▾` (v1 `ConfigurarMenu`). e2e `financeiro-dre.e2e.ts:87` usa papel `financeiro_readonly` → segue passando (botões gated por `podeEscrever`). |
| 6 | Receita sem clientes cancelados/arquivados | **Não resolvido** | `clientes.js:666-676` muda `marcas.status` e não preenche `data_fim`; `marcaFixoVigenciaSql` (`receita-marca-sql.js:113-129`) e `marcasCondicaoVigenteMesSql` (`:228-243`) filtram só `tipo/sistema/data_fim`. Arquivos intocados pela prod: patch v1 aplica limpo (`git apply --check` OK em `clientes.js`, `client-brand.js`, `marcas.js`, `marca-sql.js`, `receita-marca-sql.js`). `marcas.js` invalida só `LISTAGEM_NAMESPACES` (`:27,467,528,561,809`); `clientes.js` não invalida nada. | Portar v1 (data_fim no ciclo de vida, `LEAST`, apaga títulos futuros não pagos e não perdidos, aviso de reativação, filtro de status nos SQLs) + migration de backfill (agora **175**) + `invalidateTenant` total. |
| 7 | Comissão do mês seguinte com janela por marca | **Não resolvido** | `comissaoMarcaMensalSql` agrupa por mês civil (`receita-marca-sql.js:143,157`); `marca_condicoes_comerciais` sem `comissao_janela_inicio_dia`; `vencimentoCondicaoSchema` (`marca-condicoes.js:37-42`) só tem dia/offset. Patch v1 aplica limpo em `lib/marca-condicoes.js`, `services/marca-condicoes.js` (inclui `JANELA_RETROATIVA`), `receita-marca-sql.js`, `marca-sql.js`; `receitas-comercial.js` conflita (prod mexeu) → só o hunk `janela_inicio_dia` em `montarReceitaMensal` é reaplicado à mão. Front: `CondicoesComerciais*`, `condicoes-vencimento.ts`, `ComercialPage.tsx` aplicam limpo; `receita-mensal.ts`/`ReceitaPanel.tsx` conflitam (hint refeito). | Portar v1 com migration **176**. |

---

## 2. Decisões (v2)

1. **Modelo de perda/cancelamento = o da produção.** Receita → `perdido_em/perdido_motivo/perdido_por` + status `perdido`; pagável → `cancelado_em/cancelado_motivo/cancelado_por` + status `cancelado`. O pedido "perdido vale para pagar" é atendido com o vocabulário já publicado ("Cancelar despesa"). Nada de `aplicarPerda`/`valor_perdido`/`valor_previsto_original` da v1: usar `encerrado()/valorEncerrado()/previstoEfetivo()/marcarEncerramento()` (`financeiro-agregador.js:118-144`) e `normalizarMotivo` (`lancamento-status.js:56-67`, ≤ 300).
2. **Pagar/conciliar item encerrado → 409** (`ALVO_PERDIDO|ALVO_CANCELADO|RECEITA_PERDIDA|CUSTO_CANCELADO`), como a prod. A decisão v1 "conciliação limpa a perda" é **descartada**: o usuário reativa e baixa. Vale também para apresentadora e imposto.
3. **Apresentadora:** `apresentadora_pagamentos` ganha `cancelado_em TIMESTAMPTZ, cancelado_motivo TEXT, cancelado_por UUID` e `data_pagamento` vira nullable (linha cancelada sem baixa = `valor_pago 0, data_pagamento NULL`). Cancelar materializa a linha (upsert); reativar apaga a linha se `valor_pago = 0` (volta a virtual), senão só limpa `cancelado_*`. `desfazer` em linha cancelada zera a baixa e mantém o cancelamento. Previsto ≤ 0 ou pago ≥ previsto → 409 `CANCELAMENTO_INVALIDO`.
4. **Imposto:** reusa a linha de `custos tipo='imposto'` (já tem `cancelado_*`). Cancelar = upsert com `valor_pago = 0` + `cancelado_*` (previsto gravado = cálculo atual); reativar apaga se `valor_pago = 0`, senão limpa; `pagarImposto` em linha cancelada → 409; `desfazerImposto` em linha cancelada zera a baixa e mantém.
5. **Item 1:** `saldo_previsto = (receita.previsto − receita.perdido − aportes.previsto) − (custo.previsto − custo.cancelado)`; `saldo_realizado = (receita.pago − aportes.pago) − custo.pago`. Invariante testada: `saldo_previsto === montarDre(...).meses[0].resultado.previsto`.
6. **Item 3:** `GET /dre/mes` → `caixa: { saldo_inicio_mes, saldo_abertura, data_corte, origem: 'caixa'|'padrao' }` via `saldoCaixaInicioMes` (`:1073-1079`), fora de `atual/anterior/resultado`. Fluxo: com `data_corte` o saldo inicial é somente leitura.
7. **Item 6/7:** idem v1 (inclusive pós-review): `data_fim = LEAST(COALESCE(data_fim, hoje_SP), hoje_SP)` ao cancelar/arquivar/deletar; reativação limpa `data_fim` só se ≥ hoje, senão `aviso: 'data_fim_expirada'`; cancelar apaga `receita_titulos` com `valor_pago = 0 AND perdido_em IS NULL` e competência > mês de `data_fim`; backfill pelo `audit_log` com fuso SP; `comissao_janela_inicio_dia` 1..28, competência = mês de início da janela, `JANELA_RETROATIVA` quando a versão já tem títulos; `/resumo` segue por mês civil com hints.
8. Helpers SQL do ciclo de vida (`HOJE_SP_SQL`, `DATA_FIM_ENCERRAMENTO_SQL`, `DATA_FIM_REATIVACAO_SQL`) vão para **`src/lib/marca-lifecycle-sql.js`** (novo), não para `marca-sql.js` (que é do pacote da janela) — evita dependência entre WP-C e WP-D.

---

## 3. Contrato compartilhado (front e back em paralelo)

```
# Item (GET /lancamentos, /dre/mes, apresentadoras-pagamentos) — já existe para receita/custo; passa a existir p/ apresentadora e imposto:
  cancelado_em: ISO|null, cancelado_motivo: string|null, cancelado_por: uuid|null
  status: 'previsto'|'pendente'|'atrasado'|'parcial'|'pago'|'perdido'|'cancelado'

# Novas rotas (WRITE_FINANCEIRO; body { motivo?: string ≤300 } só no cancelar; audit + invalidateTenant; 409 se pago integral)
PATCH /v1/financeiro/apresentadoras-pagamentos/:ap/:mes/:componente/cancelar   → item normalizado (status 'cancelado')
PATCH /v1/financeiro/apresentadoras-pagamentos/:ap/:mes/:componente/reativar   → item (ou 404 se nunca foi cancelado)
PATCH /v1/financeiro/impostos/:mes/cancelar | /reativar                        → item imposto
  erros: 409 { error, code: 'CANCELAMENTO_INVALIDO' | 'JA_PAGO' } · 404 · 400 mes/params

# GET /v1/financeiro/lancamentos → totais
  saldo_previsto  = (receita.previsto − receita.perdido − aportes.previsto) − (custo.previsto − custo.cancelado)
  saldo_realizado = (receita.pago − aportes.pago) − custo.pago            (demais chaves inalteradas)

# GET /v1/financeiro/dre/mes → + caixa: { saldo_inicio_mes, saldo_abertura, data_corte, origem: 'caixa'|'padrao' }

# GET /v1/financeiro/receita → marca: + janela_inicio_dia: number (1 = mês civil)
# Condição comercial: + comissao_janela_inicio_dia (1..28, default 1) em POST /v1/marcas/:id/condicoes,
#   PATCH /v1/marcas/:id/condicoes/:cid/vencimento (400 JANELA_RETROATIVA) e GET
# PATCH /v1/clientes/:id (status ativo) e PATCH /v1/marcas/:id (status 'ativa') → + aviso?: 'data_fim_expirada'
```

Front: `ModoPerda` continua `'perder'|'cancelar'|'desfazer'`; `rotaPerda` ganha ramos apresentadora/imposto (`cancelar` → `/cancelar`, `desfazer` → `/reativar`); `acoesPerda` libera `podeCancelar` para `origem in ('apresentadora','imposto')` quando `status ∉ {pago, cancelado}` e `podeDesfazer` quando `cancelado`.

---

## 4. Migrations (idempotentes; não falham em dado existente)

| Arquivo | Conteúdo |
|---|---|
| `174_apresentadora_pagamentos_cancelamento.sql` | `ALTER TABLE apresentadora_pagamentos ADD COLUMN IF NOT EXISTS cancelado_em TIMESTAMPTZ NULL; … cancelado_motivo TEXT NULL; … cancelado_por UUID NULL REFERENCES users(id) ON DELETE SET NULL; ALTER COLUMN data_pagamento DROP NOT NULL;` + `DO $$ … pg_constraint 'apresentadora_pagamentos_cancelado_motivo_check' CHECK (cancelado_motivo IS NULL OR char_length(cancelado_motivo) <= 300)` + `COMMENT`. Sem CHECK de valor (previsto não é gravado). Mesmo padrão da 173. |
| `175_marcas_data_fim_inativas.sql` | Conteúdo da v1 `174_marcas_data_fim_inativas.sql` sem alteração (backfill por `audit_log` → fallback `atualizado_em AT TIME ZONE 'America/Sao_Paulo'`, só `data_fim IS NULL`). |
| `176_condicoes_comissao_janela.sql` | Conteúdo da v1 `175_condicoes_comissao_janela.sql` (`comissao_janela_inicio_dia SMALLINT NOT NULL DEFAULT 1` + CHECK 1..28, nome `marca_condicoes_comissao_janela_check`). |

`apply_migrations.js`: três linhas após `'173_perdas_cancelamentos.sql'` (`:170`).

---

## 5. Pacotes de trabalho (Sonnet). **owns** = únicos arquivos que o pacote edita/cria. Sem colisão → paralelo.

### WP0 — Migrations (back) — primeiro
- owns: `migrations/174_apresentadora_pagamentos_cancelamento.sql`, `migrations/175_marcas_data_fim_inativas.sql`, `migrations/176_condicoes_comissao_janela.sql`, `apply_migrations.js`, `test/migration_175_backfill.test.js` (= v1 `migration_174_backfill.test.js` com o nome novo)
- deps: nenhuma
- passos: criar as 3 migrations (§4); 175/176 copiadas de `git -C /Users/lucas/Livelab-back-fin show backup/financeiro-ajustes-out-v1:migrations/174_marcas_data_fim_inativas.sql` e `…:migrations/175_condicoes_comissao_janela.sql`; registrar no array.
- verificação: `node --check apply_migrations.js && npx vitest run test/migration_175_backfill.test.js test/migrations_runner.test.js`; com `TEST_PG_URL`: `for f in 174 175 176; do psql "$TEST_PG_URL" -f migrations/${f}_*.sql; psql "$TEST_PG_URL" -f migrations/${f}_*.sql; done` (idempotência).

### WP-A — Agregador: saldo_previsto, caixa no DRE, imposto cancelável, apresentadora encerrada (back)
- owns: `src/services/financeiro-agregador.js`, `src/routes/financeiro.js`, `test/financeiro_agregador.test.js`, `test/financeiro_dre_classe.test.js`, `test/financeiro_imposto_cancelar.test.js` (novo), `test/financeiro_painel.test.js` (só se o shape mudar)
- deps: nenhuma (campo `cancelado_em` do item de apresentadora é contrato com WP-B)
- passos:
  1. `totalizarLancamentos` (`:313-337`): `saldo_previsto`/`saldo_realizado` descontam `aportes` (decisão 5). Ajustar expectativas em `test/financeiro_agregador.test.js` e acrescentar invariante card = DRE com 1 aporte + 1 perdido + 1 cancelado.
  2. `normalizarApresentadora` (`:175-191`): copiar `cancelado_*` do row e terminar com `return marcarEncerramento(item)`; `virtual = !(valor_pago > 0) && !p.cancelado_em`.
  3. `IMPOSTO_COLS` (`:804`) + `cancelado_em, cancelado_motivo, cancelado_por`; `montarItemImposto` (`:229`) copia os três (`timestampIso` em `cancelado_em`) e `return marcarEncerramento(item)`.
  4. Novos `cancelarImposto(db,{tenantId,mes,motivo,actorUserId,hoje})` e `reativarImposto(db,{tenantId,mes,hoje})` (decisão 4) ao lado de `pagarImposto` (`:916`); `pagarImposto` lê a linha antes do upsert e lança 409 `CUSTO_CANCELADO` se `cancelado_em`; `desfazerImposto` (`:938`): se `cancelado_em`, `UPDATE valor_pago = 0, data_pagamento = NULL` em vez de `DELETE`. Erros via `erro(msg, 409, code)`.
  5. `calcularDreMes` (`:1006`): `const caixa = cfg.data_corte ? { saldo_inicio_mes: await saldoCaixaInicioMes(...), saldo_abertura: r2(cfg.saldo_abertura), data_corte, origem: 'caixa' } : { saldo_inicio_mes: 0, saldo_abertura: 0, data_corte: null, origem: 'padrao' }`; devolver `caixa` no topo da resposta (fora de `montarDreDetalhe`).
  6. Rotas `PATCH /v1/financeiro/impostos/:mes/cancelar` (zod `{ motivo?: z.string().max(300) }.strict()`) e `/reativar` ao lado de `/pagar` (`routes/financeiro.js:839-878`): mesmo padrão (`MES_RE`, `withTenant`, `invalidateTenant`, `app.audit.log` `financeiro.imposto_cancelar|reativar`, `responderErro`).
  7. Testes (`db.query` mockado por trecho de SQL, padrão `test/financeiro_caixa_corte.test.js`): cancelar imposto virtual materializa com `valor_pago 0` e devolve status `cancelado`; reativar apaga/limpa; pagar cancelado → 409; `/dre/mes` traz `caixa` (com e sem corte); item de apresentadora com `cancelado_em` sai do previsto (`addPrCusto`) e do `a_pagar` do painel.
- verificação: `npx vitest run test/financeiro_agregador.test.js test/financeiro_dre_classe.test.js test/financeiro_caixa_corte.test.js test/financeiro_imposto_cancelar.test.js test/financeiro_painel.test.js test/financeiro_perdas_agregacao.test.js`; com `TEST_PG_URL`: criar `test/financeiro_imposto_cancelar.pg.test.js` (owned aqui; não editar `financeiro_perdas_agregacao.pg.test.js`) cobrindo cancelar → `/dre/mes` sem o imposto no previsto → reativar → `pagarImposto`.

### WP-B — Cancelamento de pagamento de apresentadora (back)
- owns: `src/services/apresentadoras-pagamentos.js`, `src/routes/financeiro_apresentadoras_pagamentos.js`, `src/services/conciliacao.js`, `test/financeiro_apresentadoras_pagamentos.test.js`, `test/financeiro_apresentadoras_pagamentos.pg.test.js`, `test/conciliacao_baixa.test.js`, `test/api_key_financeiro.test.js` (só se o shape mudar)
- deps: WP0 (colunas)
- passos (adaptar o diff v1 `git -C /Users/lucas/Livelab-back-fin show backup/financeiro-ajustes-out-v1 -- src/services/apresentadoras-pagamentos.js src/routes/financeiro_apresentadoras_pagamentos.js`, trocando `perdido_*`→`cancelado_*`, `perder`→`cancelar`, `PERDA_INVALIDA`→`CANCELAMENTO_INVALIDO` 409, e sem `aplicarPerda`/`valor_perdido`):
  1. SELECT de `pagos` (`:95`) + `cancelado_em, cancelado_motivo, cancelado_por`; `montar()` (`:105`): `if (previsto <= 0 && !pg) return` continua, `pg` cancelado conta como existente; item recebe `cancelado_*` (`timestampIso`), `divergente` só se `!cancelado_em`; o status/encerramento é fechado em `normalizarApresentadora` (WP-A) — aqui basta `statusLancamento` como hoje.
  2. `cancelarPagamentoApresentadora(db,{tenantId,apresentadoraId,mes,componente,motivo,actorUserId})`: valida apresentadora (404 → null), previsto via `buscarFechamentoApresentadoras` + `previstoDoComponente`; previsto ≤ 0 ou pago ≥ previsto → erro `CANCELAMENTO_INVALIDO` (409); `INSERT … (valor_pago 0, data_pagamento NULL, cancelado_em NOW(), cancelado_motivo normalizarMotivo, cancelado_por) ON CONFLICT (tenant_id, apresentadora_id, competencia, componente) DO UPDATE SET cancelado_em = COALESCE(ap.cancelado_em, NOW()), cancelado_motivo = …, cancelado_por = …`; devolve o item via `listarPagamentosApresentadoras` do mês.
  3. `reativarPagamentoApresentadora`: `DELETE … WHERE cancelado_em IS NOT NULL AND COALESCE(valor_pago,0) = 0`, senão `UPDATE cancelado_* = NULL`; nada → null (404).
  4. `registrarPagamentoApresentadora` (`:152`): antes do upsert, `SELECT cancelado_em` → se preenchido lança erro 409 `CUSTO_CANCELADO` (decisão 2). `desfazerPagamentoApresentadora` (`:176`): se linha cancelada, `UPDATE valor_pago = 0, data_pagamento = NULL` e retorna true; senão `DELETE` como hoje.
  5. Rotas `/:apresentadora_id/:mes/:componente/cancelar|reativar` com `validarParams` (`:79`), `auditar` (`financeiro.apresentadora_cancelar|reativar`), `invalidateTenant`; mapear `err.code === 'CANCELAMENTO_INVALIDO'|'CUSTO_CANCELADO'` → 409 (hoje `pagar` só trata `TypeError`, `:107`).
  6. `conciliacao.js` `baixarApresentadora` (`:390-398`): `SELECT id, valor_pago, cancelado_em … FOR UPDATE`; `if (ex.rows[0]?.cancelado_em) throw encerradoErro('custo')` (helper já existe `:286`).
  7. Testes: unit (fakeDb por trecho de SQL já existente) para cancelar virtual/parcial/pago (409), reativar apaga vs limpa, pagar cancelado 409, desfazer em cancelado; `conciliacao_baixa.test.js`: alvo apresentadora cancelado → 409 `ALVO_CANCELADO`. pg: estender `financeiro_apresentadoras_pagamentos.pg.test.js` reaplicando `migrations/174_*.sql` ×2 e cobrindo cancelar → listar (status `cancelado`, `virtual false`) → reativar → linha sumiu.
- verificação: `npx vitest run test/financeiro_apresentadoras_pagamentos.test.js test/conciliacao_baixa.test.js test/conciliacao.test.js test/api_key_financeiro.test.js`; com `TEST_PG_URL`: `npx vitest run test/financeiro_apresentadoras_pagamentos.pg.test.js`.

### WP-C — Ciclo de vida de cliente/marca + invalidação de cache em cadastros (back)
- owns: `src/lib/marca-lifecycle-sql.js` (novo), `src/routes/clientes.js`, `src/services/client-brand.js`, `src/routes/marcas.js`, `src/routes/usuarios.js`, `src/routes/apresentadoras.js`, `test/clientes_cancelar_data_fim.test.js` (novo, da v1), `test/marcas_data_fim_ciclo.test.js` (novo, da v1), `test/clientes_lifecycle.test.js`
- deps: nenhuma (migration 175 é só backfill)
- passos:
  1. `marca-lifecycle-sql.js`: exportar `HOJE_SP_SQL`, `DATA_FIM_ENCERRAMENTO_SQL`, `DATA_FIM_REATIVACAO_SQL` (texto do hunk v1 em `marca-sql.js:31-36`).
  2. Aplicar o diff v1 de `clientes.js`, `client-brand.js`, `marcas.js` (`git -C /Users/lucas/Livelab-back-fin show backup/financeiro-ajustes-out-v1 -- <arquivos>`; aplica limpo) trocando o import para `../lib/marca-lifecycle-sql.js`. Inclui: `data_fim` ao cancelar/arquivar (`clientes.js:666-676`), DELETE de `receita_titulos` futuros `valor_pago = 0 AND perdido_em IS NULL` (coluna igual à da prod), `aviso: 'data_fim_expirada'`, `DELETE /v1/marcas/:id` (`:834`) e `PATCH /v1/marcas/:id` (`:742-828`) com o mesmo helper.
  3. Cache: `clientes.js` PATCH `/v1/clientes/:id` (`:567`) chama `invalidateTenant(tenant_id)` após a transação (import de `../lib/dashboard-cache.js`); em `marcas.js` trocar `invalidateTenant(tenant_id, LISTAGEM_NAMESPACES)` por `invalidateTenant(tenant_id)` nas rotas que mudam status/datas/condições (`:467,528,561,809`) — receita e DRE derivam de marcas; manter `LISTAGEM_NAMESPACES` exportado (outros módulos importam).
  4. `usuarios.js` `PATCH /v1/usuarios/:id` (`:348`) e `DELETE /v1/usuarios/:id` (`:762`), `apresentadoras.js` `PATCH /v1/apresentadoras/:id` (`:276`) e `DELETE` (`:392`): `invalidateTenant(request.user.tenant_id)` após sucesso (fixo muda custos fixos/DRE/painel).
  5. Testes v1 (`test/clientes_cancelar_data_fim.test.js`, `test/marcas_data_fim_ciclo.test.js`) + asserção de que o SQL emitido não referencia `marca-sql.js`; em `clientes_lifecycle.test.js` manter o ajuste da v1.
- verificação: `npx vitest run test/clientes_cancelar_data_fim.test.js test/marcas_data_fim_ciclo.test.js test/clientes_lifecycle.test.js test/financeiro_cliente_identity.test.js test/clientes_nome_marca_sync.test.js test/apresentadoras_permissions.test.js test/apresentadora_fixo_historico.test.js`.

### WP-D — SQL de receita: filtro de status, janela de comissão, config da condição (back)
- owns: `src/lib/receita-marca-sql.js`, `src/lib/marca-sql.js`, `src/lib/marca-condicoes.js`, `src/services/marca-condicoes.js`, `src/services/receitas-comercial.js`, `test/receita_comissao_janela.test.js` (novo, v1), `test/marcas_condicoes_vencimento.test.js` (novo, v1), `test/financeiro_receitas.test.js`, `test/financeiro_receitas_mensal.test.js`, `test/financeiro_comissao_inline.test.js`, `test/marcas_comercial_config.test.js`
- deps: WP0 (coluna 176)
- passos:
  1. `git -C /Users/lucas/Livelab-back-fin format-patch -1 backup/financeiro-ajustes-out-v1 --stdout | git apply --include='src/lib/receita-marca-sql.js' --include='src/lib/marca-sql.js' --include='src/lib/marca-condicoes.js' --include='src/services/marca-condicoes.js'` (confirmado limpo). **Remover** de `marca-sql.js` as 3 constantes de `data_fim` que o patch adiciona (vivem em `marca-lifecycle-sql.js`, WP-C).
  2. `receitas-comercial.js` `montarReceitaMensal` (`:591-650`): em `marcaDe()` (criação do objeto da marca, ~`:620-633`) acrescentar `janela_inicio_dia: Number(src?.comissao_janela_inicio_dia ?? 1)` onde `src` é a linha (`linhasMarca`) ou a vigente (`marcasVigentes`) — único hunk da v1 ainda necessário (os de `perdido` já estão na prod). Vencimento da comissão já usa `comissao_vencimento_dia/offset` (`:152,639`).
  3. Testes v1 (`receita_comissao_janela.test.js`: SQL contém `make_interval(days => … comissao_janela_inicio_dia - 1)`, range `$2::date + 27`, filtro por competência, `m.status = 'ativa'` em `marcasCondicaoVigenteMesSql`, filtro `status NOT IN ('inativa','arquivada') OR data_fim IS NOT NULL` em `marcaFixoVigenciaSql`; `calcularReceitasComerciais` com `comissao_janela_inicio_dia 16` + `comissao_vencimento_dia 20` → vencimento 20/out para competência set; schema rejeita 0 e 29; `marcas_condicoes_vencimento.test.js`: `JANELA_RETROATIVA` quando há títulos, aceita sem títulos). Corrigir `expect` de string SQL em `financeiro_receitas*.test.js` se quebrarem.
- verificação: `npx vitest run test/receita_comissao_janela.test.js test/marcas_condicoes_vencimento.test.js test/financeiro_receitas.test.js test/financeiro_receitas_mensal.test.js test/financeiro_comissao_inline.test.js test/marcas_comercial_config.test.js`; com `TEST_PG_URL`: `npx vitest run test/financeiro_receitas.pg.test.js test/financeiro_receitas_mensal.pg.test.js` (reaplicar `migrations/176_*.sql` no `beforeAll` se o fixture não roda `apply_migrations`).

### WP-E1 — Front: tipos/utils/serviços de perda para apresentadora e imposto + saldo_previsto + helper de invalidação
- owns: `src/utils/financeiro.ts`, `src/utils/financeiro.test.ts`, `src/types/financeiro.ts`, `src/services/financeiro.ts`, `src/hooks/useFinanceiro.ts`, `src/components/financeiro/PerdaModal.tsx`, `src/components/financeiro/LancamentosList.tsx`, `src/components/financeiro/CustosCommon.tsx`
- deps: nenhuma
- passos:
  1. `totalizar` (`utils/financeiro.ts:286-313`) e `normalizarLancamentosResponse` (`:330-345`): decisão 5 (desconta `aportes`); ajustar `financeiro.test.ts`.
  2. `acoesPerda` (`:497-514`): apresentadora e imposto → `podeCancelar = status ∉ {pago, cancelado}`, `podeDesfazer = status === 'cancelado'` (aporte continua sem ação). `rotaPerda` (`:519-526`): ramos apresentadora (`/financeiro/apresentadoras-pagamentos/${ap}/${mes}/${comp}/cancelar|reativar`, reaproveitar o parse de id de `rotaBaixa :464-473`) e imposto (`/financeiro/impostos/${mes}/cancelar|reativar`). `normalizarLancamento` (`:237`): já copia `cancelado_*`? conferir e garantir para `origem` apresentadora/imposto.
  3. `PerdaModal.tsx` `TEXTOS.cancelar`: título/efeito neutros para servir custo, pagamento de apresentadora e imposto ("Cancelar lançamento?" / "Sai do a pagar e do previsto do mês; o registro fica com o motivo. Dá para reativar."), CTA por origem via prop opcional.
  4. `LancamentosList.tsx` `acaoPerdaMenu` (`:50-61`) e `CustosCommon.tsx`: garantir que linhas de apresentadora/imposto renderizam `RowMenu` com a ação (hoje `RowMenu` só aparece onde há editar/excluir — ver `:199`); `StatusChip` já conhece `cancelado`.
  5. `hooks/useFinanceiro.ts`: exportar `invalidateFinanceiro(client)` e usar em `useInvalidateFinanceiro` (`:88-96`) — patch v1 aplica limpo.
- verificação: `npm run typecheck && npx vitest run src/utils/financeiro.test.ts src/components/financeiro/PainelMes.render.test.tsx`.

### WP-E2 — Front: header fixo, Caixa no DRE, fluxo somente leitura, hint da aba Comissões
- owns: `src/pages/FinanceiroPage.tsx`, `src/components/financeiro/DrePanel.tsx`, `src/components/financeiro/DrePanel.render.test.tsx`, `src/components/financeiro/DreMesInline.tsx`, `src/components/financeiro/FluxoCaixaPanel.tsx`, `src/types/financeiro-dre.ts`, `src/utils/dre-detalhe.ts`, `src/utils/dre-detalhe.test.ts`, `src/utils/caixa.ts`, `src/utils/caixa.test.ts`
- deps: nenhuma (campos novos opcionais com fallback)
- passos:
  1. Header (`FinanceiroPage.tsx:160-162,176-190`): remover `mostraNovaReceita/mostraNovoCusto`; sempre `MonthSwitcher · Nova receita · Novo custo` (gated por `podeEscrever`) `· Configurar ▾` com itens "Imposto (x%)" e "Caixa (abertura e corte)" — reaproveitar `ConfigurarMenu` da v1 (`git -C /Users/lucas/Livelab-Front-fin show backup/financeiro-ajustes-out-v1 -- react-app/src/pages/FinanceiroPage.tsx`). Hint (b) do item 7 sob "Receita calculada por marca" (`:258-261`): "GMV por mês civil; marcas com janela de apuração aparecem na aba Receita pela competência da janela".
  2. `types/financeiro-dre.ts` + `dre-detalhe.ts` `normalizarDreMesDetalhe` (`:314`): `caixa?: { saldo_inicio_mes; saldo_abertura; data_corte: string|null; origem }` (ausente → null). `DreMesInline.tsx`: seção "Caixa" (saldo no início do mês; se `data_corte` cai no mês: "abertura em DD/MM/AAAA: R$ X"; "fora do DRE"). `DrePanel.tsx`: linha informativa "Saldo de caixa no início" quando `useFinanceiroConfig().data?.data_corte` está no ano (não entra nas colunas/totais).
  3. `FluxoCaixaPanel.tsx:88-92,141-150`: com `data_corte` (via `useFinanceiroConfig`) o campo vira texto somente leitura com o `saldo_inicial` devolvido pelo backend e link "vem do Caixa · configurar" (prop `onConfigurarCaixa`, como na v1); sem corte, editável como hoje.
- verificação: `npm run typecheck && npx vitest run src/utils/dre-detalhe.test.ts src/utils/caixa.test.ts src/components/financeiro/DrePanel.render.test.tsx`.

### WP-G — Front: invalidação após editar apresentadora
- owns: `src/pages/SettingsUsuariosPanel.tsx`
- deps: WP-E1 (`invalidateFinanceiro`)
- passos: patch v1 aplica limpo (`git apply --include='react-app/src/pages/SettingsUsuariosPanel.tsx'`): `invalidateFinanceiro(client)` em `inviteMutation`, `updateMutation`, `updatePresenterMutation`, `deleteMutation`, `deletePresenterMutation`, `editMutation` (`:141-236`).
- verificação: `npm run typecheck`.

### WP-H — Front: janela de comissão na condição + hint na Receita + aviso de reativação
- owns: `src/components/comercial/CondicoesComerciaisPanel.tsx`, `src/components/comercial/CondicoesComerciais.tsx`, `src/components/comercial/CondicoesComerciais.test.ts`, `src/utils/condicoes-vencimento.ts`, `src/utils/condicoes-vencimento.test.ts`, `src/pages/ComercialPage.tsx`, `src/types/financeiro-receita.ts`, `src/utils/receita-mensal.ts`, `src/utils/receita-mensal.test.ts`, `src/components/financeiro/ReceitaPanel.tsx`, `src/components/financeiro/ReceitaPanel.render.test.tsx`
- deps: nenhuma
- passos:
  1. Patch v1 aplica limpo em `CondicoesComerciais*`, `condicoes-vencimento*`, `ComercialPage.tsx` (campo "Apuração começa no dia" 1..28 com preview "16/set → 15/out · competência set · vence 20/out"; payload de create/patch; resumo vigente; toast do `aviso: 'data_fim_expirada'`).
  2. `types/financeiro-receita.ts` `ReceitaMarca` + `janela_inicio_dia: number`; `receita-mensal.ts` normalizador da marca (`:195-213`) lê `raw.janela_inicio_dia ?? 1`; `ReceitaPanel.tsx` na linha da marca com `janela_inicio_dia !== 1`: hint de 1 linha "Janela 16→15 · competência = mês de início · GMV da aba Comissões é por mês civil". Testes nos dois `*.test.ts`.
- verificação: `npm run typecheck && npx vitest run src/components/comercial/CondicoesComerciais.test.ts src/utils/condicoes-vencimento.test.ts src/utils/receita-mensal.test.ts src/components/financeiro/ReceitaPanel.render.test.tsx`.

### WP-I — Docs (back) — por último
- owns: `docs/financeiro.md`, `docs/api-automacao.md`
- deps: WP-A, WP-B, WP-C, WP-D
- passos: §3 status (acrescentar `perdido|cancelado` e precedência real de `lancamento-status.js:22-36`); §5 apresentadora (cancelamento, rotas novas, `data_pagamento` nullable); §6 imposto (cancelar/reativar); §7 catálogo (linhas novas: `/impostos/:mes/cancelar|reativar`, `…/:componente/cancelar|reativar`, `aviso` em clientes/marcas, `comissao_janela_inicio_dia`, `JANELA_RETROATIVA`); §1 marcas (data_fim no ciclo de vida, filtro de status na Receita, janela de apuração); "Verificação das rotas" com os sufixos novos. `api-automacao.md`: se a allowlist da API key lista rotas, incluir as novas.
- verificação: `grep -rn "/cancelar\|/reativar" src/routes | wc -l` bate com o catálogo; `npx vitest run test/api_key_financeiro.test.js`.

### Ordem
1. WP0 (curto). 2. Em paralelo: WP-A, WP-B, WP-C, WP-D (back) e WP-E1, WP-E2, WP-H (front). 3. WP-G após WP-E1; WP-I após o back. 4. Gate: back `npx vitest run` (+ `TEST_PG_URL=… npx vitest run test/*.pg.test.js`); front `npm run typecheck && npm run test && npm run build`.

### Fora de escopo / follow-ups
- Conferência manual do "aporte em dobro" (SQL em v1 §1) antes do deploy.
- Dado: Pure Up / Popô Baby → `comissao_janela_inicio_dia = 16, comissao_vencimento_dia = 20, comissao_vencimento_mes_offset = 1` numa nova versão de condição (não é código).
- `/resumo` por janela de comissão e CLI `livelab.py` mostrando cancelados.
