# Financeiro — regras e rotas

Documentação gerada a partir do código (não de especificação). Datas civis em `YYYY-MM-DD` / `YYYY-MM`, fuso operacional `America/Sao_Paulo`. Status de lançamento **nunca** é persistido.

Permissões: `READ_FINANCEIRO` (GET) e `WRITE_FINANCEIRO` (POST/PATCH/DELETE), definidos em `src/config/role_groups.js`. Plugins registrados em `src/app.js`.

---

## 1. Fonte da receita (comercial, marcas, contratos, condições)

O financeiro **não calcula** a regra comercial. Consome títulos virtuais + materializados:

| Papel | Onde |
| --- | --- |
| SQL compartilhado (fixo + comissão + condição vigente) | `src/lib/receita-marca-sql.js` |
| Títulos a receber, baixa, competência × vencimento | `src/services/receitas-comercial.js` |
| HTTP | `src/routes/financeiro_receitas.js` |
| Avulsas (fora de marca; grupo `aporte` não entra no DRE nem na base do imposto) | `src/services/receitas-avulsas.js` |

### Marcas e condições

Fonte única: `marca_condicoes_comerciais` vigente no mês da competência (não cancelada; maior `inicio_vigencia` ≤ 1º dia do mês), com fallback nos campos da marca (`valor_fixo_minimo`, `tipo_cobranca`, `comissao_franquia_pct`). Só marcas `tipo = 'cliente'` e `sistema IS NOT TRUE`.

Dois componentes por marca × competência (quando valor > 0):

1. **Fixo** — por **vigência** (padrão): cobrado em todo mês entre o início efetivo do contrato e `marcas.data_fim`, com ou sem atividade, rateado por dias no mês de entrada/saída (`prorateFatorSql` em `src/lib/financeiro-remuneracao.js`). Início efetivo (`inicioContratoSql`): `marcas.data_inicio` → primeira condição real (`inicio_vigencia > 1900-01-01`) → mês de `criado_em` em São Paulo.
2. **Comissão de franquia** — GMV × `%` da condição vigente na data do fato:
   - lives `encerrada`, ativas, não arquivadas, GMV inline;
   - vídeos via `vendas_atribuidas` (`origem = 'video'`, não `reprovada`).

`tipo_cobranca`:

- `fixo_mais_comissao` (default) — soma fixo + comissão.
- `fixo_ou_comissao` — total = `GREATEST(fixo, comissão)`. Nos **títulos** isso vira fixo (piso) + comissão só do excedente (`comporReceitaMarca`). Em `/resumo` e `/operacional` o total é o mesmo; `/operacional` emite **uma** linha vencedora.

Vencimento do título: dia/offset da condição (`fixo_vencimento_*` / `comissao_vencimento_*`). Default no SQL: dia **5**, `mes_offset` **1** (dia 5 do mês seguinte). Dia maior que o último dia do mês vira o último dia.

**Ciclo de vida (cliente/marca → receita).** Cancelar (`inativa`) ou arquivar o cliente (`PATCH /v1/clientes/:id`) e arquivar/inativar/apagar a marca (`PATCH`/`DELETE /v1/marcas/:id`) gravam `marcas.data_fim = LEAST(COALESCE(data_fim, hoje_SP), hoje_SP)` (helpers em `src/lib/marca-lifecycle-sql.js`; hoje em `America/Sao_Paulo`) e, no caso do cliente, apagam os `receita_titulos` materializados com `valor_pago = 0`, `perdido_em IS NULL` e competência **posterior** ao mês de `data_fim` (o mês de `data_fim` fica; pro-rata no fixo). Reativar (`status` ativo/`ativa`) limpa `data_fim` só se for ≥ hoje; `data_fim` já vencida é mantida e a resposta traz `aviso: 'data_fim_expirada'` (a UI pede ajuste de datas). A migration 175 faz o backfill de `data_fim` das marcas já inativas/arquivadas (pelo `audit_log`, fallback `atualizado_em` em fuso SP; só onde `data_fim IS NULL`). Essas escritas e as de condição invalidam o cache do tenant inteiro (`invalidateTenant(tenant_id)`).

