# Plano de execução do Financeiro — 05/10/2026

Planejamento produzido com GPT-6 web e reconciliado com o código dos dois repositórios. Base: API `codex/handoff-back-20261005` (PR #71 draft) sincronizada com a produção; painel `codex/handoff-front-ci`. FIN-02 de receitas já está publicado. Implementação em cortes pequenos com agentes GPT-5.6 Terra e revisão do integrador.

## Contrato e limites

- Valores exatos `NUMERIC(15,2)`; idempotência por tenant e operação, com conflito para payload diferente. Evento e projeção legada na mesma transação. Estorno referencia liquidação original.
- Perda ou cancelamento afeta o Resultado no mês do registro. `financeiro` e `franqueador_master` fecham; só master reabre. Saldo controlado novo cobre somente Asaas.
- Preservar aportes fora da receita operacional, fórmulas de comissão/rateio, regras de vencimento e o corte existente até comparação demonstrada. Histórico agregado anterior não vira parcelas inventadas.
- Nenhum writer convertido pode continuar gravando `valor_pago` de forma independente. Erros ambíguos de conciliação ficam para revisão; vínculo externo não cria dinheiro.

## Corte 1 — completar escrita e cancelamentos (FIN-02/03A)

1. **Custos manuais/recorrentes:** integrar `src/routes/financeiro_custos.js` e `src/services/custos-plano.js` ao comando canônico; testar pagamento parcial, estorno, legado, tenant, idempotência e custo cancelado em PGlite. Registrar cancelamento/reativação auditável e ajustar o DRE para o mês do registro, inclusive imposto e apresentadora quando a regra for aplicada a essas origens. A migration correspondente deve ser aditiva e passar duas vezes.
2. **Apresentadoras:** integrar `src/services/apresentadoras-pagamentos.js` e `src/routes/financeiro_apresentadoras_pagamentos.js`; preservar chave por apresentadora, competência e componente; comparar o total antigo com os eventos. Testar a rota legada, pagamento parcial e cancelamento.
3. **Impostos:** converter as baixas e estornos em `src/services/financeiro-agregador.js` e `src/routes/financeiro.js`, mantendo a base e alíquota atuais. Testar recálculo e conflito entre previsão e baixa.
4. **Asaas e jobs:** adaptar `src/services/conciliacao.js`, rotas, webhooks e jobs inventariados. O comando precisa participar da transação externa sem `BEGIN` aninhado. Deduplicar evento do provedor e o mesmo fato vindo da baixa manual; `PAYMENT_CONFIRMED` não implica saldo disponível e `PAYMENT_RECEIVED` não liquida outra vez. Testar ordem invertida, reenvio, taxa, dinheiro e chargeback ambíguo.
5. **Estorno granular no painel:** expor fatos no detalhe e permitir escolher liquidação/valor; preservar o comportamento seguro do `desfazer` antigo, que retorna 409 para múltiplos fatos ou legado sem fatos equivalentes.

Os agentes A (custos) e B (apresentadoras) podem trabalhar em paralelo com arquivos exclusivos e sem editar `financeiro-liquidacoes-command.js`, migrations ou runner. O integrador conecta contratos compartilhados e testa após cada incorporação. Impostos e Asaas seguem em lotes posteriores, após revisão dos dois primeiros.

**Aceite:** todos os escritores inventariados usam a mesma trilha, `npm test` verde, SQL real/PGlite para dinheiro e RLS, teste de concorrência e rollback. Nenhum caminho de baixa direta remanescente nos domínios convertidos. FIN-03A continua draft até cumprir o corte inteiro.

## Corte 2 — FIN-03B, legado e troca de leitura

Criar posição legada por tenant/origem/título/componente, preservar data declarada sem inventar recebimentos, fazer replay seguro e comparar posição antiga/canônica sobre o mesmo retrato. Shadow é somente observação, sem segunda baixa. Classificar cada diferença e exigir zero divergência monetária inexplicada por registro, inclusive quando totais se anulam. Ensaiar rollback que preserve fatos novos e não reative escritor independente. Só então trocar leitores e considerar liberar o PR #71.

## Corte 3 — operação diária

- **FIN-04:** consulta única Receber/Pagar com eixo de data, filtros, ordenação, paginação, totais e CSV do mesmo recorte; detalhe lateral e URL persistente. Neutralizar fórmula em CSV. Distinguir erro, vazio, apuração, legado incompleto e zero.
- **FIN-06A:** aging pelo saldo aberto elegível e vencimento contratual, fronteiras configuráveis sem sobreposição; data esperada e observação com histórico, motivo e permissões. Previsão vencida pede revisão e não altera o vencimento.
- **FIN-05:** Visão geral e fila de exceções sobre as consultas validadas, sem outra fórmula no frontend e sem interpretar ausência de configuração como zero.

## Corte 4 — Caixa, Resultados e Conciliação (FIN-07)

Saldo inicial verificável da conta Asaas por tenant/data/hora; movimentos realizados, disponibilidade, taxa, projeção e versões de Resultado, sem somar extrato e liquidação duas vezes. Comparar com legado por conta e título antes do cutover. FIN-06B permanece condicional ao uso da FIN-06A.

## Handoff e gates de produção

- H11: consultar `pg_class.relrowsecurity/relforcerowsecurity`, políticas, owner e papéis efetivos para `custos_recorrentes`, `apresentadora_pagamentos`, `gateway_transacoes` no banco real. O código atual só comprova `ENABLE`, não `FORCE`.
- H12: preparar recomendação para PRs front #25/#28/#29/#31/#45 e back #18/#29 e branches `cursor/*`; Lucas decide cada fechamento/exclusão.
- H13: smoke Playwright autenticado em produção com conta de teste e variáveis `E2E_MASTER_*`, `E2E_FRANQUEADO_*`, `E2E_CLIENTE_*` configuradas com segurança. O smoke anônimo não substitui este gate.
- Backend: syntax, `npm test`, fixtures PGlite e PostgreSQL de teste sem paralelismo onde exigido, auditoria de dependências, revisão de diff/tenant/RLS, migration idempotente e compatível com o código anterior no preDeploy.
- Frontend: typecheck, testes, build, smoke de versão/login. Railway e Vercel fazem deploy automático nas branches de produção; cada corte exige evidência e rollback antes do merge.
