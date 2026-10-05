# Contrato financeiro v1 — dicionário de métricas e eixos

Status: **FIN-01A — contrato documental, sem mudança de regra de negócio**

Base examinada: `b95bff91e67de8bffea57fdb1759e3795bfe3474`
Escopo: backend LiveLab; descreve o comportamento atual e separa explicitamente propostas ainda não implementadas.

> Regra de leitura deste documento: **Atual** significa comportamento comprovado no código desta base. **Proposta** é contrato desejado para as próximas etapas e não autoriza implementação quando depender de decisão de negócio. Toda decisão não sustentada pelo código está marcada como **PENDENTE** com responsável e impacto.

## 1. Princípios do contrato

O financeiro usa eixos diferentes para perguntas diferentes. Eles não são intercambiáveis:

- **competência** responde a qual período econômico o lançamento pertence;
- **vencimento** responde quando um saldo deveria ser liquidado;
- **pagamento** responde quando houve movimento realizado;
- **corte financeiro** limita o histórico controlado pela LiveLab;
- **saldo Asaas** é saldo externo consultado no provedor, sem identidade contábil automática com o saldo controlado;
- **fechamento** de competência ainda não existe como estado persistido nesta base.

**Vocabulário proposto, sem estados persistidos hoje:** **calculado** é valor produzido por regra ou projeção a partir dos insumos disponíveis, inclusive título virtual; **apurado** é resultado de uma consulta/totalização dos lançamentos e baixas registrados naquele instante, sujeito a edição posterior; **consolidado** seria uma versão aprovada do período, recuperável com sua base, regras e correções. Calculado pode integrar uma apuração, mas nenhum dos dois implica fechamento. **PENDENTE — responsável: Lucas; impacto:** aprovar critérios de passagem entre os três rótulos, versão e imutabilidade antes de uma tela/API chamar qualquer número de “consolidado”.

Referências atuais: `src/services/financeiro-agregador.js:262-291,309-345,369-424,820-840,1020-1045,1124-1161,1210-1225`; `migrations/165_receita_titulos_vencimento_condicoes.sql:43-80`; `migrations/169_financeiro_saldo_abertura.sql:11-18`.

## 2. Dicionário versionado de conceitos

### FIN-M01 — Valor gerado por competência

**Pergunta respondida:** quanto de receita operacional pertence economicamente à competência `M`, independentemente de quando vence ou é paga?

**Atual — fórmula**

Para `M`:

`valor_gerado_competencia(M) = Σ valor_previsto das receitas operacionais cuja competencia = M`

No DRE, aportes são segregados e não entram como receita operacional. Receita perdida continua em `receita.previsto`, e a perda aparece separadamente em `perdas.receita.valor`; o resultado previsto desconta essa perda. O agrupamento é feito por `mesDe(item.competencia)`.

**Atual — fonte concreta:** títulos calculados/materializados de `receita_titulos` via `src/services/receitas-comercial.js`, receitas avulsas via `src/services/receitas-avulsas.js`, unificados em `listarLancamentos` e agregados por `montarDre`; ver `src/services/financeiro-agregador.js:369-424,1020-1045`.

**Eixo de data:** `competencia` (`DATE`, primeiro dia do mês para `receita_titulos`; constraint em `migrations/165_receita_titulos_vencimento_condicoes.sql:48-64`).

**Perdas — atual:** não reduzem `receita.previsto`; são expostas em `perdas.receita.valor`. Para resultado previsto: `receita.previsto - perdas.receita.valor - custos_fixos.previsto - custos_variaveis.previsto` (`src/services/financeiro-agregador.js:377-380,407-421`). A perda registrada hoje altera a apuração da competência de origem em consultas futuras; sua data de registro não cria, por si, uma linha de resultado no mês da perda.

**Status de apuração:** a parcela virtual é **calculada**; o total exibido é **apurado na consulta** a partir de parcelas virtuais/materializadas. Não há versão **consolidada** na base; ver vocabulário da seção 1.

**Exemplo:** competência 2026-10 com fixo R$ 1.000 e comissão R$ 300 gera R$ 1.300, ainda que ambos vençam em novembro e sejam pagos em dezembro. Se R$ 200 forem declarados perdidos, `receita.previsto = 1.300`, `perdas.receita.valor = 200` e contribuição líquida da receita ao resultado previsto = R$ 1.100.

**Teste esperado:** fixture com receitas da competência M vencendo/pagando em meses distintos deve manter `receita.previsto` em M; aporte não altera o resultado; perda aparece separada. Cobertura existente relacionada: `test/financeiro_caixa_corte.test.js:109-117` e testes de DRE.

**Proposta v1 — fórmula:** `valor_gerado_competencia(M) = Σ valor_previsto das receitas operacionais de competencia M` **se Lucas aprovar manter a regra atual**. Nomear a métrica para distingui-la de recebimento. **PENDENTE — responsável: Lucas; impacto: decidir se a perda altera o valor histórico de M na consulta atual, se entra na competência da perda ou se exige versão/snapshot; preservar a fórmula temporal atual não está aprovado.**

### FIN-M02 — Liquidado de títulos da competência

**Pergunta respondida:** quanto dos títulos recebíveis pertencentes à competência `M` foi baixado **até uma data de referência `T`**? O código atual só permite responder com segurança para o estado presente da consulta.

**Atual — fórmula**

`liquidado_titulos_competencia_atual(M) = Σ receita_titulos.valor_pago atual onde receita_titulos.competencia pertence a M`