**Filtro de status na Receita.** `marcaFixoVigenciaSql` só inclui marca `inativa`/`arquivada` se tiver `data_fim` (senão deixaria de ser cobrada sem data de saída) e `marcasCondicaoVigenteMesSql` exige `m.status = 'ativa'` — cliente cancelado/arquivado não gera fixo nem comissão depois do fim.

**Janela de apuração da comissão.** A condição comercial tem `comissao_janela_inicio_dia` (SMALLINT 1..28, default 1 = mês civil; migration 176, CHECK `marca_condicoes_comissao_janela_check`). Com `N > 1` a janela da competência `M` vai de `N/M` até `N−1` do mês seguinte (ex.: 16/set → 15/out = competência set) e o vencimento segue `comissao_vencimento_dia/mes_offset` (ex.: dia 20, offset 1 → 20/out). Em `GET /v1/financeiro/receita` cada marca traz `janela_inicio_dia` (1 = mês civil). Mudar a janela de uma versão que já tem títulos materializados é recusado: `PATCH /v1/marcas/:id/condicoes/:condicaoId/vencimento` → 400 `JANELA_RETROATIVA` (crie nova versão de condição). `/resumo` continua por mês civil.

Títulos: calculados (`id` virtual `calc:<marca_id>:<YYYY-MM>:<fixo|comissao>`) ou materializados em `receita_titulos` (baixa / `POST .../gerar`).

### Contratos formais vs datas de contrato da marca

O financeiro comercial **não lê** a tabela `contratos`. `src/routes/contratos.js` (entidade formal: `valor_fixo`, `comissao_pct`, status/auditoria) é fluxo separado (cadastro, aprovação, dashboards de cliente). A janela de cobrança do DRE/títulos usa **datas na marca** (`data_inicio` / `data_fim`) + condição vigente, não `contratos.valor_fixo`.

A CONFIRMAR: jobs de billing/gateway que ainda leiam `contratos.valor_fixo` ficam fora deste documento (`/v1/financeiro/*` não os chama).

---

## 2. Data de corte e saldo de abertura do caixa

Campos do tenant (`buscarConfigFinanceiro` / PATCH `/v1/financeiro/config`):

| Campo | Coluna | Significado |
| --- | --- | --- |
| `data_corte` | `tenants.financeiro_data_corte` | Início do financeiro. Sem corte, a regra não filtra nada. |
| `saldo_abertura` | `tenants.financeiro_saldo_abertura` | Saldo na data de corte (antes dos movimentos do próprio dia). |
| `aliquota_imposto_pct` | `tenants.aliquota_imposto_pct` | Ver §6. Default **10** se NULL. |

**Corte** (`dentroDoCorte` em `src/services/financeiro-agregador.js`): item com data efetiva **anterior** a `data_corte` some de lançamentos, DRE, fluxo, totais e imposto.

Data efetiva: `data_pagamento` se `valor_pago > 0`; senão vencimento (sem vencimento → último dia da competência).

**Caixa** (`calcularCaixa`):

- Sem `data_corte`: `configurado: false`, saldos zerados.
- Com corte: `saldo_atual = saldo_abertura + entradas − saídas` realizadas em `[data_corte, ate]` (default `ate` = hoje SP).
- Entradas: `receita_titulos` + avulsas (inclui `aporte`). Saídas: custos (exceto a linha de imposto duplicada) + `apresentadora_pagamentos` + imposto materializado.
- `saldoCaixaInicioMes`: abertura + realizado `[corte, dia anterior ao dia 1 do mês]`. Mês < mês do corte → 0.

Fluxo de caixa sem `saldo_inicial`: usa o saldo de caixa no início do mês se houver corte; senão 0. Com `data_corte` configurada a UI mostra esse saldo inicial como somente leitura (vem do Caixa).

`GET /v1/financeiro/dre/mes` devolve, fora de `atual/anterior/resultado`, o bloco informativo `caixa: { saldo_inicio_mes, saldo_abertura, data_corte, origem }` (`origem = 'caixa'` com corte, via `saldoCaixaInicioMes`; sem corte `0/0/null/'padrao'`). Não entra nas colunas nem nos totais do DRE.

---

## 3. Status derivado de lançamento

