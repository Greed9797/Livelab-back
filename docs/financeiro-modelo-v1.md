# FIN-01B — Modelo canônico financeiro v1

## Status e escopo

**Status:** proposta para revisão de Lucas. Nenhuma regra de negócio pendente é
decidida neste documento.

Este documento define o modelo lógico financeiro v1 e os contratos que devem
orientar a etapa de implementação posterior. Ele registra o estado atual do
código e das migrations, explicita invariantes, compatibilidade e critérios de
migração, mas não cria schema, não altera comportamento e não autoriza cutover.

O documento consolidado
`PLANO-FINANCEIRO-LIVELAB-CONSOLIDADO-2026-10-05.md` foi tratado como requisito
de produto e arquitetura. As afirmações sobre o sistema atual abaixo foram
conferidas no código e nas migrations deste repositório.

## 1. Evidência do estado atual

O modelo atual registra o resultado agregado de uma baixa em campos do próprio
registro financeiro. Isso perde a identidade de múltiplos pagamentos e de suas
datas quando mais de uma liquidação compõe a mesma obrigação.

| Origem atual | Evidência observada | Consequência para a migração |
|---|---|---|
| `receita_titulos` | `valor_pago` agregado e uma única `data_pagamento` | Não é possível reconstruir várias liquidações históricas sem evidência externa. |
| `receitas_avulsas` | `valor_pago` agregado e uma única `data_pagamento` | Mesma limitação de reconstrução histórica. |
| `custos` | `valor_pago` agregado e uma única `data_pagamento` | Pagamentos parciais históricos não têm identidade própria no schema atual. |
| `apresentadora_pagamentos` | `valor_pago` agregado e uma única `data_pagamento` | O registro por apresentadora/competência/componente representa posição agregada. |
| `gateway_transacoes` | `UNIQUE (tenant_id, asaas_id)` | A mesma transação Asaas não pode ser ingerida duas vezes para o mesmo tenant. |
| `tenants` | `financeiro_data_corte` e `financeiro_saldo_abertura` | Há configuração de corte e abertura, mas não foi encontrado modelo de conta/ledger. |
| perdas/cancelamentos | Campos mutáveis `perdido_*` e `cancelado_*` | O estado atual não preserva uma sequência versionada de eventos de perda/cancelamento. |
| fechamento | Nenhum fechamento financeiro versionado identificado | Não há hoje uma fotografia versionada equivalente ao fechamento proposto em FIN-01A. |

O código atual de conciliação Asaas associa uma transação externa a um alvo
interno e pode gerar a baixa desse alvo. Quando a baixa foi criada pela própria
conciliação, `gateway_transacoes.conciliado_baixa = true`; ao desconciliar, essa
baixa é desfeita. Uma baixa manual pré-existente não é desfeita pela
desconciliação.

Também foi confirmado que `gateway_transacoes`, `custos_recorrentes` e
`apresentadora_pagamentos` têm RLS habilitado e política por tenant, porém não
têm `FORCE ROW LEVEL SECURITY` nas migrations inspecionadas. Portanto, a
lacuna é especificamente ausência de `FORCE RLS`, não ausência de RLS.

## 2. Modelo lógico v1

O modelo canônico é orientado a fatos financeiros. Cada fato possui uma única
fonte de verdade; campos agregados existentes passam a ser, quando aplicável,
projeções de compatibilidade.

### 2.1 Condição comercial, regra aplicável e obrigação financeira

A condição comercial vigente, a regra aplicável à competência e a memória do
cálculo são a autoridade para a formação do título comercial: devem explicar
componente, valor e vencimento. O título materializado conserva sua identidade e
os ajustes autorizados, mas seu valor não substitui silenciosamente aquela
origem e sua memória. Hoje `src/services/receitas-comercial.js` calcula a
receita, retorna `condicao_id` e `memoria` e materializa o título.