Trata-se somente de **títulos recebíveis**. O DRE `receita.realizado` soma também receitas avulsas; `resultado.realizado` desconta custos, apresentadoras e imposto. Portanto nenhum dos dois é sinônimo desta métrica. A agregação do DRE por competência está em `src/services/financeiro-agregador.js:369-424`.

**Atual — fonte concreta:** `receita_titulos.competencia` e `receita_titulos.valor_pago`, normalizados por `src/services/receitas-comercial.js` e agregados como receitas de títulos em `src/services/financeiro-agregador.js:369-424`. A métrica com este nome ainda não é um campo independente da API: é um recorte dos títulos existentes.

**Eixo de data:** seleção por `competencia`; `data_pagamento` é a data de baixa atualmente guardada no título. O estado consultado vale para “agora”. **Não há filtro histórico confiável `até T`**: `valor_pago` e `data_pagamento` agregados são sobrescritos ou zerados em receber/desfazer (`src/services/receitas-comercial.js:416-449`), sem sequência de eventos de baixa no título.

**Perdas:** título perdido parcialmente conserva o valor pago e encerra apenas o saldo. Custos e seus cancelamentos não pertencem a esta métrica (`src/services/financeiro-agregador.js:309-343,388-405`).

**Status de apuração:** **apurado do estado atual** das baixas registradas; não equivale a caixa do período nem a um consolidado histórico.

**Exemplo:** título de competência setembro, R$ 1.000, pago em 10/outubro: setembro mostra R$ 1.000 em realizado no DRE; outubro mostra R$ 1.000 em recebido no período.

**Teste esperado:** título de competência M com `data_pagamento` em M+1 compõe o subtotal atual de M e o recebido de M+1; avulsa e custo não o mudam. Para a proposta histórica, pagar parcialmente, corrigir e desfazer após `T` deve manter recuperável a resposta que era válida em `T`, se Lucas aprovar esse requisito.

**Proposta v1 — fórmula: PENDENTE para `T` histórico.** `liquidado_titulos_competencia(M,T) = Σ baixas válidas de títulos de competencia M ocorridas até T − Σ reversões válidas até T`, **se** forem aprovados eventos/versionamento suficientes para reconstruí-la. Para `T=estado atual`, manter o subtotal atual acima. **PENDENTE — responsável: Lucas + Produto/Engenharia; impacto:** decidir semântica de `T` (data civil da baixa, instante do registro ou ambos), fonte histórica e como tratar correções/desfazimentos. Também decidir se a comparação “gerado x liquidado” inclui avulsas em ambos os lados ou exibe títulos separadamente.

### FIN-M03 — Recebido no período

**Pergunta respondida:** quanto dinheiro de receita operacional foi baixado dentro de uma janela de calendário, independentemente da competência de origem?

**Atual — fórmula**

`recebido_periodo([D1,D2]) = Σ valor_pago de receita_titulos + Σ valor_pago de receitas_avulsas(grupo <> 'aporte'), com data_pagamento entre D1 e D2`

Quando há `data_corte`, somente pagamentos em/apos o corte entram. A consulta usada pelo painel está em `src/services/financeiro-agregador.js:820-840`. `realizadoEntre` inclui aportes nas entradas de caixa, por isso **entradas de caixa** e **recebido operacional** são conceitos distintos (`:1124-1151`).

**Atual — fonte concreta:** `receita_titulos.data_pagamento/valor_pago` e `receitas_avulsas.data_pagamento/valor_pago`; painel usa `recebidoPorMes`.

**Eixo de data:** `data_pagamento`.

**Perdas:** perda não elimina valores já pagos; só o saldo não pago é encerrado.

**Status de apuração:** **realizado registrado na LiveLab**; não prova liquidação bancária no Asaas se a baixa foi manual.

**Exemplo:** R$ 700 de competência setembro pagos em outubro + R$ 400 de competência outubro pagos em outubro = recebido de outubro R$ 1.100.

**Teste esperado:** misturar competências diferentes com mesma `data_pagamento` e validar soma no mês de pagamento; incluir aporte e provar que ele não entra em `recebido_periodo`, embora entre em entrada de caixa.

**Proposta v1 — fórmula:** `Σ valor_pago de receita_titulos e receitas_avulsas não aporte com data_pagamento em [D1,D2] e, se configurado, >= data_corte`, **igual à regra atual**. Mostrar a janela na UI; FIN-M02 continua restrita a títulos.

### FIN-M04 — A receber

**Pergunta respondida:** qual saldo de receitas ainda está aberto no horizonte de vencimento considerado?

**Atual — fórmula base**

Por item não encerrado:

`em_aberto = max(0, valor_previsto - valor_pago)`

Se perdido/cancelado, `em_aberto = 0` (`src/services/financeiro-agregador.js:309-310`). Para `/caixa`, `a_receber` soma apenas itens com **competência entre `mês(data_corte)−2 meses` e `mês(fim_mes(ate))`**, após o filtro `dataEfetiva >= data_corte`, e com vencimento efetivo entre `data_corte` e `fim_mes(ate)`. Portanto um recebível antigo que vence no horizonte pode não aparecer por estar fora da janela de competência (`src/services/financeiro-agregador.js:1210-1225,1265-1281`).

**Atual — fonte concreta:** lançamentos unificados de receita em `listarLancamentos`; vencimento vindo de título/condição comercial ou receita avulsa.

**Eixo de data:** `data_vencimento` efetivo (fallback ao último dia da competência), limitado hoje também por `dataEfetiva` do corte e pela janela de **competência** carregada. O painel usa outra janela de competência, `[mes−12,mes]` (`src/services/financeiro-agregador.js:1420-1433`).

**Perdas:** saldo perdido sai integralmente de a receber; parcela já paga permanece no realizado.