`src/lib/lancamento-status.js` — `statusLancamento({ valor_previsto, valor_pago, data_vencimento }, hoje)`.

Valores (`STATUS_LANCAMENTO`): `previsto | pendente | atrasado | parcial | pago | perdido | cancelado`. `perdido` e `cancelado` formam `STATUS_ENCERRADOS`.

Ordem real da função (não há status gravado; a entrada também recebe `perdido_em` e `cancelado_em`):

1. `pago` — `valor_pago > 0` e `valor_pago >= valor_previsto` (pagamento integral vence qualquer marca de perda/cancelamento).
2. `perdido` — `perdido_em` preenchido (receita que não será recebida).
3. `cancelado` — `cancelado_em` preenchido (custo, pagamento de apresentadora ou imposto que não será pago).
4. Com pagamento parcial (`0 < valor_pago < valor_previsto`): `atrasado` se `data_vencimento < hoje`; senão `parcial`.
5. Sem pagamento: `atrasado` se vencido; `pendente` se não há vencimento; `previsto` se o **mês** do vencimento é futuro; senão `pendente`.

**Encerrados** (`perdido`/`cancelado`): saldo em aberto = 0 — saem de a receber/a pagar, do caixa projetado, do fluxo, de pendente/atrasado, da base do imposto e da conciliação; no DRE a receita perdida aparece em coluna própria e o custo cancelado sai do previsto. Parcial + encerrado: o pago fica, só o saldo (`previsto − pago`) é encerrado. Pagar/conciliar item encerrado → 409 (`RECEITA_PERDIDA`, `CUSTO_CANCELADO`, `ALVO_PERDIDO`, `ALVO_CANCELADO`); é preciso reativar antes. Motivo opcional ≤ 300 caracteres (CHECK no banco).

**`saldo_previsto` / `saldo_realizado`** (`totais` de `GET /lancamentos`): `saldo_previsto = (receita.previsto − receita.perdido − aportes.previsto) − (custo.previsto − custo.cancelado)`; `saldo_realizado = (receita.pago − aportes.pago) − custo.pago`. Aporte não é receita do DRE, então `saldo_previsto` é igual ao `resultado.previsto` de `/dre/mes` do mesmo mês.

`hoje` e vencimento são strings `YYYY-MM-DD` (sem conversão de fuso).

---

## 4. Classes de custo

`src/lib/custo-classe.js` — `classeDoItem`. Receita → `null`. Imposto → sempre `variavel` (sem override).

1. Override: `item.classe_custo` ou, na falta, `item.classe_custo_recorrente` (`fixo` \| `variavel`).
2. Senão, pela origem:
   - `fixo` — `recorrente` \| `parcela` \| apresentadora com `componente === 'fixo'`
   - `variavel` — pontual/manual, apresentadora variável (ou sem componente, contrato antigo), imposto

DRE/lançamentos (`montarDre`) usam esta função. `/operacional` ainda classifica custos manuais por tipo legado (`aluguel|salario|energia|internet`) e grupos `estrutural|prolabore` (`custoManualFixo` em `src/routes/financeiro.js`) — não é `classeDoItem`.

Grupos de custo manual: `operacional`, `estrutural`, `diversos`, `investimento`, `prolabore`, `marketing`, `ferramentas`, `cartao`, `aporte`, `outros` (`GRUPOS_CUSTO`).

---

## 5. Pagamentos de apresentadora

`src/services/apresentadoras-pagamentos.js`. Previsto vem do fechamento (`buscarFechamentoApresentadoras`) — não é reimplementado no financeiro.

Dois lançamentos por pessoa × mês (quando há valor ou baixa):

| Componente | Previsto | Vencimento padrão (`VENCIMENTO_PADRAO`) |
| --- | --- | --- |
| `fixo` | `fixo` do fechamento | dia **10** do **próprio** mês (`mes_offset: 0`) |
| `variavel` | `comissao + adicionais` | dia **15** do **mês seguinte** (`mes_offset: 1`) |

Tenant pode sobrescrever via `GET/PATCH /v1/financeiro/apresentadoras-pagamentos/config` (`tenants.apresentadoras_*_vencimento_*`). Dia > último dia do mês → último dia.