A obrigação financeira representa o valor que deve ser recebido ou pago, sua
origem, competência, vencimento e ajustes autorizados. Exemplos atuais: título
comercial, receita avulsa, custo, obrigação de apresentadora e imposto
materializado. Para as demais origens, a autoridade da regra e da memória de
cálculo deve ser identificada antes da conversão; não se presume que usem a
condição comercial.

Uma obrigação não contém, no modelo canônico, o histórico completo de
liquidações comprimido em um único `valor_pago` e uma única data.

### 2.2 Liquidação

Evento individual que reduz o saldo de uma obrigação. Deve preservar ao menos:
tenant, obrigação de origem, valor, data efetiva da liquidação, origem do
comando, autor/processo e identidade idempotente.

Uma obrigação pode receber várias liquidações em datas diferentes.

### 2.3 Estorno de liquidação

Evento que referencia uma liquidação existente e reverte total ou parcialmente
o efeito daquela liquidação. O evento original continua preservado.

Reduzir silenciosamente um total agregado não equivale a criar um estorno.

### 2.4 Movimento de conta

Representa entrada ou saída efetiva em uma conta controlada, com data própria e
classificação do movimento. É distinto de obrigação, liquidação e evento do
provedor.

O sistema atual não possui entidade de conta/ledger identificada nas migrations
financeiras inspecionadas. A materialização física desse conceito permanece
**PENDENTE**.

### 2.5 Transação externa

Evidência recebida de um provedor externo, hoje materializada principalmente em
`gateway_transacoes`. Uma transação externa não cria automaticamente um segundo
efeito financeiro interno.

### 2.6 Conciliação

Vínculo auditável entre evidência externa e fato interno. Conciliação identifica
que dois registros representam o mesmo fato ou uma relação explicitamente
aceita; igualdade de valor, isoladamente, não prova identidade.

No comportamento legado atual, conciliar também pode aplicar uma baixa no alvo.
Essa combinação deve ser preservada durante a transição até que o contrato
canônico seja aprovado e implementado.

### 2.7 Perda, cancelamento e ajuste

São fatos distintos da liquidação. Devem preservar valor afetado, motivo,
autor/processo e referência à obrigação. Cancelamento não deve ser escondido
como perda, e perda não representa movimento de caixa.

O histórico atual é mutável. A representação por eventos/versionamento ainda
depende de decisão de migração.

### 2.8 Fechamento financeiro

É uma versão aprovada de uma apuração em uma data de referência. O modelo lógico
deve permitir consultar separadamente a versão fechada e a situação corrente das
obrigações.

Não existe hoje fechamento financeiro versionado identificado no código/migrations
inspecionados. A estrutura física e as regras de vínculo com eventos permanecem
**PENDENTE** e dependem do contrato FIN-01A aprovado.

## 3. Cardinalidades

As cardinalidades abaixo descrevem o contrato lógico mínimo compatível com os
casos atuais. Não se presume uma conciliação N:M genérica sem caso aprovado.

| Relação | Cardinalidade v1 | Observação |
|---|---|---|
| tenant → obrigação | `0..N` | Um tenant pode não ter obrigações; cada obrigação pertence exatamente a um tenant. |
| obrigação → liquidação | `0..N` | Uma obrigação pode não ter liquidações; cada liquidação referencia uma obrigação. |
| liquidação → estorno | `0..N` | Uma liquidação pode não ter estornos; cada estorno referencia uma liquidação. |
| tenant → transação externa | `0..N` | Um tenant pode não ter transações; cada transação externa pertence a um tenant. |
| transação externa → vínculo de conciliação | atualmente `0..1` alvo | O schema atual guarda um único `conciliado_com_tipo/id` por transação. Expansão permanece PENDENTE. |
| obrigação → vínculos de conciliação | `0..N` lógico | Uma obrigação pode ser associada a evidências externas ao longo do tempo, desde que o modelo físico aprovado suporte o caso. |
| conta → movimento | `0..N` conceitual | Uma conta pode não ter movimentos; entidade conta ainda não existe no modelo atual. |
| liquidação ↔ movimento de conta | **PENDENTE** | Não assumir 1:1: taxa, disponibilização posterior, transferência e recebimento em dinheiro podem alterar número, valor, conta e data dos movimentos. |
| fechamento → versão/apuração | **PENDENTE** | Forma física e cardinalidade dependem de FIN-01A. |