**Status de apuração:** **posição aberta derivada**, dependente da data de consulta/horizonte.

**Exemplo:** título R$ 1.000, pago R$ 300, ainda ativo: a receber R$ 700. Se o saldo for marcado perdido, a receber R$ 0 e perda R$ 700.

**Teste esperado:** aberto parcial, pago integral, perdido, título fora do vencimento e título com vencimento dentro do horizonte mas competência anterior a `mês(corte)−2`; este último não compõe `/caixa` atual. Cobertura existente relacionada: `test/financeiro_caixa_corte.test.js:91` e `test/financeiro_painel.test.js:45-61`.

**Proposta v1 — fórmula: PENDENTE quanto ao universo.** Candidata: `Σ max(0, valor_previsto - valor_pago)` das receitas não encerradas com vencimento efetivo no horizonte declarado; **decidir se mantém o filtro atual de competência `[mês(corte)−2,mês(fim_mes)]` e `dataEfetiva` ou inclui obrigações antigas ainda abertas**. Responsável: Lucas + Financeiro/Controladoria; impacto: total a receber e caixa projetado. Declarar vencimento, corte e janela de competência em cada resposta. A regra temporal de perdas permanece pendente em FIN-M01.

### FIN-M05 — A pagar

**Atual — fórmula:** mesma semântica de FIN-M04 para natureza `custo`:

`a_pagar = Σ max(0, valor_previsto - valor_pago)` para custos não encerrados, após os **mesmos filtros de competência, `dataEfetiva`, corte e vencimento de FIN-M04**. Para `/caixa`, a janela de competência começa em `mês(data_corte)−2 meses` (`src/services/financeiro-agregador.js:1265-1281`).

**Atual — fonte concreta:** `custos`, `apresentadora_pagamentos` e imposto materializado/calculado via lançamentos unificados; `src/services/financeiro-agregador.js:1020-1045,1210-1225`.

**Eixo de data:** `data_vencimento` efetiva, mais corte/data efetiva e janela de competência carregada; no painel a janela é `[mes−12,mes]`.

**Perdas/cancelamentos:** custo cancelado deixa de compor a pagar; valor já pago permanece realizado.

**Status de apuração:** **posição aberta derivada**.

**Exemplo:** custo previsto R$ 500, pago R$ 100 => R$ 400 a pagar; cancelado após pagamento parcial => R$ 0 a pagar, mantendo R$ 100 realizado.

**Teste esperado:** mesmos cenários de a receber para custos; cobertura existente em `test/financeiro_painel.test.js:53-61`.

**Proposta v1 — fórmula: PENDENTE quanto ao universo.** Candidata: `Σ max(0, valor_previsto - valor_pago)` dos custos não encerrados no horizonte declarado; Lucas + Financeiro/Controladoria decidem se a janela atual de competência e o corte continuam limitando obrigações antigas. A escolha altera a pagar e o caixa projetado.

### FIN-M06 — Vencido

**Pergunta respondida:** qual saldo aberto aparece como atrasado **em uma consulta específica**, por natureza e dentro de seus filtros? Não existe uma soma universal `vencido` nesta base.

**Atual — fórmula**

`totais[natureza].atrasado = Σ em_aberto(i)` dos **itens já selecionados** daquela natureza com `status(i,hoje)='atrasado'` (`src/services/financeiro-agregador.js:313-345`). Em `/painel`, `a_receber.atrasados` e `a_pagar.atrasados` são somas **separadas**: `Σ em_aberto` por natureza, com vencimento efetivo `< hoje` e dentro de `[data_corte,fim_mes]`, sobre itens carregados em `[mes−12,mes]` de competência e já filtrados pelo corte (`src/services/financeiro-agregador.js:1290-1320,1370-1374,1420-1433`).

O status é derivado, nunca persistido. Parcial vencido também vira `atrasado`; sem baixa e vencido idem. Ver `docs/financeiro.md:128-144` e `src/lib/lancamento-status.js`.

**Atual — fonte concreta:** lançamentos normalizados + `statusLancamento` para `totais[natureza].atrasado`; `resumirAbertos` para chips de atrasados do painel. Os dois têm universo limitado pela rota.

**Eixo de data:** vencimento efetivo versus `hoje` em data civil `YYYY-MM-DD`, além dos eixos de corte, horizonte de vencimento e competência carregada pelo painel.

**Perdas/cancelamentos:** encerrados ficam fora do vencido.

**Status de apuração:** **derivado no momento da consulta**.

**Exemplo:** título de receita com vencimento 05/10, consulta em 06/10, previsto 1.000 e pago 250 => R$ 750 em `a_receber.atrasados.valor` **se** passar pelos filtros de corte, competência e horizonte do painel. Custo equivalente aparece separadamente em `a_pagar.atrasados.valor`.

**Teste esperado:** vencimento ontem/hoje/amanhã, parcial, perdido/cancelado, receita versus custo, corte, horizonte e competência antiga fora da janela; não afirmar um total único. Cobertura relacionada em `test/financeiro_painel.test.js:45-61`.

**Proposta v1 — fórmula: PENDENTE.** Candidata para decisão: `Σ max(0, valor_previsto - valor_pago)` dos itens abertos com vencimento efetivo anterior à data de referência; ainda é preciso decidir universo (receitas, custos ou ambos), horizonte, corte e tratamento de itens sem vencimento. **PENDENTE — responsável: Lucas; impacto: rótulo “vencido”, limites da soma e compatibilidade com `atrasado` da API/UI não estão aprovados.**

### FIN-M07 — Saldo controlado LiveLab

