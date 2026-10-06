# Financeiro sem Asaas — execução a partir da PR #71

Base de código: `codex/handoff-back-20261005` (`2261fd7`), comparada com a base de produção `codex/blumenau-operational-fase1`. O CI da PR #71 passou no commit de base. Este roteiro aplica o plano de 05/10 sem inferir dados financeiros ou decisões de operação.

Roteamento: domínio financeiro e dados multi-tenant; complexidade 5; risco alto para dinheiro, RLS e produção. Integrador é dono dos contratos e da liberação. Agentes GPT-6 Sol recebem mudanças de arquivos exclusivos; exploradores/revisor usam modelos menores. Revisão independente é obrigatória antes de cada publicação.

## Aceite e limites

- Todo fato de baixa convertido mantém `NUMERIC(15,2)`, tenant, transação, idempotência e projeção legada coerente. Estorno referencia a baixa original.
- Nenhuma troca de leitura ocorre até comparar por tenant, origem, título e componente no mesmo retrato e explicar toda diferença monetária.
- Receber e Pagar compartilham filtros, ordenação, paginação, totais e CSV do mesmo recorte. O CSV neutraliza fórmulas.
- Aging soma apenas saldos abertos elegíveis, sem sobrepor faixas; data esperada e observação preservam histórico e não alteram vencimento.
- Visão geral e Resultados consomem cálculos do servidor. Saldo não configurado e legado incompleto não aparecem como zero confirmado.
- RLS é conferido no PostgreSQL real; produção recebe smoke autenticado com contas de teste antes da declaração de conclusão.
- Fora deste corte: integração Asaas, cobrança automática, alterações de comissão/rateio/tributação e operação sobre títulos reais de clientes por teste.

## Estado verificado

1. A branch da PR #71 já contém liquidações canônicas para receita comercial/avulsa, custos, apresentadoras e impostos, além de perdas e fechamento versionado. A descrição da PR ainda lista parte desses escritores como pendentes; confirmar os gates antes de atualizá-la.
2. `src/services/conciliacao.js` ainda escreve `valor_pago` diretamente; o bloco Asaas permanece fora de escopo e não habilita cutover dos alvos tocados por ele.
3. `src/services/financeiro-liquidacoes-read.js` oferece totais e datas por obrigação; ainda não há posição legada identificada nem comparação de shadow em produção.
4. Não há `TEST_PG_URL` nem variáveis `E2E_*` nesta sessão. O gate de RLS real e o smoke autenticado dependem de acesso seguro.
5. O revisor encontrou um bloqueio de transação nos caminhos Asaas que chamam comandos canônicos dentro de um `BEGIN` externo. A compatibilidade será tratada antes de publicar a PR #71; a implementação completa de Asaas permanece fora deste corte.

## Cortes e paralelismo

| Corte | Dono técnico | Gate de avanço |
|---|---|---|
| A. Integridade | Backend e revisor de dinheiro/RLS | Testes de escritores, PGlite com casos de parcial/estorno/conflito, diferenças legado × canônico por registro, ensaio de rollback |
| B. Operação | Backend consultas + frontend telas em arquivos separados | Mesmo conjunto em lista/totais/CSV, permissões, paginação e estados de erro/vazio/legado |
| C. Aging e Visão geral | Backend métricas + frontend detalhe/painel | Faixas aprovadas, histórico auditável, projeção somente com base de caixa validada |
| D. Caixa/Resultados | Backend saldo/versionamento + frontend leitura | Abertura, conta, data/hora e movimento reconciliados; sem dupla contagem |
| E. Publicação | Integrador + revisor independente | `npm test` back; typecheck/test/build front; PostgreSQL real e RLS; PRs revisadas; smoke autenticado; rollback disponível |

Agentes de leitura podem auditar cortes diferentes em paralelo. Agentes de código recebem arquivos exclusivos e não alteram migrations nem comandos compartilhados simultaneamente. O integrador revisa o diff e os contratos após cada lote.

## Ativação segura

Migrações são aditivas e idempotentes; registrar cada uma em `MIGRATIONS_LIST` e aplicá-la duas vezes em PostgreSQL de teste. Shadow é somente leitura. Se houver diferença não explicada, manter leitores atuais e registrar a divergência por origem. O retorno de versão preserva fatos novos e nunca reativa escrita direta de `valor_pago` em domínios convertidos. Publicar cada corte com evidência de versão e smoke antes de avançar.

## Ferramentas de verificação preparadas

- `npm run test:integration` executa os fixtures PGlite do histórico, incluindo custos e apresentadoras. Não usa banco de produção.
- `FIN_TENANT_IDS=<uuid> TEST_PG_URL=<url> node scripts/compare-financeiro-legacy.js` compara cinco origens em snapshot somente leitura e termina com código 1 se houver diferença por obrigação. Com acesso autorizado, `DATABASE_URL` substitui `TEST_PG_URL`; o comando não muda fatos nem projeta lançamentos.
- `DATABASE_URL=<url> node scripts/audit-rls.js` exige `ENABLE` e `FORCE` nas três tabelas antigas sensíveis e nas duas tabelas de fatos canônicos, além de verificar papel efetivo e políticas. O código das migrations antigas só mostra `ENABLE`; a auditoria real ainda é necessária.

## Implementado neste corte local

- FIN-03B: comparação por obrigação em uma instrução SQL/snapshot, incluindo componente da origem quando existe, natureza, estornos, ausência em cada lado e valores decimais exatos. CLI por tenant em transação `REPEATABLE READ READ ONLY`. O script observa diferenças; não executa replay ou troca de leitor.
- FIN-04: API única de consulta e CSV com filtro, ordenação estável, paginação e totais antes da paginação; valores em texto decimal e erro para dados monetários ausentes. Abas Receber/Pagar usam o mesmo contrato e preservam filtros na URL.
- FIN-06A: aging por vencimento contratual, faixas disjuntas explícitas e omissão de obrigações ambíguas. A data esperada e o histórico de observações ainda exigem contrato de permissões e migration aprovados.
- FIN-05: visão geral e fila de exceções derivadas da consulta FIN-04, com estado `incompleto` ou `vazio` sem publicar um saldo zero enganoso. Novo painel exibe esses estados.
- FIN-07: painel de versões do fechamento já existente. O saldo controlado da conta Asaas depende da conta, data/hora, saldo inicial verificável e integração de extrato; não foi calculado a partir do caixa legado.

## Gates observados e pendências de publicação

- PGlite integrado passou, inclusive escritores de custos/apresentadoras, comparação por obrigação, perdas e fechamento. Testes focados das rotas novas e frontend passaram; typecheck, lint e build do frontend passaram. Executar novamente os gates após qualquer edição posterior.
- O teste de CLI do backend exige socket local e passou fora do sandbox. A suíte backend completa está em execução fora do sandbox; só uma conclusão verde vale como gate.
- Antes de cortar leitores: posição legada/replay auditável, comparação real por todos os tenants e nenhuma diferença monetária inexplicada. Evitar migrar histórico agregado como parcelas inventadas.
- Antes de publicar: resolver a compatibilidade transacional da conciliação Asaas existente com os escritores convertidos, auditar RLS com o papel real da API em PostgreSQL, executar smoke autenticado com contas de teste e revisar o diff final. Não há credenciais PostgreSQL/E2E disponíveis nesta sessão.