Para o primeiro corte, o contrato deve suportar sem perda os casos atuais de
uma transação Asaas conciliada com um alvo interno. Splits, agrupamentos e N:M
devem entrar apenas quando houver casos concretos e regra aprovada.

## 4. Invariantes

Para recebíveis com ajustes autorizados e explicitamente tipados, a identidade
**proposta para aprovação** é:

```text
obrigação ajustada = valor original + ajustes positivos - ajustes negativos
obrigação ajustada
  = liquidações válidas líquidas de estornos
  + perdas válidas líquidas de reversões
  + saldo aberto
```

Cada ajuste teria identidade, tipo, valor, competência, motivo, autor e eventual
reversão próprios. Nenhum ajuste poderia ser inferido de uma diferença de saldos.
**PENDENTE — responsável: Lucas + Financeiro + Engenharia; impacto:** aprovar
quais tipos de ajuste aumentam ou reduzem a obrigação, a data e competência
aplicáveis e a política de reversão antes de aplicar esta identidade ao código.

**Cancelamento permanece fora da identidade acima. PENDENTE — responsável:
Lucas + Financeiro; impacto:** decidir se ele reduz a base da obrigação ou
encerra saldo como fato separado, inclusive após pagamento parcial. Até essa
decisão, a equação não deve ser usada para validar obrigações canceladas.
Cancelamento não será ocultado como perda; ambos serão exibidos separadamente
na comparação de migração.

Quando um campo legado `valor_pago` continuar exposto durante a transição:

```text
valor_pago de compatibilidade
  = soma das liquidações válidas líquidas de estornos
```

Para contas controladas, quando o modelo de conta for aprovado:

```text
saldo da conta
  = abertura reconciliada
  + entradas efetivas
  - saídas efetivas
```

Regras adicionais:

- cada fato financeiro pertence a exatamente um tenant;
- uma repetição idempotente não pode duplicar efeito financeiro;
- um estorno preserva e referencia o evento original;
- perda ou cancelamento não cria entrada/saída de caixa por si só;
- conciliar duas evidências do mesmo fato não pode contar o valor duas vezes;
- uma inconsistência não deve ser escondida por truncamento em zero;
- campos agregados de compatibilidade não podem se tornar uma segunda fonte de
  verdade independente após o cutover;
- dados históricos sem evidência suficiente não devem ser decompostos em
  eventos inventados.

## 5. Política monetária e resíduos

O contrato lógico exige valores monetários exatos na unidade monetária adotada
e proíbe descarte silencioso de resíduos de arredondamento. O estado atual usa
principalmente `NUMERIC(15,2)` no Postgres e conversões para `Number`/`round2`
em serviços JavaScript; isso é evidência do legado, não decisão para o modelo
canônico.

Uma operação como dividir R$ 100,00 em três componentes deve produzir partes
cuja soma seja exatamente R$ 100,00. O centavo residual deve ser alocado por
uma regra determinística e auditável.

Não fica decidido aqui se o armazenamento canônico será `NUMERIC`, centavos
inteiros ou outra representação. Também não fica decidida a precisão de
percentuais nem o ponto exato de arredondamento de cada cálculo.

Baixa manual acima do saldo deve permanecer sem nova regra até aprovação. O
plano consolidado recomenda bloqueio manual e preservação de excedente vindo do
provedor como pendência não alocada, sem criar crédito fictício; esta regra é
registrada abaixo como decisão **PENDENTE**, não como comportamento autorizado.

## 6. Idempotência

Existem dois níveis distintos.

### 6.1 Ingestão externa

`gateway_transacoes` já possui `UNIQUE (tenant_id, asaas_id)`. Essa unicidade é
uma barreira contra duplicação da mesma transação Asaas no mesmo tenant.

