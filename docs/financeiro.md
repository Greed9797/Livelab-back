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

Fluxo de caixa sem `saldo_inicial`: usa o saldo de caixa no início do mês se houver corte; senão 0.

---

## 3. Status derivado de lançamento

`src/lib/lancamento-status.js` — `statusLancamento({ valor_previsto, valor_pago, data_vencimento }, hoje)`.

Valores: `previsto | pendente | atrasado | parcial | pago`.

Ordem real da função (não há status gravado):

1. `pago` — `valor_pago > 0` e `valor_pago >= valor_previsto`.
2. Com pagamento parcial (`0 < valor_pago < valor_previsto`): `atrasado` se `data_vencimento < hoje`; senão `parcial`.
3. Sem pagamento: `atrasado` se vencido; `pendente` se não há vencimento; `previsto` se o **mês** do vencimento é futuro; senão `pendente`.

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
| GET | `/v1/financeiro/dre/mes` | `mes` (default mês corrente SP) | `calcularDreMes` |
| PATCH | `/v1/financeiro/impostos/:mes/pagar` | `:mes` YYYY-MM; body `valor_pago?`, `data_pagamento?`, `observacao?` | `pagarImposto` |
| PATCH | `/v1/financeiro/impostos/:mes/desfazer` | `:mes` YYYY-MM | `desfazerImposto` |
| GET | `/v1/financeiro/config` | — | `buscarConfigFinanceiro` |
| PATCH | `/v1/financeiro/config` | body parcial: `aliquota_imposto_pct?`, `data_corte?` (nullable), `saldo_abertura?` (ao menos um) | `atualizarConfigFinanceiro` |
| GET | `/v1/financeiro/caixa` | `ate?` YYYY-MM-DD (default hoje SP) | `calcularCaixa` |

`origem` em `/lancamentos`: `marca_fixo`, `marca_comissao`, `avulsa`, `manual`, `recorrente`, `parcela`, `apresentadora`, `imposto`.

### Receitas comerciais — `financeiroReceitasRoutes` (`src/routes/financeiro_receitas.js`)

`:id` = UUID materializado ou `calc:<marca_id>:<YYYY-MM>:<fixo|comissao>`.

| Método | Rota | Parâmetros | Serviço |
| --- | --- | --- | --- |
| GET | `/v1/financeiro/receita` | `mes?` (default mês corrente SP) | `consultarReceitaMensal` |
| GET | `/v1/financeiro/receitas` | `mes` ou `inicio`/`fim`; `status?`, `componente=fixo\|comissao?`, `marca_id?`, `cliente_id?` | `listarTitulosReceita` |
| POST | `/v1/financeiro/receitas/gerar` | `mes` em query ou body | `gerarTitulosReceita` |
| PATCH | `/v1/financeiro/receitas/:id/receber` | body `valor_pago?`, `data_pagamento?`, `observacao?` | `receberTitulo` |
| PATCH | `/v1/financeiro/receitas/:id/desfazer` | `:id` | `desfazerRecebimento` |

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
| PATCH | `.../:apresentadora_id/:mes/pagar` | legado = componente `fixo` | `pagar` |
| PATCH | `.../:apresentadora_id/:mes/desfazer` | legado = componente `fixo` | `desfazer` |

`/v1/asaas/*` concilia os mesmos lançamentos e **não** faz parte de `/v1/financeiro/*`.

---

## Verificação das rotas

Cada path literal em `src/routes` deve aparecer com `grep -rn "<rota>" src/routes`. Família `apresentadoras-pagamentos`: grepar o prefixo `/v1/financeiro/apresentadoras-pagamentos` e os sufixos `:apresentadora_id/:mes/:componente/pagar`, `:apresentadora_id/:mes/:componente/desfazer`, `:apresentadora_id/:mes/pagar`, `:apresentadora_id/:mes/desfazer`, e `` `${BASE}/config` ``.