Baixa em `apresentadora_pagamentos`, upsert por `(tenant, apresentadora, competência, componente)`. Id virtual: `apresentadora:<uuid>:<YYYY-MM>:<componente>`.

Rotas legadas sem `:componente` equivalem a **`fixo`** (header `Deprecation: true`).

**Cancelamento** (migration 174): `apresentadora_pagamentos` ganha `cancelado_em`, `cancelado_motivo` (CHECK ≤ 300) e `cancelado_por`; `data_pagamento` passou a aceitar NULL (linha cancelada sem baixa = `valor_pago 0`, `data_pagamento NULL`).

- `cancelar` materializa a linha (upsert; reaplicar mantém o primeiro `cancelado_em`). Previsto ≤ 0 ou pago ≥ previsto → 409 `CANCELAMENTO_INVALIDO`. Apresentadora inexistente → 404.
- `reativar` apaga a linha se `valor_pago = 0` (volta a ser virtual); com baixa parcial só limpa `cancelado_*`. Sem linha cancelada → 404.
- `pagar` em linha cancelada → 409 `CUSTO_CANCELADO`. `desfazer` em linha cancelada zera a baixa (`valor_pago 0`, `data_pagamento NULL`) e **mantém** o cancelamento.
- Item cancelado: `status = 'cancelado'`, `virtual = false`, `cancelado_*` preenchidos; sai do previsto do DRE e do a pagar.
- Conciliação (`baixarApresentadora`) de linha cancelada → 409 `ALVO_CANCELADO`.

---

## 6. Imposto

`src/services/financeiro-agregador.js`: `ALIQUOTA_IMPOSTO_PADRAO = 10`, `IMPOSTO_DIA_VENCIMENTO = 20`.

- Alíquota: por tenant (`aliquota_imposto_pct`); NULL → 10.
- Competência `M`: base = valor **recebido** no mês **M−1** (data de pagamento), quando M−1 já fechou (M−1 < mês corrente SP).
- Recebido = `receita_titulos` + avulsas com `grupo <> 'aporte'`; corte aplica (`data_pagamento >= data_corte`).
- Se M−1 ainda não fechou: **projeção** = `max(previsto com vencimento em M−1, já recebido)` — nunca menor que o recebido.
- Valor = `base × alíquota / 100`.
- Vencimento: dia **20** de `M` (ou último dia do mês).
- Id virtual `imposto:YYYY-MM`. Baixa materializa 1 linha em `custos` (`tipo = 'imposto'`) por tenant × competência.
- **Cancelar** (`/impostos/:mes/cancelar`, body `{ motivo? ≤ 300 }`): upsert dessa mesma linha com `valor_pago = 0` e `cancelado_em/motivo/por` (reusa as colunas da migration 173); `status = 'cancelado'`, sai do previsto, do a pagar e do caixa projetado. Imposto já pago integralmente → 409 `JA_PAGO`.
- **Reativar** (`/impostos/:mes/reativar`): apaga a linha se `valor_pago = 0` (volta ao cálculo virtual), senão limpa `cancelado_*`.
- `pagar` imposto cancelado → 409 `CUSTO_CANCELADO`; `desfazer` em cancelado zera a baixa e mantém o cancelamento.

---

## 7. Catálogo `/v1/financeiro/*`

Handler = função exportada do plugin + serviço quando o route é fino. Query de período, salvo indicação, em `YYYY-MM`.

### Visão, caixa, imposto, config — `financeiroRoutes` (`src/routes/financeiro.js`)