**Pergunta respondida:** qual saldo de caixa a LiveLab consegue reconstruir desde o corte financeiro configurado?

**Atual — fórmula**

Com corte configurado:

`saldo_controlado(ate) = saldo_abertura + entradas_realizadas[data_corte, ate] - saidas_realizadas[data_corte, ate]`

Entradas realizadas em `realizadoEntre`: títulos + receitas avulsas, incluindo aportes. Saídas: custos, apresentadoras e imposto (`src/services/financeiro-agregador.js:1124-1151`). O contrato de `/caixa` chama esse número de `saldo_atual`.

Sem `data_corte`, `/caixa` retorna `configurado:false` e saldo zero; a base não tenta reconstruir todo o histórico (`src/services/financeiro-agregador.js:1228-1235`; migration `169_financeiro_saldo_abertura.sql`).

**Atual — fonte concreta:** `tenants.financeiro_data_corte`, `tenants.financeiro_saldo_abertura` + tabelas de baixa.

**Eixo de data:** `data_pagamento`, iniciando em `data_corte`, até `ate`.

**Perdas:** não afetam saldo controlado diretamente; apenas pagamentos efetivos alteram caixa.

**Status de apuração:** **reconstruído internamente**; depende da completude/correção das baixas.

**Exemplo:** abertura 10.000; entradas 5.900; saídas 500 => saldo controlado 15.400. Cobertura: `test/financeiro_caixa_corte.test.js:63-70`.

**Teste esperado:** corte inclusivo em `data_corte`, abertura antes dos movimentos desse dia, entradas com aporte e saídas pagas até `ate`; sem corte, `/caixa` retorna `configurado:false` e saldo zero.

**Proposta v1 — fórmula:** `saldo_abertura + entradas_realizadas[data_corte,ate] - saidas_realizadas[data_corte,ate]`, **igual à regra atual**; explicar `saldo_atual` como saldo controlado, sujeito à decisão de compatibilidade do campo.

### FIN-M08 — Saldo Asaas

**Pergunta respondida:** qual saldo o provedor Asaas informou no instante da consulta?

**Atual — fórmula:** nenhuma fórmula local. É o valor `balance` retornado por `GET /finance/balance`, exposto como `{ saldo, consultado_em }` em `GET /v1/asaas/saldo` (`src/services/asaas.js:182-189`; `src/routes/asaas.js:156-169`).

**Atual — fonte concreta:** API Asaas, chave do tenant (`tenants.gateway_api_key`).

**Eixo de data:** instante `consultado_em` para o saldo; transações do extrato têm data própria e podem ser sincronizadas em `gateway_transacoes` (`src/routes/asaas.js:171-205,207-299`).

**Perdas:** regras de perda/cancelamento da LiveLab não alteram o saldo retornado pelo Asaas.

**Status de apuração:** **externo, instantâneo**; pode divergir do saldo controlado por tarifas, transferências, recebimentos não conciliados, atrasos de sync ou baixas manuais.

**Exemplo:** LiveLab reconstruído R$ 15.400 e Asaas R$ 15.250 são duas leituras de R$ 150 de distância aritmética. Essa distância **não é diferença conciliável confirmada** sem equivalência aprovada de data e escopo de contas.

**Teste esperado:** mock do Asaas retorna `balance` e rota preserva o número e timestamp; erros de chave/rede continuam separados. Cobertura relacionada: `test/asaas.test.js`.

**Proposta v1 — fórmula do saldo Asaas:** `saldo_asaas(t) = balance` devolvido pelo Asaas na consulta `t`, **igual à leitura atual**. Fórmula candidata para diferença: `saldo_asaas(t, contas S) - saldo_controlado(t, contas S)`; **PENDENTE**, pois a base atual não assegura o mesmo escopo `S` de contas nem o mesmo instante de referência. Até decisão, apenas mostrar os saldos identificados por fonte e data, sem rotular a distância como conciliação.

**PENDENTE — responsável:** Lucas + Financeiro/Controladoria. **Impacto:** aprovar escopo de contas, data de referência, tolerância monetária e se eventual diferença será apenas informativa ou gerará tarefa de conciliação.

### FIN-M09 — Caixa projetado

**Pergunta respondida:** dado o saldo controlado e os movimentos conhecidos até o fim do mês, qual saldo esperado ao final do mês?

**Atual — fórmula de `/caixa`**

`saldo_projetado_fim_mes = saldo_atual + realizado_pos_ate.entradas - realizado_pos_ate.saidas + a_receber - a_pagar`

Ver `src/services/financeiro-agregador.js:1228-1281` e teste `test/financeiro_caixa_corte.test.js:63-70`. `a_receber/a_pagar` herdam **também** a janela de competência `[mês(corte)−2,mês(fim_mes)]`, o filtro por `dataEfetiva` e o vencimento `[corte,fim_mes]` de FIN-M04/M05. Pagamentos já registrados depois de `ate` entram em `realizadoPosAte`.

**Atual — fonte concreta:** saldo controlado + movimentos realizados posteriores a `ate` dentro do mês + abertos por vencimento.

**Eixo de data:** `ate` e `fim_mes`, com realizados por `data_pagamento` e abertos por `data_vencimento`.

**Perdas:** saldos encerrados não entram em a receber/a pagar.

**Status de apuração:** **projeção determinística com dados cadastrados**, não forecast estatístico.

**Exemplo:** saldo atual 15.400; saída já registrada para depois de `ate` 50; a receber 1.500; a pagar 700 => projetado 16.150.

**Teste esperado:** identidade exata da fórmula e invariância entre painel e `/caixa`; cobertura: `test/financeiro_caixa_corte.test.js:63-70` e `test/financeiro_painel.test.js:176-189`.