### 6.2 Comandos financeiros canônicos

O contrato futuro de liquidação/estorno deve possuir chave idempotente escopada
por tenant e operação, com verificação do conteúdo associado:

- mesma chave + mesmo conteúdo: retornar o resultado já produzido, sem novo
  efeito financeiro;
- mesma chave + conteúdo diferente: rejeitar como conflito;
- falha parcial: não pode deixar projeção agregada e evento canônico divergentes;
- reprocessamento de integração: não pode criar uma segunda liquidação para a
  mesma evidência externa, mesmo após evento repetido ou fora de ordem.

Formato da chave, persistência, retenção, código de erro e política de limpeza
permanecem **PENDENTE**.

## 7. Conciliação Asaas

### 7.1 Semântica dos eventos

`PAYMENT_CONFIRMED` e `PAYMENT_RECEIVED` representam estados diferentes.

- `PAYMENT_CONFIRMED`: confirmação do pagamento pelo provedor; não deve ser
  interpretada automaticamente como valor disponível para uso.
- `PAYMENT_RECEIVED`/`RECEIVED`: em cobrança processada pelo Asaas, indica valor
  disponível na conta Asaas; o `billingType` precisa ser conferido. No fluxo
  `RECEIVED_IN_CASH`, o mesmo evento `PAYMENT_RECEIVED` informa recebimento em
  dinheiro fora do processamento financeiro do Asaas e não prova crédito na
  conta Asaas. Nenhum dos casos prova, por si só, depósito em banco externo.

Portanto, nenhum dos dois estados equivale necessariamente a depósito bancário.
O movimento de extrato/`financialTransaction` é evidência mais próxima de
movimentação de uma conta do provedor, mas a correspondência exata entre evento
de cobrança, disponibilidade no Asaas e depósito bancário depende do meio de
pagamento e permanece **PENDENTE**.