| Método | Rota | Parâmetros | Handler / serviço |
| --- | --- | --- | --- |
| GET | `/v1/financeiro/resumo` | `inicio`+`fim` (YYYY-MM), ou `mes`+`ano`, ou mês UTC corrente; `scope=unidade\|franqueadora` (só `franqueador_master`) | `financeiroRoutes` → SQL do resumo + `calcularDre` |
| GET | `/v1/financeiro/faturamento` | `periodo` (YYYY-MM) ou `inicio`/`fim`/`mes`+`ano` | `financeiroRoutes` (GMV/comissão por cliente) |
| GET | `/v1/financeiro/fluxo-caixa` | `mes` (ou `inicio`/`fim`/`mes`+`ano` → 1º mês); `saldo_inicial?` | `calcularFluxoCaixa` |
| GET | `/v1/financeiro/operacional` | `inicio`/`fim` ou `periodo` ou `mes`+`ano`; default mês corrente SP (`resolveMonthRange`) | `financeiroRoutes` (lançamentos agregados por entidade) |
| GET | `/v1/financeiro/lancamentos` | período (`resolverPeriodoMeses`); filtros `natureza`, `status`, `grupo`, `classe`, `origem`, `q` | `consultarLancamentos` |
| GET | `/v1/financeiro/dre/mes` | `mes` (default mês corrente SP); resposta inclui `caixa` (§2) | `calcularDreMes` |
| PATCH | `/v1/financeiro/impostos/:mes/pagar` | `:mes` YYYY-MM; body `valor_pago?`, `data_pagamento?`, `observacao?` | `pagarImposto` |
| PATCH | `/v1/financeiro/impostos/:mes/desfazer` | `:mes` YYYY-MM | `desfazerImposto` |
| PATCH | `/v1/financeiro/impostos/:mes/cancelar` | `:mes` YYYY-MM; body `motivo?` (≤ 300); 409 `JA_PAGO`/`CUSTO_CANCELADO` | `cancelarImposto` |
| PATCH | `/v1/financeiro/impostos/:mes/reativar` | `:mes` YYYY-MM | `reativarImposto` |
| GET | `/v1/financeiro/config` | — | `buscarConfigFinanceiro` |
| PATCH | `/v1/financeiro/config` | body parcial: `aliquota_imposto_pct?`, `data_corte?` (nullable), `saldo_abertura?` (ao menos um) | `atualizarConfigFinanceiro` |
| GET | `/v1/financeiro/caixa` | `ate?` YYYY-MM-DD (default hoje SP) | `calcularCaixa` |
| GET | `/v1/financeiro/dre` | `inicio`/`fim` (YYYY-MM; default mês corrente SP) | `calcularDre` (só o DRE por período, sem o bloco legado do `/resumo`) |
| GET | `/v1/financeiro/painel` | `mes` (YYYY-MM; default mês corrente SP; 400 se inválido) | `calcularPainelMes` → `montarPainel` |

**Painel do mês (`/painel`)**: carrega os lançamentos UMA vez na janela `[mês(corte)−2m, mes]` (sem corte: `[mes−2m, mes]`; sem corte, atrasados de competências anteriores à janela não aparecem) e 3 agregados de realizado (`realizadoEntre`). Todos os valores em reais (`r2`). Campos: `mes`, `hoje`, `fim_mes`, `mes_relativo` (`passado|corrente|futuro`), `configurado`, `data_corte`, `saldo_abertura`; `caixa{saldo_atual, ate}` (`ate = min(hoje, fim_mes)`; sem corte: zeros e `configurado=false`); `recebido_mes{total, receitas, aportes}` e `pago_mes{total}` por DATA DE PAGAMENTO no mês inteiro (a partir de `max(1º do mês, corte)`); `a_receber` / `a_pagar` `{no_mes, atrasado_anterior, total, qtd, atrasados{qtd, valor}}` — em aberto (perdido/cancelado = 0) por vencimento efetivo em `[corte, fim_mes]`; `no_mes` = vence no mês, `atrasado_anterior` = vence antes do dia 1, `atrasados` = vence antes de `hoje`; `projetado_fim_mes = caixa.saldo_atual + realizado (ate, fim_mes] + a_receber.total − a_pagar.total` (igual a `saldo_projetado_fim_mes` de `/caixa`); `competencia{receita, custos, resultado}` = DRE por competência do mês, só referência (não é a fonte do "a receber"). **Projeção de comissão** (`projecao_comissao`, `projetado_fim_mes_ritmo`): itens `marca_comissao` da competência do mês corrente, não encerrados e sem pagamento; `projetado = previsto_atual ÷ dia_do_mês × dias_do_mês` (no último dia, = previsto); `vence_em` = maior vencimento dos itens; `entra_no_painel = vence_em ≤ fim_mes`. `projetado_fim_mes_ritmo = projetado_fim_mes + ajuste` só se entra no painel e `ajuste > 0`, senão `null`. A projeção NUNCA entra nos totais reais.