**Proposta v1 — fórmula:** `saldo_controlado(ate) + realizado_pos_ate.entradas - realizado_pos_ate.saidas + a_receber - a_pagar`, **igual à identidade atual de `/caixa`**; o valor proposto fica **PENDENTE** da aprovação do universo de a receber/a pagar em FIN-M04/M05. Mostrar `ate`, `fim_mes`, corte e janela de competência; projeção por ritmo/comissão fica separada.

## 3. Mapa oficial de datas

| Data | Significado atual | Usar para | Não usar para |
|---|---|---|---|
| `competencia` | período econômico do lançamento | valor gerado, DRE, liquidado da competência | recebido do período, vencido |
| `data_vencimento` | obrigação esperada de receber/pagar | a receber, a pagar, vencido, fluxo previsto | realizado de caixa |
| **data esperada de caixa** | **PENDENTE:** não há campo normalizado distinto de `data_vencimento` | futura previsão de entrada/saída, se aprovada | substituir silenciosamente vencimento ou baixa |
| `data_pagamento` | data civil informada/gravada na baixa LiveLab, inclusive manual | recebido/pago do período, saldo controlado, fluxo realizado atuais | provar quando o dinheiro ficou disponível na conta ou quando a baixa foi registrada |
| `gateway_transacoes.data` | data de **movimento do extrato Asaas** normalizada no cache | extrato/conciliação; na baixa por conciliação vira `data_pagamento` | assumir disponibilidade bancária ou instante de registro |
| **data de disponibilidade em conta** | **PENDENTE:** sem coluna normalizada/validada na LiveLab; `creditDate` pode constar no payload de cobrança Asaas, mas não é eixo contratado aqui | futura conciliação de caixa disponível, após fonte e escopo aprovados | inferir de `data_pagamento` ou `gateway_transacoes.data` |
| **instante de registro** | `criado_em`/`atualizado_em` do registro, `gateway_transacoes.sincronizado_em` e `audit_log.criado_em` em suas trilhas respectivas; não há histórico completo de cada alteração de baixa | rastrear quando a informação entrou/mudou na LiveLab | substituir data econômica, vencimento, movimento ou disponibilidade |
| `financeiro_data_corte` | início do histórico controlado | filtrar histórico e iniciar reconstrução de caixa | fechamento mensal |
| `financeiro_saldo_abertura` | saldo antes dos movimentos do dia de corte | base do saldo controlado | receita/DRE |
| `perdido_em` | momento de encerramento de saldo de receita | auditoria de perda/status | eixo do DRE ou do caixa |
| `cancelado_em` | momento de encerramento de saldo de custo | auditoria/status | eixo do DRE ou do caixa |
| `consultado_em` do saldo Asaas | instante da leitura externa | frescor do saldo externo | competência/vencimento |

**Proposta de eixo `data_esperada`: PENDENTE — responsável: Lucas + Financeiro/Controladoria; impacto:** decidir se é a data de vencimento, uma previsão revisável separada ou uma data derivada de prazo do meio de pagamento; aprovar fonte, alterações permitidas e efeito em projeção. **Disponibilidade em conta: PENDENTE — responsável: Lucas + Financeiro/Controladoria; impacto:** definir fonte verificável por conta/transação e distinguir de baixa manual, movimento no extrato e instante de sincronização. Referências atuais: `migrations/162_gateway_transacoes.sql:13-34`, `migrations/165_receita_titulos_vencimento_condicoes.sql:45-58`, `migrations/061_audit_log.sql:5-15`, `src/services/conciliacao.js:264-268`, `src/services/asaas.js:14-21`.

### Corte de caixa — atual

`dataEfetiva(item) = data_pagamento` quando existe pagamento; caso contrário, vencimento efetivo. Item com data efetiva anterior ao corte é excluído de `listarLancamentos` (`src/services/financeiro-agregador.js:272-291,1025-1053`). **O corte atual também filtra o DRE:** `calcularDre` passa `dataCorte` a `listarLancamentos` (`:1062-1071`), assim como `/dre/mes` (`:1089`) e o painel (`:1432`). Alterar o corte hoje pode mudar a apuração exibida para competências antigas; não apaga automaticamente as linhas do banco. Para `/caixa`, além do corte, a consulta de obrigações carrega apenas competências desde `mês(corte)−2` (`:1265-1281`). O saldo de abertura representa a posição **antes dos movimentos do próprio dia de corte**, conforme `docs/financeiro.md`, seção “Data de corte e saldo de abertura do caixa”.

### Corte de caixa — proposta

**Proposta para aprovação, não comportamento atual:** separar configuração do caixa controlado da existência e apuração histórica das obrigações. Alterar `data_corte`/`saldo_abertura` poderia mudar o saldo controlado dali em diante, mas **não apagar obrigações nem reescrever apurações históricas já registradas ou consolidadas**. Hoje não há tal versão histórica de DRE; a forma de criá-la, consultar períodos anteriores ao corte e migrar o cálculo atual exige decisão. Invariantes candidatos:

1. `data_corte` é inclusiva;
2. `saldo_abertura` é posição imediatamente anterior ao primeiro movimento considerado em `data_corte`;
3. alteração retroativa de corte/saldo exige política de autorização, justificativa, auditoria e eventual reabertura, se Lucas aprovar esses requisitos.

**PENDENTE — responsável:** Lucas + Financeiro/Controladoria. **Impacto:** aprovar separação entre corte de caixa e apuração de obrigações/DRE, tratamento do histórico ainda aberto, possibilidade de alterar o corte após fechamento, reabertura e trilha. O comportamento atual continua descrito acima até implementação autorizada.