Recebimento em dinheiro não autoriza inferir entrada na conta Asaas. Um
recebimento disponibilizado na conta Asaas não autoriza inferir transferência
ou depósito bancário. Valor bruto da cobrança, taxa e valor líquido do movimento
devem permanecer explicáveis sem somar duas vezes o mesmo recurso. O fluxo de
`RECEIVED_IN_CASH` e os eventos de estorno/chargeback estão descritos na
[documentação oficial de eventos do Asaas](https://docs.asaas.com/docs/webhook-para-cobrancas).

### 7.2 Comportamento legado que precisa ser compatibilizado

Hoje, ao conciliar, `src/services/conciliacao.js` pode aplicar no alvo:

```text
valor_pago = valor da transação Asaas
data_pagamento = data da transação Asaas
```

Se o alvo já estiver baixado, o serviço apenas cria o vínculo e registra que a
baixa não foi aplicada. Se a conciliação criou a baixa, a transação recebe a
marca `conciliado_baixa = true`; ao desconciliar, somente essa baixa é desfeita.
Baixas manuais anteriores não são revertidas pela desconciliação.

Esse comportamento deve continuar reconhecido durante a migração para evitar
duplo efeito. No modelo canônico, conciliação e liquidação devem ter identidades
separadas mesmo que um comando de negócio possa, futuramente, coordená-las de
forma transacional.

### 7.3 Regras mínimas de segurança sem decidir novas regras de negócio

- repetir a mesma transação externa não pode gerar nova baixa;
- uma transação externa já conciliada não pode produzir segundo efeito interno
  por outro caminho automático;
- igualdade de valor não basta para conciliar automaticamente;
- desconciliação deve preservar pagamentos que não foram criados pela própria
  conciliação;
- eventos repetidos ou fora de ordem devem ser correlacionados por identidade
  externa e estado conhecido, sem segunda liquidação ou disponibilidade
  antecipada; transição incompatível exige revisão;
- reembolso/estorno do provedor e chargeback exigem evidência de conclusão,
  vínculo com o fato original e tratamento explícito de liquidação e movimento
  de conta; contestação aberta não equivale automaticamente a estorno concluído;
- diferenças ou combinações não suportadas devem virar pendência de revisão,
  não ajuste financeiro implícito.

## 8. Tenant e RLS

Todos os fatos canônicos e projeções de compatibilidade devem carregar ou
derivar de forma inequívoca o `tenant_id`. Chaves idempotentes, identidades de
origem, buscas, conciliações, eventos, movimentos, fechamentos e backfills devem
ser escopados por tenant.

Estado conferido:

| Tabela | RLS habilitado | `FORCE RLS` | Observação |
|---|---:|---:|---|
| `gateway_transacoes` | sim | não identificado | Política por tenant existe. |
| `custos_recorrentes` | sim | não identificado | Política por tenant existe. |
| `apresentadora_pagamentos` | sim | não identificado | Política por tenant existe. |
| `receita_titulos` | sim | sim | `FORCE ROW LEVEL SECURITY` presente. |
| `receitas_avulsas` | sim | sim | `FORCE ROW LEVEL SECURITY` presente. |

A decisão de quando e como aplicar `FORCE RLS` às três tabelas com a lacuna é
**PENDENTE**. Este documento não altera políticas nem permissões.

## 9. Compatibilidade e migração aditiva

### 9.1 Princípio

A migração deve ser aditiva. O modelo canônico é introduzido sem apagar o
legado antes da comparação e sem inventar histórico que o schema atual não
permite comprovar.

Durante a transição, `valor_pago` e `data_pagamento` existentes podem continuar
como projeção de compatibilidade para leitores legados. Eles não devem permanecer
como escritores independentes depois que o domínio correspondente migrar para o
serviço canônico.

### 9.2 Backfill

Para um registro que contém apenas `valor_pago` agregado e uma única
`data_pagamento`, não é possível afirmar que houve uma ou várias liquidações.
Quando não existir evidência adicional confiável, o backfill deve representar a
posição histórica como legado explicitamente identificado, preservando valor,
data declarada, origem e proveniência da transformação.

O backfill deve ser reexecutável sem duplicação e manter vínculo inequívoco com
o registro de origem.

### 9.3 Shadow

Sequência esperada:

```text
preparação -> shadow -> comparação -> cutover
```

No shadow, legado e modelo canônico calculam suas projeções sobre o mesmo
retrato e a mesma data de referência. Shadow não cria cobrança, pagamento,
conciliação ou outro efeito financeiro autônomo.

A comparação deve ocorrer pelo menos por tenant, registro de origem,
componente, saldo, realizado e semântica de data. Totais globais iguais não
compensam divergências entre registros.

### 9.4 Cutover

O caminho de leitura só deve migrar quando divergências inexplicadas estiverem
zeradas ou formalmente aprovadas. O writer canônico deve ser a única autoridade
para o domínio convertido antes de desligar a projeção legada como fonte de
escrita.

### 9.5 Rollback

Rollback de leitura deve poder voltar temporariamente à projeção legada sem
apagar eventos canônicos já registrados. Eventos criados após o cutover devem
ser preservados. Rollback não pode reativar um escritor legado independente que
duplique efeitos com o writer canônico.

## 10. Mapeamento dos escritores atuais

| Arquivo | Escrita atual relevante | Relação com o modelo canônico |
|---|---|---|
| `src/services/receitas-comercial.js` | Gera/atualiza títulos; receber sobrescreve `valor_pago` e `data_pagamento`; desfazer zera a baixa; perda/reativação mutam estado. | Deve futuramente projetar baixas a partir de liquidações/estornos sem perder compatibilidade dos títulos. |
| `src/services/receitas-avulsas.js` | Recebimento grava total agregado/data única; desfazer zera; perda/reativação mutam estado. | Mesma transição para eventos individuais e projeção compatível. |
| `src/services/conciliacao.js` | Vincula transação externa a alvo; pode materializar alvo virtual e aplicar baixa; desconciliação desfaz somente baixa marcada como criada pela conciliação. | Deve preservar idempotência e separar identidade de conciliação da identidade de liquidação. |
| `src/services/conciliacao.js:435-466,515-521` | Para imposto virtual, chama `pagarImposto` e materializa/baixa `custos`; para desfazer conciliação de custo ou imposto, atualiza `custos.valor_pago` e `data_pagamento` diretamente para `NULL`. | Os dois caminhos de imposto e a escrita direta de desfazer entram no inventário de conversão. |
| `src/services/apresentadoras-pagamentos.js` | Upsert de pagamento agregado por apresentadora/competência/componente; desfazer limpa; cancelamento/reativação mutam estado. | Deve migrar para obrigação + liquidações/estornos mantendo a projeção por componente. |
| `src/services/financeiro-agregador.js` | Materializa impostos em `custos`, grava baixa agregada, soma `valor_pago` por data, lê/grava corte e saldo de abertura. | Leitores devem migrar para projeções canônicas comparadas em shadow; configuração de caixa depende da decisão sobre contas. |
| `src/routes/financeiro.js:857-920` | Rotas manuais de imposto chamam `pagarImposto`/`desfazerImposto` e também cancelam/reativam imposto via agregador. | O caminho manual é escritor indireto de `custos` e deve migrar junto com o serviço chamado. |
| `src/routes/financeiro_custos.js` | Cria custos, paga atualizando `valor_pago`/`data_pagamento`, desfaz limpando campos, cancela/reativa. | Deve futuramente delegar baixa/estorno ao comando canônico aprovado. |

Este mapeamento descreve escritores existentes; não autoriza alteração deles
nesta entrega.

## 11. Decisões PENDENTES

Esta tabela registra as alternativas abertas quando a FIN-01B foi escrita. As
decisões posteriores de Lucas e os padrões técnicos adotados estão em
[financeiro-decisoes-v1.md](financeiro-decisoes-v1.md); quando houver conflito,
usar o registro de decisões mais recente.

| Decisão PENDENTE | Responsável | Impacto | Alternativas a avaliar |
|---|---|---|---|
| Representação física do dinheiro, escala, limites e transporte na API | Lucas + Financeiro + Engenharia | Afeta precisão, contratos, migrations e interoperabilidade | `NUMERIC` com escala definida; centavos inteiros; outra representação exata documentada. |
| Regra determinística para resíduos de arredondamento | Lucas + Financeiro | Afeta parcelamento, rateio, estorno e reconciliação | Maior resto; primeira parcela; última parcela; regra específica por domínio. |
| Escopo de contas controladas e fronteira da abertura | Lucas + Financeiro | Define saldo, ledger, migração e dupla contagem | Conta Asaas isolada; contas bancárias + Asaas; outro escopo explícito. |
| Estrutura física de conta/ledger | Lucas + Financeiro + Engenharia | Necessária para movimentos e saldo canônico | Conta + movimentos imutáveis; estrutura mínima por provedor; outra modelagem aprovada. |
| Identidade geral da obrigação ajustada com ajustes, cancelamentos e reversões | Lucas + Financeiro + Engenharia | Define saldo aberto, perdas, cancelamentos e comparação de migração | Ajuste altera base e cancelamento encerra saldo em evento separado; cancelamento reduz base; outra fórmula explícita aprovada. |
| Cardinalidade e vínculo entre liquidação e movimento de conta | Lucas + Financeiro + Engenharia | Afeta taxas, dinheiro recebido fora do Asaas, datas e conciliação | Vínculos por componentes; vínculo opcional com movimentos múltiplos; outra relação justificada pelos casos reais. |
| Cardinalidade de conciliação além do caso atual 1 transação → 1 alvo | Lucas + Financeiro + Engenharia | Afeta splits, agrupamentos, interface e auditoria | Manter 1:1 no primeiro corte; 1:N controlado; N:M somente com casos comprovados. |
| Mapeamento Asaas de `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`/`RECEIVED`, `RECEIVED_IN_CASH`, `financialTransaction` e depósito bancário por meio de pagamento | Lucas + Financeiro + Engenharia | Define data efetiva, disponibilidade e caixa | Contrato por meio de pagamento; usar movimento de conta como autoridade de caixa; combinação de eventos com conciliação explícita. |
| Transições de eventos Asaas repetidos/fora de ordem e efeitos de reembolso, chargeback e contestação | Lucas + Financeiro + Engenharia | Evita dupla baixa, falso estorno e saldo de caixa incorreto | Revisão de estados ambíguos; transições por tipo de evento e meio de pagamento; outra matriz validada com evidência do provedor. |
| Tratamento de excedente do provedor/overpayment | Lucas + Financeiro | Afeta saldo do título e passivo/crédito não alocado | Bloquear manual e manter pendência não alocada; crédito formal; outra regra aprovada. |
| Formato, retenção e resposta de conflito da idempotência | Engenharia; Lucas se houver efeito de produto | Afeta reprocessamento, armazenamento e APIs | Chave fornecida pelo cliente; chave derivada de origem; registro dedicado com retenção definida. |
| Conversão de perdas/cancelamentos mutáveis para histórico de eventos | Lucas + Financeiro + Engenharia | Afeta auditoria e backfill | Evento legado único por estado atual; reconstrução apenas onde houver evidência; manutenção explícita de histórico incompleto. |
| Persistência e vínculo de fechamento versionado | Lucas + Financeiro + Engenharia | Afeta FIN-01A/FIN-03A, apuração e reabertura | Snapshot versionado; eventos + projeção; outra solução aprovada. |
| Momento e estratégia para adicionar `FORCE RLS` em `gateway_transacoes`, `custos_recorrentes` e `apresentadora_pagamentos` | Engenharia + revisão de segurança/Lucas | Afeta isolamento por tenant e comportamento de roles privilegiadas | Migration dedicada após teste; rollout por tabela; outra estratégia validada. |

## 12. Critérios de aceite do FIN-01B

FIN-01B está documentalmente pronto para revisão quando:

- o modelo lógico distingue obrigação, liquidação, estorno, movimento de conta,
  transação externa e conciliação;
- cardinalidades atuais e futuras não são presumidas além da evidência;
- a relação entre liquidação e movimento de conta e o tratamento geral de
  ajustes/cancelamentos permanecem PENDENTE para aprovação;
- `valor_pago` legado está definido como projeção de compatibilidade futura;
- política monetária exige exatidão e resíduo determinístico, sem escolher a
  representação física antes da aprovação;
- idempotência diferencia ingestão Asaas e comandos financeiros;
- `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`/`RECEIVED` e depósito bancário estão
  semanticamente separados;
- migração aditiva, backfill legado, shadow, comparação, cutover e rollback estão
  documentados;
- gaps de tenant/RLS são descritos sem alterar schema;
- escritores atuais estão mapeados;
- todas as regras ainda não aprovadas estão marcadas **PENDENTE** com responsável,
  impacto e alternativas.

## 13. Referências de código e migrations conferidas

- `migrations/162_gateway_transacoes.sql`
- `migrations/164_custos_reset_recorrentes_parcelas.sql`
- `migrations/165_receita_titulos_vencimento_condicoes.sql`
- `migrations/166_apresentadora_pagamentos.sql`
- `migrations/168_gateway_transacoes_baixa.sql`
- `migrations/169_financeiro_saldo_abertura.sql`
- `migrations/170_receitas_avulsas.sql`
- `migrations/172_apresentadora_pagamentos_componente.sql`
- `migrations/173_perdas_cancelamentos.sql`
- `migrations/177_apresentadora_pagamentos_cancelamento.sql`
- `src/services/receitas-comercial.js`
- `src/services/receitas-avulsas.js`
- `src/services/conciliacao.js`
- `src/services/apresentadoras-pagamentos.js`
- `src/services/financeiro-agregador.js`
- `src/services/asaas.js`
- `src/routes/financeiro.js`
- `src/routes/financeiro_custos.js`