**Cache e invalidação (agregador)**: `/painel`, `/dre`, `/dre/mes`, `/caixa`, `/lancamentos`, `/fluxo-caixa` e o bloco DRE do `/resumo` usam `withCache` (namespace `financeiro:agregador`, TTL 30 s, `FINANCEIRO_AGREGADOR_CACHE_TTL_MS`). Chave = `buildCacheKey(tenant_id, { rota, hoje, ...params })` (`hoje` na chave: o status derivado muda na virada do dia). Qualquer escrita HTTP bem-sucedida invalida o tenant (hook global de `app.js`); os jobs `recalcular_comissoes` e `encerrar_lives_zumbi` chamam `invalidateTenant` após sucesso por tenant. `dashboard-cache.js` mantém um contador de geração por tenant: um compute iniciado antes de uma invalidação não grava no cache nem é reaproveitado por quem chega depois. As leituras usam `app.tenantParallel` (cada query em conexão própria, com `set_config` do tenant) quando disponível; só leitura passa por esse executor.

`origem` em `/lancamentos`: `marca_fixo`, `marca_comissao`, `avulsa`, `manual`, `recorrente`, `parcela`, `apresentadora`, `imposto`.

### Receitas comerciais — `financeiroReceitasRoutes` (`src/routes/financeiro_receitas.js`)

`:id` = UUID materializado ou `calc:<marca_id>:<YYYY-MM>:<fixo|comissao>`.

| Método | Rota | Parâmetros | Serviço |
| --- | --- | --- | --- |
| GET | `/v1/financeiro/receita` | `mes?` (default mês corrente SP); cada marca traz `janela_inicio_dia` (1 = mês civil) | `consultarReceitaMensal` |
| GET | `/v1/financeiro/receitas` | `mes` ou `inicio`/`fim`; `status?`, `componente=fixo\|comissao?`, `marca_id?`, `cliente_id?` | `listarTitulosReceita` |
| POST | `/v1/financeiro/receitas/gerar` | `mes` em query ou body | `gerarTitulosReceita` |
| PATCH | `/v1/financeiro/receitas/:id/receber` | body `valor_pago?`, `data_pagamento?`, `observacao?` | `receberTitulo` |
| PATCH | `/v1/financeiro/receitas/:id/desfazer` | `:id` | `desfazerRecebimento` |
| PATCH | `/v1/financeiro/receitas/:id/perder` | body `motivo?` (≤ 300); 409 se 100% recebido | `perderTitulo` |
| PATCH | `/v1/financeiro/receitas/:id/desperder` | `:id` | `desperderTitulo` |

### Receitas avulsas — `financeiroReceitasAvulsasRoutes` (`src/routes/financeiro_receitas_avulsas.js`)

Grupos: `aporte`, `servico`, `reembolso`, `outros`.

| Método | Rota | Parâmetros | Serviço |
| --- | --- | --- | --- |
| GET | `/v1/financeiro/receitas-avulsas` | `mes` ou `inicio`/`fim`; `grupo?`, `status?` | `listarReceitasAvulsas` |
| POST | `/v1/financeiro/receitas-avulsas` | body: `descricao`, `valor_previsto`, `data_vencimento`, `grupo?`, `competencia?`, `observacao?`, `valor_pago?`, `data_pagamento?` | `criarReceitaAvulsa` |
| PATCH | `/v1/financeiro/receitas-avulsas/:id` | body parcial (descrição/grupo/valores/vencimento/competência/observação) | `editarReceitaAvulsa` |
| DELETE | `/v1/financeiro/receitas-avulsas/:id` | `:id` UUID | `excluirReceitaAvulsa` |
| PATCH | `/v1/financeiro/receitas-avulsas/:id/receber` | body `valor_pago?`, `data_pagamento?` | `receberReceitaAvulsa` |
| PATCH | `/v1/financeiro/receitas-avulsas/:id/desfazer` | `:id` | `desfazerReceitaAvulsa` |
| PATCH | `/v1/financeiro/receitas-avulsas/:id/perder` | body `motivo?` (≤ 300); 409 se 100% recebida | `perderReceitaAvulsa` |
| PATCH | `/v1/financeiro/receitas-avulsas/:id/desperder` | `:id` | `desperderReceitaAvulsa` |