## 4. Fechamento de competência

### Estado atual

Não foi localizado nesta base um modelo persistido de fechamento financeiro mensal com estados aberto/fechado/reaberto. O sistema recalcula DRE, títulos e posições a partir dos dados atuais. Portanto, qualquer tela que pareça “fechada” não deve ser tratada como imutabilidade contábil sem implementação específica.

### Proposta de contrato — sem implementação nesta FIN-01A

Estados sugeridos para discussão:

| Estado | Semântica proposta | Escritas propostas |
|---|---|---|
| `aberto` | competência em apuração | regras atuais |
| `fechado` | fechamento aprovado, cujo conteúdo ainda depende de decisão | PENDENTE: política de escritas e correções |
| `reaberto` | fechamento anterior invalidado explicitamente para correção | PENDENTE: política de escritas, motivo, trilha e novo fechamento |

**Cenários propostos para aprovação:** (a) receber em novembro um título de competência outubro já fechada, registrando a baixa e o movimento de novembro sem perder a versão consolidada de outubro; definir se o fechamento ganha complemento/versionamento de liquidação ou exige reabertura; (b) ao reabrir, conservar a versão anterior consultável, motivo, ator, instante e evento de auditoria, e produzir nova versão ao fechar novamente. **PENDENTE — responsável: Lucas + Financeiro/Controladoria + Engenharia; impacto:** política de escrita após fechamento, identidade da versão anterior, momento da nova baixa e forma de refletir liquidação posterior sem alterar indevidamente o consolidado.

Campos mínimos candidatos: `tenant_id`, `competencia`, `status`, `fechado_em`, `fechado_por`, `reaberto_em`, `reaberto_por`, `motivo_reabertura`, versão do cálculo/snapshot.

**PENDENTE — responsável:** Lucas + Financeiro/Controladoria. **Impacto alto:** definir o que exatamente congela ao fechar: títulos gerados, DRE, perdas, custos, pagamentos, condições comerciais retroativas, imposto e saldo inicial do mês seguinte; definir também o significado verificável de “consolidado”.

**PENDENTE — responsável:** Lucas + Produto + Engenharia. **Impacto alto:** decidir se o fechamento guarda snapshot monetário ou apenas bloqueia mutações e recalcula; isso determina schema, auditoria e estratégia de correção.

**PENDENTE — responsável:** Lucas + Financeiro/Controladoria. **Impacto médio/alto:** definir quem pode fechar/reabrir e se reabertura exige dupla aprovação; nenhum papel está atribuído ou excluído nesta proposta.

**Testes candidatos após aprovação da política:** validar as mutações que Lucas decidir bloquear; receber título antigo após fechamento com classificação temporal aprovada; reabrir preservando a versão anterior e motivo/auditoria se exigidos; conferir leitura do consolidado segundo a estratégia aprovada; provar isolamento entre tenants.

## 5. Matriz de permissões, tenant e auditoria

### Matriz ação × papel real × tenant × auditoria

Legenda: **S** = rota atual permite; **N** = rota atual não permite; **P** = **PENDENTE**, ação ou permissão futura sem decisão. As colunas Master, Franq., Ger., Fin., Fin. RO, Auditor e AF representam, respectivamente, `franqueador_master`, `franqueado`, `gerente`, `financeiro`, `financeiro_readonly`, `auditor` e chave `automacao_financeiro`. As células descrevem **somente a autorização existente**; não concedem nem vetam papéis em propostas futuras. Fonte de papéis: `src/config/role_groups.js:13-41`; para AF também se exige a allowlist `ROTAS_API_KEY_FINANCEIRO` em `src/plugins/auth.js:80-135`.

| Ação e rota atual | Master | Franq. | Ger. | Fin. | Fin. RO | Auditor | AF | Tenant atual/proposto | Auditoria atual/proposta |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|---|---|
| Perder receita / `desperder`; cancelar / reativar custo, imposto ou apresentadora | S | S | S | S | N | N | N | `tenant_id` autenticado; recurso do mesmo tenant | chamadas `app.audit.log`; best-effort. Política futura P |
| Receber título/avulsa; pagar custo, imposto ou apresentadora | S | S | S | S | N | N | S¹ | `tenant_id` autenticado; recurso do mesmo tenant | chamadas `app.audit.log`; best-effort. Política futura P |
| Desfazer baixa de recebimento/pagamento | S | S | S | S | N | N | S¹ | `tenant_id` autenticado; recurso do mesmo tenant | chamadas `app.audit.log`; best-effort. Política futura P |
| Estornar movimento com semântica própria, além de `/desfazer` | P | P | P | P | P | P | P | PENDENTE: escopo do movimento/tenant | PENDENTE: eventos, reversão e obrigatoriedade |
| Conciliar / desfazer conciliação Asaas (`POST /conciliar`, `DELETE /conciliacao/:id`) | S | S | S | S | N | N | N | `tenant_id` autenticado; gateway e alvo locais | `asaas.conciliar` / `asaas.desconciliar`; best-effort |
| Alterar `data_corte` ou `saldo_abertura` (`PATCH /v1/financeiro/config`) | S | S | S | S | N | N | N | `tenant_id` autenticado; configuração do tenant | `financeiro.config_update`; best-effort; governança após fechamento P |
| Alterar futura `data_esperada` de caixa (rota/campo inexistentes) | P | P | P | P | P | P | P | PENDENTE: recurso e tenant da previsão | PENDENTE: valor anterior/novo, motivo e trilha |
| Criar/editar/baixar aporte como `receitas_avulsas` | S | S | S | S | N | N | S¹ | `tenant_id` autenticado; receita avulsa local | chamadas `app.audit.log`; best-effort. Exclusão de avulsa: AF N |
| Fechar competência / reabrir competência (rota inexistente) | P | P | P | P | P | P | P | PENDENTE: tenant e alcance do fechamento | PENDENTE: eventos, motivo, aprovação e falha da trilha |
| Consultar financeiro (`GET` das rotas financeiras existentes) | S | S | S | S | S | S | S² | `tenant_id` autenticado; consulta local | sem log de leitura por padrão; política futura P |
| Exportar `GET /v1/relatorios/financeiro/csv` | S | S | S | S | S | S | N | `tenant_id` autenticado; query restringe `lives.tenant_id` | sem log de exportação na rota; política futura P |

