# Livelab API — guia de trabalho

Leia `AGENTS.md` antes de alterar o repositório. O painel React fica em `~/Livelab-Front/react-app`.

## Executar e verificar

```bash
npm ci
npm test
npm run test:integration
TEST_PG_URL=... npm run test:pg
```

`npm test` usa mocks para `db.query`; não valida SQL real. A integração usa PGlite. Os testes `*.pg.test.js` exigem `TEST_PG_URL` de um banco de teste e rodam sem paralelismo para evitar deadlock da migration 165. Testes pulados por ausência dessa variável não contam como validação em Postgres real.

## Produção

- API: `https://liveshop-saas-api-production.up.railway.app`.
- Branch publicada pelo Railway: `codex/blumenau-operational-fase1`. Push nessa branch inicia deploy automaticamente.
- `railway.json` executa `node apply_migrations.js` antes de servir o novo container. Toda migration precisa entrar em `MIGRATIONS_LIST`, ser idempotente e compatível com a versão anterior da API durante essa janela.
- Verifique `/readyz` e as rotas afetadas após cada deploy. Uma rota autenticada pode responder 401 sem credencial; 404 indica que a rota não está disponível.

## Financeiro e cadastro

- O cadastro unificado usa `/v1/cadastros`; a marca é a entidade pública e a ficha em `clientes` é seu complemento. A promoção a cliente preenche `lives.cliente_id` apenas nas lives antigas da mesma marca e tenant cujo vínculo estava vazio.
- A fila `/v1/comissoes/pendentes` exibe a comissão de franquia com a mesma regra de detalhe/export. O gate de aprovação continua baseado na comissão da apresentadora.
- A margem de contribuição prevista no DRE desconta perdas de receita. O painel procura atrasados nos 12 meses anteriores ao mês consultado, respeitando o corte financeiro.
- O DRE anual fornece `caixa.saldo_inicio_mes` por competência. Valor `null` significa caixa não configurado para o mês; zero é um saldo válido.
- Rotas de dinheiro, horas, assiduidade e comissões precisam de revisão da semântica SQL e das fronteiras de tenant. Consulte `src/lib/metric-sql.js` antes de criar outra expressão de horas.

## Segurança e limites de validação

As migrations de `custos_recorrentes`, `apresentadora_pagamentos` e `gateway_transacoes` habilitam RLS, mas não declaram `FORCE ROW LEVEL SECURITY`. Confirme o estado real do banco e o papel da conexão antes de propor DDL; não trate a leitura das migrations como prova do estado de produção.