### Custos — `financeiroCustosRoutes` (`src/routes/financeiro_custos.js`)

`:id` de custo aceita UUID ou virtual `rec:<uuid>:<YYYY-MM>` (exceto DELETE, que recusa virtual).

| Método | Rota | Parâmetros | Notas |
| --- | --- | --- | --- |
| GET | `/v1/financeiro/custos` | `mes` ou `inicio`/`fim` | `listarCustos` |
| POST | `/v1/financeiro/custos` | body pontual: `descricao`, `valor`, `grupo?`, `competencia` ou `data_vencimento`, `observacao?`, `valor_pago?`, `data_pagamento?`, `classe_custo?` | tipo gravado `'outros'` |
| POST | `/v1/financeiro/custos/parcelado` | `descricao`, `parcelas` (1–120), `valor_total` **ou** `valor_parcela`, `grupo?` (default `cartao`), competência ou vencimento, `classe_custo?` | |
| POST | `/v1/financeiro/custos/importar` | `recorrentes[]`, `pontuais[]` (máx. 200 cada), `dry_run?` | |
| POST | `/v1/financeiro/custos/gerar` | `mes` query ou body | materializa recorrentes, idempotente |
| PATCH | `/v1/financeiro/custos/:id` | body parcial (descrição, valor, grupo, competência, vencimento, observação, `classe_custo`) | |
| PATCH | `/v1/financeiro/custos/:id/pagar` | body `valor_pago?`, `data_pagamento?` | |
| PATCH | `/v1/financeiro/custos/:id/desfazer` | `:id` | |
| PATCH | `/v1/financeiro/custos/:id/cancelar` | body `motivo?` (≤ 300) | custo que não será pago; sai do previsto e do a pagar |
| PATCH | `/v1/financeiro/custos/:id/reativar` | `:id` | |
| DELETE | `/v1/financeiro/custos/:id` | query `escopo=um\|grupo\|futuras` (default `um`) | `grupo`/`futuras` só com `parcela_grupo_id` |
| GET | `/v1/financeiro/custos-recorrentes` | — | |
| POST | `/v1/financeiro/custos-recorrentes` | `nome`, `valor`, `inicio`, `grupo?`, `dia_vencimento?` (default 5), `mes_offset?` (default 0), `fim?`, `ativo?`, `classe_custo?` | |
| PATCH | `/v1/financeiro/custos-recorrentes/:id` | body parcial dos campos do POST | |
| DELETE | `/v1/financeiro/custos-recorrentes/:id` | `:id` UUID | |

### Fechamento / adicionais — `remuneracaoApresentadorasRoutes` (`src/routes/remuneracao_apresentadoras.js`)

| Método | Rota | Parâmetros | Serviço |
| --- | --- | --- | --- |
| GET | `/v1/financeiro/fechamento-apresentadoras` | `mes` YYYY-MM **obrigatório** | `buscarFechamentoApresentadoras` |
| GET | `/v1/financeiro/fechamento-apresentadoras/:id/detalhes` | `:id` apresentadora; query `mes` | `buscarHistoricoLivesApresentadora` |
| POST | `/v1/financeiro/adicionais-apresentadoras` | body: `mes`, `apresentadora_id`, `tipo=fim_de_semana\|bonificacao`, `descricao`, `data_referencia?`, `valor?` (bonificação), `request_id?` | INSERT em `apresentadora_remuneracao_adicionais` (diária FDS = R$ 100) |
| DELETE | `/v1/financeiro/adicionais-apresentadoras/:id` | `:id` UUID | soft-cancel (`cancelado_em`) |

### Pagamentos apresentadora — `financeiroApresentadorasPagamentosRoutes` (`src/routes/financeiro_apresentadoras_pagamentos.js`)

Registro com `const BASE = '/v1/financeiro/apresentadoras-pagamentos'` e `` `${BASE}/...` ``. `grep -rn "/v1/financeiro/apresentadoras-pagamentos" src/routes` encontra o módulo; sufixos abaixo estão no mesmo arquivo.