¹ AF só alcança as variantes enumeradas na allowlist: baixa/desfazer de títulos, avulsas, custos, imposto e apresentadora por `:componente`, além de criar/editar avulsas. As variantes legadas de apresentadora e DELETE não estão nela. ² AF só alcança os GET enumerados; `/config`, `/operacional`, `/faturamento`, `/v1/asaas/*` e CSV ficam fora. O CSV atual exporta dados de **lives** (GMV, comissão e duração), não os indicadores FIN-M01..M09; ver `src/routes/relatorios.js:43-90`.

Rotas concretas: `src/routes/financeiro_receitas.js:129-199`, `src/routes/financeiro_receitas_avulsas.js:115-211`, `src/routes/financeiro_custos.js:335-461`, `src/routes/financeiro_apresentadoras_pagamentos.js:66-173`, `src/routes/financeiro.js:857-975`, `src/routes/asaas.js:305-455`. A autorização de AF é interseção de papel e allowlist, não consequência apenas de `WRITE_FINANCEIRO`.

### Tenant — contrato atual

Rotas financeiras obtêm `tenant_id` do principal autenticado e executam consultas via `app.withTenant(tenant_id, ...)`. `withTenant` configura `app.tenant_id` na conexão e garante release (`src/plugins/db.js:220-248`). As queries financeiras também usam `tenant_id` explicitamente em pontos críticos. `receita_titulos` tem RLS habilitada e `FORCE ROW LEVEL SECURITY`, com policy baseada em `app.tenant_id` (`migrations/165_receita_titulos_vencimento_condicoes.sql:75-80`).

**Contrato documental v1:** toda métrica FIN-M01..M09 nesta base é **tenant-local**. Uma agregação multi-tenant, inclusive para franqueadora, exigirá decisão e rota próprias. A coluna “tenant” da matriz descreve o contexto exigido em cada ação, não presume aprovação de novas operações.

### Auditoria — estado atual

O plugin `src/plugins/audit_log.js:21-68` registra `tenant_id`, ator, ação, entidade, metadata saneada, IP e user-agent; falha de auditoria não aborta a request. Diversas mutações financeiras chamam `app.audit.log`, por exemplo receitas, custos, imposto e sincronização Asaas. Leituras normais não geram audit log por padrão.

**Proposta para decisão:** fechamento, reabertura e alteração de corte/saldo após uso poderiam registrar valor anterior, valor novo, competência, motivo e ator. A obrigatoriedade e o comportamento em falha ficam **PENDENTES**.

**PENDENTE — responsável:** Lucas + Segurança + Engenharia. **Impacto:** decidir se a auditoria de futuras operações sensíveis será obrigatória e, nesse caso, se a operação falhará quando a trilha não puder ser persistida.

### Permissão proposta para fechamento — ainda não decidida

Todos os papéis da linha “fechar/reabrir” permanecem **PENDENTES**, inclusive leitura, auditoria e automação. **PENDENTE — responsável: Lucas + Produto + Segurança + Financeiro; impacto: aprovar a matriz final, escopo por tenant e eventual dupla aprovação antes de criar qualquer rota.**

## 6. Perdas e encerramentos — contrato transversal

O código atual deriva status e trata `perdido` para receita e `cancelado` para custos como encerramento do saldo aberto. **Comportamentos atuais observados**, sujeitos à decisão de Lucas sobre a regra temporal e o efeito de fechamento:

1. pagamento realizado nunca desaparece por perda/cancelamento posterior;
2. somente o saldo `max(0, previsto - pago)` é encerrado;
3. encerrado sai de a receber/a pagar e do caixa projetado;
4. perda de receita aparece separada no DRE previsto da competência de origem, inclusive quando registrada depois dessa competência;
5. custo cancelado sai do previsto do DRE;
6. status é derivado, não uma coluna persistida de `receita_titulos`.

Fontes: `src/services/financeiro-agregador.js:309-343,369-424`; `docs/financeiro.md:128-144`; `migrations/165_receita_titulos_vencimento_condicoes.sql:7-10`.

**Proposta temporal: PENDENTE — responsável: Lucas; impacto:** definir se perda/cancelamento retroage à competência de origem, entra na competência do evento ou exige versão de apuração/consolidação. Os itens acima documentam o código atual, sem aprovar sua preservação como regra futura.

## 7. Invariantes de conciliação entre métricas

Estas igualdades/diferenças devem ficar explícitas em testes e UI:

1. `valor_gerado_competencia(M)` **não precisa** ser igual a `recebido_periodo(M)`.
2. `liquidado_titulos_competencia(M)` **não precisa** ser igual a `recebido_periodo(M)`; diferem quando títulos de uma competência são pagos em outro mês.
3. `saldo_controlado` **não precisa** ser igual a `saldo_asaas`.
4. `a_receber/a_pagar` são posições por vencimento; não são DRE.
5. `caixa_projetado` usa saldo e horizonte de caixa; não é resultado previsto do DRE.
6. aportes entram no caixa e ficam fora da receita operacional/DRE.
7. `saldo_previsto` dos lançamentos desconta aportes para manter a mesma semântica do resultado previsto do DRE (`src/services/financeiro-agregador.js:337-344`).

