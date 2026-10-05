# Financeiro — execução do plano consolidado

Estado verificado em 05/10/2026. Fonte de escopo: `PLANO-FINANCEIRO-LIVELAB-CONSOLIDADO-2026-10-05.md` fornecido pelo Lucas. Este registro distingue propostas do plano, código existente e verificações executadas.

## Base publicada e classificação

| Frente | Estado verificado | Evidência |
| --- | --- | --- |
| API | Commit `b95bff9` em `codex/blumenau-operational-fase1`; `/health` retornou o SHA e `/readyz` 200 | Railway, 05/10/2026 |
| Painel | Commit `c1eed56` em `feat/multi-apresentadora-agenda`; GitHub Actions concluiu com sucesso | Run `37260793508`; `version.json` passou a `1791172127820` |
| Testes da API | 1.826 aprovados; integração PGlite aprovada | `npm test`, `npm run test:integration` |
| Testes do painel | 812 aprovados; typecheck e build aprovados | `npm run typecheck`, `npm run test`, `npm run build` |

Domínio: financeiro multi-tenant. Complexidade: alta. Risco: dinheiro, acusação de inadimplência, permissões e migrações. Execução: agentes web em partes delimitadas, revisão do coordenador e validação específica por etapa. Mudanças de dados, schema, segurança e produção requerem decisão explícita antes de serem aplicadas.

## Gate documental atual

- [Contrato FIN-01A](financeiro-contrato-v1.md): nove métricas, eixos de data, janela/corte atuais, matriz de permissões e decisões abertas. A revisão independente de aderência ao plano foi aprovada; o conteúdo ainda aguarda aprovação de Lucas.
- [Modelo FIN-01B](financeiro-modelo-v1.md): fatos financeiros, invariantes propostas, idempotência, Asaas, escritores legados, migração aditiva e política monetária pendente. A revisão independente de aderência ao plano foi aprovada; o conteúdo ainda aguarda aprovação de Lucas.
- Revisão técnica local: referências principais a papéis, allowlist, RLS e filtros de caixa/DRE foram confrontadas com o código. Uma sessão adicional de revisão por subagente caiu antes de ler os arquivos, portanto ela não fornece parecer.
- FIN-02 a FIN-07 não foram implementadas nesta rodada: dependem do aceite das regras registradas nos dois documentos. Não há schema, liquidação, saldo ou permissão nova em produção por efeito deste gate.
- H03 continua local no commit `375ced3`: uma nova tentativa de push foi rejeitada pelo GitHub porque o OAuth ativo não possui escopo `workflow`. `gh auth status` também reportou credencial inválida. Publicar depois de renovar a credencial com esse escopo.

## Reconciliação do handoff

| Item | Estado no código | Verificação ou pendência |
| --- | --- | --- |
| G01 | Repositórios e branches publicados conferidos | Instruções locais e commits lidos; registro no Todoist ainda aberto |
| H01 | Botão “Gerar títulos” publicado | Visível na aba Receita; nenhuma geração disparada na verificação |
| H02 | Criação/edição roteadas por `/v1/cadastros` | Flag de produção ligada em `.env.production`; formulário verificado sem gravar cliente |
| H03 | Patch de CI preparado no commit local `375ced3` | Git local recusou push por falta de escopo `workflow`; conector GitHub retornou 403 |
| H04 | Promoção preenche `lives.cliente_id` vazio da mesma marca/tenant | Testes unitários/PGlite; teste `*.pg.test.js` pulou sem `TEST_PG_URL` |
| H05 | Pendentes mostra comissão de franquia como detalhe/export | Testes existentes atualizados |
| H06 | Margem prevista desconta `perdas.receita.valor` | Fórmula em produção; confirmar semântica temporal no contrato FIN-01A |
| H07 | Backend consulta 12 meses, igual à lista do painel | Respeita corte aplicado aos lançamentos |
| H08 | DRE anual tem caixa inicial por mês; sem corte é “Não configurado” | API PGlite e tela autenticada verificadas |
| H09–H10 | Fixtures PGlite corrigidas; `test:pg` serializado | Falta execução em Postgres real |
| H11 | Fonte das três tabelas usa `ENABLE ROW LEVEL SECURITY` | Sem `FORCE` nas migrations; papel/estado real do banco ainda não auditados |
| H12 | PRs revisados em leitura na rodada anterior | Nenhum PR fechado ou mesclado automaticamente |
| H13 | Tela autenticada aberta em produção; smoke só de leitura preparado | Script não executado com conta de teste: `E2E_EMAIL`/`E2E_PASSWORD` ausentes |

O estado dos cartões do Todoist não foi alterado nesta rodada; títulos abertos não demonstram ausência de código publicado.

## Cortes do plano