| Método | Rota HTTP | Parâmetros | Handler |
| --- | --- | --- | --- |
| GET | `/v1/financeiro/apresentadoras-pagamentos` | `mes=YYYY-MM` **ou** `inicio`+`fim` (YYYY-MM-DD) | `listarPagamentosApresentadoras` |
| GET | `/v1/financeiro/apresentadoras-pagamentos/config` | — | `buscarConfigVencimento` |
| PATCH | `/v1/financeiro/apresentadoras-pagamentos/config` | `{ fixo?: {dia, mes_offset}, variavel?: {dia, mes_offset} }`; plano `{dia, mes_offset}` (deprecado) aplica ao fixo | `atualizarConfigVencimento` |
| PATCH | `.../:apresentadora_id/:mes/:componente/pagar` | `componente=fixo\|variavel`; body `valor_pago?`, `data_pagamento?`, `observacao?` | `pagar` → `registrarPagamentoApresentadora` |
| PATCH | `.../:apresentadora_id/:mes/:componente/desfazer` | idem | `desfazer` → `desfazerPagamentoApresentadora` |
| PATCH | `.../:apresentadora_id/:mes/:componente/cancelar` | idem; body `motivo?` (≤ 300); 409 `CANCELAMENTO_INVALIDO`/`CUSTO_CANCELADO` | `cancelar` → `cancelarPagamentoApresentadora` |
| PATCH | `.../:apresentadora_id/:mes/:componente/reativar` | idem; 404 se nunca cancelado | `reativar` → `reativarPagamentoApresentadora` |
| PATCH | `.../:apresentadora_id/:mes/pagar` | legado = componente `fixo` | `pagar` |
| PATCH | `.../:apresentadora_id/:mes/desfazer` | legado = componente `fixo` | `desfazer` |

### Fora de `/v1/financeiro/*` que alteram a receita

| Método | Rota | Efeito no financeiro |
| --- | --- | --- |
| PATCH | `/v1/clientes/:id` | `status` cancelado/arquivado → marca com `data_fim` e títulos futuros não tocados apagados; `status` ativo → reativa a marca; resposta pode trazer `aviso: 'data_fim_expirada'` (§1). Invalida o cache do tenant |
| PATCH | `/v1/marcas/:id` | `status` `ativa` pode devolver `aviso: 'data_fim_expirada'`; encerrar grava `data_fim` |
| DELETE | `/v1/marcas/:id` | soft: marca vira `inativa` e grava `data_fim` com o mesmo helper (204) |
| POST | `/v1/marcas/:id/condicoes` | aceita `comissao_janela_inicio_dia` (1..28, default 1) |
| PATCH | `/v1/marcas/:id/condicoes/:condicaoId/vencimento` | aceita `comissao_janela_inicio_dia`; 400 `JANELA_RETROATIVA` se a versão já tem títulos |
| PATCH/DELETE | `/v1/usuarios/:id`, `/v1/apresentadoras/:id` | invalidam o cache do tenant (o fixo da apresentadora alimenta custos fixos, DRE e painel) |

`/v1/asaas/*` concilia os mesmos lançamentos e **não** faz parte de `/v1/financeiro/*`.

---

## Verificação das rotas

Cada path literal em `src/routes` deve aparecer com `grep -rn "<rota>" src/routes`. Família `apresentadoras-pagamentos`: grepar o prefixo `/v1/financeiro/apresentadoras-pagamentos` e os sufixos `:apresentadora_id/:mes/:componente/pagar`, `:apresentadora_id/:mes/:componente/desfazer`, `:apresentadora_id/:mes/pagar`, `:apresentadora_id/:mes/desfazer`, `:apresentadora_id/:mes/:componente/cancelar`, `:apresentadora_id/:mes/:componente/reativar` e `` `${BASE}/config` ``. Cancelamento/perda: `grep -rn "/cancelar\|/reativar" src/routes` encontra `/v1/financeiro/custos/:id/cancelar|reativar` (`financeiro_custos.js`), `/v1/financeiro/impostos/:mes/cancelar|reativar` (`financeiro.js`) e os dois sufixos de apresentadora acima (`financeiro_apresentadoras_pagamentos.js`); `/v1/contratos/:id/cancelar` é outro fluxo. Receitas: `grep -rn "/perder\|/desperder" src/routes`.