## 8. Exemplos integrados

Considere outubro/2026:

- título A: competência setembro, previsto 1.000, vencimento 05/10, pago 1.000 em 10/10;
- título B: competência outubro, previsto 2.000, vencimento 05/11, pago 500 em 25/10;
- título C: competência outubro, previsto 600, vencimento 20/10, pago 0, depois perdido integralmente;
- custo D: competência outubro, previsto 400, vencimento 15/10, pago 100 em 15/10;
- aporte E: 3.000 recebido em 02/10.

Resultado conceitual:

- valor gerado por competência outubro = 2.600 de receita operacional prevista;
- liquidado dos títulos da competência outubro = 500;
- recebido operacional em outubro = 1.500 (A 1.000 + B 500), sem aporte;
- entrada de caixa de outubro inclui também o aporte de 3.000;
- a receber, após a perda de C = saldo de B 1.500, sujeito ao horizonte de vencimento consultado;
- a pagar de D = 300 enquanto não cancelado/pago;
- perda da competência outubro = 600;
- saldo controlado muda pelos pagamentos/recebimentos nas respectivas datas, não pela competência.

## 9. Checklist de aceitação FIN-01A

- [x] dicionário para valor gerado por competência;
- [x] dicionário para liquidado de títulos da competência;
- [x] dicionário para recebido no período;
- [x] dicionário para a receber e a pagar;
- [x] dicionário para vencido;
- [x] dicionário para saldo controlado;
- [x] dicionário para saldo Asaas;
- [x] dicionário para caixa projetado;
- [x] cada conceito contém fórmula atual, proposta, fonte, eixo de data, perdas, status de apuração, exemplo e teste esperado;
- [x] mapa das datas distintas;
- [x] calculado, apurado e consolidado separados, com contrato de consolidação pendente;
- [x] data esperada, movimento, disponibilidade em conta e instante de registro separados;
- [x] fechamento aberto/fechado/reaberto descrito apenas como proposta;
- [x] corte de caixa atual e proposto separados;
- [x] corte atual no DRE e janela de competência de `/caixa` documentados;
- [x] matriz ação × papel real × tenant × auditoria, com ações inexistentes ou não decididas marcadas PENDENTE;
- [x] isolamento por tenant documentado;
- [x] auditoria atual e proposta documentadas;
- [x] decisões de negócio não comprovadas marcadas como PENDENTE com responsável e impacto;
- [x] nenhuma mudança de código, schema ou configuração faz parte desta etapa.

## 10. Questões pendentes para a próxima decisão

1. **Lucas + Financeiro/Controladoria:** o que exatamente é congelado ao fechar uma competência e quando um valor passa de apurado a consolidado?
2. **Lucas + Produto + Engenharia:** fechamento será snapshot versionado ou bloqueio com recálculo determinístico?
3. **Lucas + Produto + Segurança + Financeiro:** quais papéis podem fechar e reabrir; há dupla aprovação? A matriz não atribui nem exclui papéis futuros.
4. **Lucas + Financeiro/Controladoria:** alteração de `data_corte`/`saldo_abertura` depois de fechamento exige reabertura?
5. **Lucas + Financeiro/Controladoria:** quais contas e instante são comparáveis entre Asaas e LiveLab; a diferença será informativa ou gerará pendência; qual tolerância?
6. **Lucas + Segurança + Engenharia:** auditoria de fechamento/reabertura precisa ser fail-closed ou pode permanecer best-effort?
7. **Lucas:** “vencido” terá qual universo, horizonte, corte e rótulo em relação a `atrasado`?
8. **Lucas:** perdas e cancelamentos registrados depois da competência devem alterar a apuração antiga ou gerar evento/versão no período do registro?
9. **Lucas:** regra de arredondamento e tolerância de reconciliação serão mantidas como no código atual ou receberão contrato específico?
10. **Lucas + Produto + Engenharia:** existe necessidade de estorno distinto do `/desfazer` atual; em caso positivo, qual efeito, permissão, trilha e tenant?
11. **Lucas + Financeiro/Controladoria:** que significa `data_esperada`, como se verifica disponibilidade em conta e quem pode alterar a previsão? A permissão futura permanece PENDENTE para todos os papéis.
12. **Lucas + Financeiro/Controladoria:** a proposta de corte apenas para o caixa preservará obrigações e apurações históricas? Como migrar o DRE que hoje aplica o corte?
13. **Lucas + Financeiro/Controladoria + Engenharia:** título de competência fechada poderá receber baixa posterior sem reabrir? Que versão registra o novo liquidado e como preservar a versão anterior ao reabrir?
14. **Lucas + Financeiro/Controladoria:** a receber, a pagar, vencido e caixa projetado devem incluir obrigações antigas fora da janela de competência hoje carregada por `/caixa`/`painel`?
15. **Lucas + Produto/Engenharia:** como registrar eventos de baixa/reversão e reconstruir `liquidado_titulos_competencia(M,T)` após correções?

Este é o registro das questões levantadas na FIN-01A. As decisões tomadas em
05/10/2026 e as regras de implementação adotadas constam em
[financeiro-decisoes-v1.md](financeiro-decisoes-v1.md); a lista acima deve ser
lida junto desse registro, pois parte das questões já foi respondida.
