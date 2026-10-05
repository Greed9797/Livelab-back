# Financeiro — estado das entregas em 05/10/2026

Este quadro compara o handoff e o plano consolidado com as branches publicadas
`b4d5d72` (API) e `a705662` (painel). Código em PR rascunho não conta como
publicado. Revalidar estes hashes antes de usar o quadro em outra data.

| Entrega | Estado comprovado | Trabalho restante |
| --- | --- | --- |
| H01–H08 | Código publicado para gerar títulos, cadastro unificado, CI, backfill de marca promovida, paridade de comissões, margem, janela de 12 meses e caixa no DRE. | `.env.production` contém `VITE_CADASTRO_UNIFICADO=true`; validar o fluxo em sessão autenticada. O fallback de margem do painel foi publicado. |
| H09–H10 | CI de integração e execução serial de testes PostgreSQL configurados. | Registrar execução contra PostgreSQL de teste antes de liberar migrations novas. |
| H11 | Migrations antigas habilitam RLS nas três tabelas indicadas. | Consultar `pg_class.relforcerowsecurity` e o papel efetivo do banco de produção; não presumir `FORCE` a partir do código. |
| H12 | Inventário no handoff. | Revisar cada PR/branch mencionado com Lucas antes de fechar ou apagar. |
| H13 | Smoke Playwright de produção preparado. | Executar com conta de teste autorizada e somente leitura; registrar versão e resultado. |
| FIN-01A/01B | Contrato, modelo e decisões v1 no PR backend #71. | Reconciliar os trechos ainda marcados `PENDENTE` com as decisões aprovadas e fechar as regras que cada entrega subsequente usa. |
| FIN-02 | Perdas e reversões parciais de receitas, motivo, idempotência, trilha imutável e efeito no mês do registro publicados pelos PRs #72/#60. Testes locais, SQL PGlite e CI passaram; API e painel respondem com as novas versões. | Cancelamento de custos no mês do registro ainda não tem evento próprio. Reversão de perda legada requer reconciliação. Smoke autenticado de produção pendente. |
| FIN-03A | Schema aditivo de liquidação/estorno, serviço transacional e fechamento/reabertura versionados no PR #71, não publicados. | Integrar **todos** os escritores legados, conciliação e jobs; validar transições, papéis e snapshots com banco de teste antes da liberação. |
| FIN-03B | Não implementado. | Posição legada por origem, replay seguro, comparação paralela por tenant/título/componente e troca de leitura sem escritor independente. |
| FIN-04 | Listas, filtros e CSV legados existem. | Consulta única Receber/Pagar com filtros, paginação, totais e CSV no mesmo recorte; detalhe de eventos e filtros persistidos na URL. |
| FIN-06A | Não implementado. | Aging configurável pelo saldo elegível, data esperada e observação com histórico e permissões. |
| FIN-05 | Painel mensal legado existe. | Visão geral e fila de exceções apoiadas nas consultas validadas de FIN-04/06A. |
| FIN-07 | DRE, caixa e conciliação Asaas legados existem. | Saldo controlado **só Asaas** por conta/movimento, disponibilidade correta, projeção, resultados fechados e reconciliação sem duplicar baixa. |
| FIN-06B | Condicional. | Avaliar necessidade depois do uso de FIN-06A; não bloqueia os demais cortes. |

Ordem de liberação: FIN-02 → FIN-03A/03B → FIN-04/06A → FIN-05/07.
Schema aditivo pode preceder a troca de leitura, mas um relatório novo só é
liberado após comparação por registro e ausência de diferença monetária sem
explicação. A reversão de uma perda legada sem evento correspondente requer
tratamento explícito antes de poder preservar o Resultado histórico.
