# Continuação da fonte única financeira

## Escopo
Corrigir consumidores restantes de recebimentos/pagamentos que ainda atribuíram o valor acumulado à última data. A regra aprovada permanece: previsão pelo vencimento; realizado pela data de cada liquidação/estorno. Aporte é separado da receita operacional. Alíquotas, cálculo de competência e precedência de impostos já materializados permanecem os existentes.

## Correções
- Cobertura legado/canônico é verificada independentemente do mês consultado e da data de corte. Cobertura parcial, origem ausente ou natureza divergente bloqueiam o cálculo com 409, mesmo sem evento no mês.
- Erros de reconciliação expõem somente origem, identificador e motivo permitidos, sem valores, snapshots ou SQL.
- Leituras do Caixa, Painel, Fluxo e Lançamentos usam uma transação de snapshot, evitando que uma baixa entre consultas desloque os totais.
- Recebimentos mensais que alimentam a base já existente de imposto seguem os eventos, incluindo estornos no mês próprio. O patch não cria regras de compensação fiscal para meses negativos nem recalcula tributos materializados.
- Telas financeiras devem priorizar erros sobre dados antigos de cache, preservando loading de atualização normal.

## Aceite
1. Baixas de R$40 em setembro e R$60 em outubro aparecem nos respectivos meses em Receita, DRE, Caixa/Painel e Fluxo; nunca R$100 somente em outubro.
2. Estorno posterior é realizado negativo no mês do evento; aporte continua fora da base operacional.
3. Título de competência antiga remarcado tem previsão no mês de vencimento, respeitando corte por vencimento.
4. Divergência de cobertura fora do período exige reconciliação, sem inventar data ou movimento residual.
5. Erro 409 após sucesso oculta valores antigos e ações de baixa dependentes deles.

## Produção e reversão
Não executar reconciliação, replay, baixa, estorno ou alteração de condições em produção para validar o patch. Não há nova migração. Reversão de código deve manter compatibilidade com suspensões comerciais da entrega anterior; preservar eventos, auditoria e snapshots. A comparação integral legado/canônico e auditoria RLS do papel efetivo de produção continuam exigindo conexão autorizada indisponível nesta sessão.