1. **Contrato e modelo (FIN-01A/01B):** levantar fórmulas, fontes, eixos de data, regras existentes, papéis, tabelas, comandos e decisões pendentes. Publicar artefatos para revisão de negócio.
2. **Integridade (FIN-02/03A/03B):** só alterar perdas, liquidações, fechamento, escrita canônica e migração depois do aceite das regras correspondentes. Preservar trilha histórica e escritores legados durante preparação/shadow.
3. **Operação diária (FIN-04/06A/05):** compartilhar filtros/totais/CSV de Receber e Pagar; aging por saldo elegível; data esperada separada do vencimento; Visão geral somente com indicadores validados.
4. **Evolução (FIN-07):** caixa por conta/data, resultados versionados e conciliação de evidências sem movimentação duplicada. FIN-06B continua condicionado à necessidade demonstrada.

Cada corte exige testes por tenant e papel, SQL em Postgres real quando houver nova query financeira, comparação por registro e plano de retorno que preserve eventos já gravados. Dados reais não são mutados por testes de aceite.

### Lacunas confirmadas na leitura do painel

- FIN-02: o modal de perda hoje mostra “Motivo (opcional)” e o serviço omite o motivo vazio. A reversão não pede justificativa própria. Exige decisão de auditoria e contrato do servidor antes de tornar a validação obrigatória.
- FIN-04: `useLancamentos` carrega a coleção e os filtros/CSV operam no navegador. Se houver paginação no servidor, lista, totais e CSV precisarão compartilhar um recorte explícito para não exportar só a página.
- FIN-06A: não há `data_esperada` nem buckets de aging no contrato do painel. O cálculo deve nascer no backend depois da definição de faixas e universo elegível.
- FIN-05: `PainelMes.tsx` já fornece a base para Visão geral; as exceções ainda não têm contrato/API próprios. Não recalcular indicadores na tela.

### Lacunas confirmadas na leitura da API

- `receita_titulos`, `receitas_avulsas`, `custos` e `apresentadora_pagamentos` guardam `valor_pago` e uma `data_pagamento` na própria obrigação. Não há evento individual que recupere duas baixas em datas diferentes.
- `gateway_transacoes` preserva o extrato Asaas com unicidade por tenant e ID externo. Hoje `/v1/asaas/conciliar` pode criar a baixa; desfazer a conciliação pode desfazer essa baixa. Separar vínculo de efeito financeiro exige contrato e migração, não renomear a rota.
- Caixa deriva de abertura no tenant e pagamentos agregados; não há conta financeira nem ledger de movimentos por conta. Um saldo novo deve ser comparado por registro/conta antes da troca de leitura.
- Perda, cancelamento e “desfazer” são estados mutáveis; reativar pode limpar campos de auditoria, e alguns fluxos apagam linhas. Não é possível reconstruir pagamentos históricos individuais a partir de um total legado.
- Não há fechamento financeiro versionado geral. Fechamentos operacionais/comerciais existentes não fornecem esse contrato.

### Evidência externa para FIN-07

A [documentação de eventos de cobrança da Asaas](https://docs.asaas.com/docs/webhook-para-cobrancas) distingue `PAYMENT_CONFIRMED` (pagamento efetuado, saldo ainda indisponível) de `PAYMENT_RECEIVED` (saldo disponível). A [documentação de idempotência](https://docs.asaas.com/docs/como-implementar-idempotencia-em-webhooks) descreve reenvio do mesmo evento com o mesmo ID e não garante ordem. A arquitetura proposta deve persistir/deduplicar esse ID e tratar evento fora de ordem; decidir o lançamento interno de cada evento é uma **inferência de negócio** pendente de aprovação. `PAYMENT_RECEIVED` não deve exigir `PAYMENT_CONFIRMED` anterior para todos os meios de pagamento, e recebimento em dinheiro não implica depósito Asaas.

## Decisões abertas para Lucas

- Aprovar o dicionário FIN-01A: fórmula temporal de perdas na margem, universos de vencido/atrasado, corte de caixa e distinção entre apurado/consolidado.
- Aprovar FIN-01B: precisão monetária, resíduo, limite de baixa, contas cobertas, posição legada e cardinalidade de conciliação.
- Definir papéis reais para perda, estorno, fechamento/reabertura, ajuste, data esperada, conciliação, caixa e aporte.
- Disponibilizar ambiente Postgres de teste para validar SQL e migrações sem tocar produção.
- Disponibilizar credencial GitHub com permissão de editar workflow para H03 e conta de teste para automatizar H13. Não inserir segredos em cartões ou neste documento.

Até cada decisão, os fluxos correspondentes podem ser desenhados e testados de forma isolada, sem ativar nova escrita financeira em produção.
