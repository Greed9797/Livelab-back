# Financeiro v1 — decisões para implementação

Registro de 05/10/2026. Complementa [FIN-01A](financeiro-contrato-v1.md) e
[FIN-01B](financeiro-modelo-v1.md). As decisões abaixo orientam código novo;
nenhuma linha altera sozinha uma migration ou valor publicado. O legado só muda
depois de comparação por registro, testes e revisão do diff.

## Decisão dada por Lucas

| Tema | Regra aprovada | Consequência |
| --- | --- | --- |
| Perda ou cancelamento registrado após a competência da obrigação | O efeito no Resultado pertence ao **mês do registro do evento**; a competência de origem continua identificada na trilha. Reversão lança o efeito inverso no mês da própria reversão. | Não reescrever silenciosamente o Resultado histórico. Uma obrigação ainda aberta pode ter seu saldo encerrado na data do evento, e o valor pago antes continua preservado. |
| Fechar/reabrir competência | `financeiro` e `franqueador_master` podem fechar; somente `franqueador_master` pode reabrir. | Autorizar no servidor por tenant, com motivo e auditoria em reabertura. Usuários `financeiro_readonly`, `auditor`, `gerente`, `franqueado` e automação não recebem esses comandos por inferência. |
| Escopo do saldo controlado novo | **Somente a conta Asaas** nesta fase. | Abertura e movimentos devem referir a mesma conta e instante; o saldo agregado legado não é presumido saldo Asaas nem somado ao saldo novo. Contas bancárias externas ficam fora do primeiro corte. |

## Padrões financeiros e técnicos aprovados para o primeiro corte

| Tema | Regra v1 | Limite e verificação |
| --- | --- | --- |
| Dinheiro | Persistir valores exatos em `NUMERIC(15,2)`, compatível com as obrigações atuais. Percentuais são calculados em precisão maior e arredondados apenas no ponto de materialização definido pelo cálculo. | Não usar `Number` como autoridade de igualdade monetária. Verificar extremos, serialização da API e comparação com o legado antes do cutover. |
| Resíduo | Divisão/rateio conserva o total original em centavos; distribuir centavos residuais pelo método do maior resto, com desempate por identificador estável. | R$ 100,00 dividido igualmente em três gera 33,34 + 33,33 + 33,33. Registrar memória do cálculo. |
| Liquidação manual | Rejeitar valor acima do saldo elegível; não truncar diferenças para zero. | Excedente observado no provedor fica como pendência não alocada, sem crédito fictício ou baixa duplicada. |
| Eventos | Liquidação, estorno, perda, reversão, cancelamento e ajuste têm identidade, valor, ator, motivo quando aplicável, data efetiva e instante de registro. Estorno referencia o evento original, que permanece recuperável. | Escrita e projeção de compatibilidade devem ser atômicas; histórico legado agregado é identificado como legado, sem parcelas inventadas. |
| Idempotência | Escopo por tenant e operação; mesma chave com mesmo conteúdo retorna o mesmo efeito, e mesma chave com conteúdo diferente é conflito. | Eventos Asaas repetidos ou fora de ordem não criam segunda baixa; estado incompatível vai para revisão. |
| Conciliação | Vínculo entre evidências internas e externas não gera movimento financeiro por si. Igualdade de valor isolada não prova vínculo. Primeiro corte suporta o caso atual de uma transação por alvo. | Não criar N:M genérico sem caso; taxas e movimentos de conta têm identidade separada. |
| Asaas | `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, recebimento em dinheiro, extrato da conta Asaas e depósito bancário são fatos distintos. Contestação não equivale a estorno concluído. | Só contar efeito na conta correspondente com evidência suficiente; diferenças ficam para revisão, sem ajuste automático. |
| Fechamento | Versão aprovada da apuração da competência permanece consultável. Receber depois um título antigo não exige reabrir o Resultado fechado; a baixa aparece na posição atual do título e no caixa da data da liquidação. Reabrir preserva versão anterior e requer motivo/auditoria. | Os papéis foram definidos acima. O conteúdo do snapshot e sua reconciliação ainda exigem implementação e testes antes de ativar o comando. |
| Corte | `data_corte` delimita reconstrução de caixa, sem apagar obrigações nem reescrever apurações históricas. Mudança retroativa de abertura/corte após fechamento exige operação auditada e revisão do fechamento afetado. | A API atual também filtra o DRE pelo corte; separar os eixos exige migração e comparação antes de trocar a leitura. |
| A receber / a pagar | Posição aberta é derivada da obrigação válida e pagamentos líquidos; receitas e custos são apresentados separadamente. Uma janela de UI não altera a existência da obrigação. | Obrigações antigas com dados insuficientes para afirmar atraso ficam sinalizadas para revisão, sem acusação automática. A consulta v1 declarará corte, horizonte e regra de elegibilidade. |
| Data esperada | Previsão de caixa é campo distinto de vencimento contratual; editá-la não quita, prorroga nem apaga atraso. | Permissão de edição segue a política de acesso financeiro aprovada; manter motivo e histórico da alteração. |
| Segurança e auditoria | Novos fatos são tenant-local e protegidos por RLS com `FORCE`. Comandos de fechamento, reabertura, ajuste e estorno exigem trilha persistida na mesma transação; falha da trilha aborta o comando. | Auditar as roles reais e testar migrations em PGlite/Postgres antes de aplicar `FORCE` às tabelas legadas. Nunca registrar token ou dado sensível. |

## Dados operacionais necessários na virada

Antes da primeira ativação do saldo por conta, registrar um snapshot verificável
da conta Asaas com data/hora, valor e tenant; comparar com o legado sem copiar
automaticamente `financeiro_saldo_abertura`. A migração de dados reais e a
troca de leitura exigem ensaio e revisão do resultado por tenant. Isso não
bloqueia schema aditivo nem comandos que não dependem de saldo por conta.
