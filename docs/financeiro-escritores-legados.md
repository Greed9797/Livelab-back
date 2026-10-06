# FIN-03A/03B — escritores de baixa a converter

Inventário em 05/10/2026. Este arquivo acompanha o contrato de
[decisões financeiras v1](financeiro-decisoes-v1.md). A migration 180 e o
serviço `financeiro-liquidacoes-command.js` não mudam os fluxos abaixo até
que cada caminho seja convertido e testado.

| Origem | Escrita atual | Risco ao converter |
| --- | --- | --- |
| Título comercial | `receitas-comercial.js`: `receberTitulo`, `desfazerRecebimento` | A API define total acumulado; redução não pode virar estorno implícito. Há ID virtual `calc:` que materializa título. |
| Receita avulsa | `receitas-avulsas.js`: `receberReceitaAvulsa`, `desfazerReceitaAvulsa` | Aporte precisa continuar fora da receita operacional; baixa atual substitui total. |
| Custo manual, recorrente e parcela | `routes/financeiro_custos.js`: `/:id/pagar`, `/:id/desfazer` | Pagamento grava total em `custos.valor_pago`; custo virtual pode ser materializado pelo resolvedor. |
| Apresentadora | `apresentadoras-pagamentos.js`: `registrarPagamentoApresentadora`, `desfazerPagamentoApresentadora` | Upsert por tenant/apresentadora/competência/componente substitui valor e data; fechamento/previsto do componente deve permanecer íntegro. |
| Imposto | `financeiro-agregador.js`: `pagarImposto`, `desfazerImposto` | Upsert em `custos` por competência; base do imposto e baixa são fatos distintos. |
| Conciliação Asaas | `conciliacao.js`: `darBaixaConciliacao`, `desfazerBaixaConciliacao` e funções de baixa por tipo | O mesmo título pode receber baixa manual e transação do provedor. Vínculo não cria segunda liquidação; cancelar vínculo não é estorno automático. |

Antes de trocar cada escritor, testar sob o mesmo lock: pagamento novo, replay
idêntico, chave conflitante, corrida contra saldo, estorno parcial, transação
falha, outro tenant e projeção legada. Confirmar que nenhuma rota, job ou
integração mantém atualização independente de `valor_pago`. A leitura nova
deve ser comparada por origem e tenant com o legado no mesmo instante; não
basta igualdade do total consolidado.
