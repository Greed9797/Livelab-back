# Competências comerciais e DRE por caixa/vencimento

## Contrato entregue

- Exclusão lógica de uma condição interrompe cobrança até a próxima condição cadastrada. Não há herança da condição anterior. Nova criação pode preencher a lacuna.
- Edição/exclusão histórica usa prévia, motivo, revisão monotônica, chave de idempotência, transação e locks financeiros. Mês inicial é imutável.
- Títulos suspensos preservam identificadores, pagamentos e perdas existentes. Saldo aberto fica suspenso; geração automática e fechamento de marca não excluem esses títulos. Recriação restaura o mesmo título, sem repetir baixas.
- Alterar obrigação abaixo do valor já recebido informa excesso para tratamento financeiro explícito, sem estorno automático.
- DRE mensal/anual/detalhado usa `regime=caixa_vencimento` por padrão. Previsão segue vencimento; realizado segue cada liquidação/estorno. `competencia` continua disponível e fechamentos existentes mantêm esse regime explícito.
- Receita mensal expõe `recebimentos_mes.operacional`, `aportes`, `total` e eventos. O realizado operacional usa a mesma leitura do DRE. Recebimentos e saldos abertos não são conjuntos equivalentes.
- A leitura ocorre em snapshot consistente. Divergência entre projeção e eventos, ou pagamento legado sem data, recusa cálculo com `FINANCIAL_RECONCILIATION_REQUIRED`; a interface esconde valores antigos de cache após esse erro.

## Migração

`184_receita_titulos_suspensao_comercial.sql` adiciona JSONB nullable ao título e está registrada no runner. `cancelled_at` existente continua representando o limite da condição; o novo campo preserva o saldo suspenso no título, onde não existia marcador equivalente.

## Verificação

Suítes unitárias, contratos/renderização, SQL financeiro em PGlite e integração PGlite cobrem recebimento de competência anterior, parcelas, estornos, aportes, classificação, tenant, corte, idempotência, revisão, rollback e ciclo de suspensão/recriação. Nenhum teste acessa dados financeiros de produção.

Gate backend final: 206 arquivos, 1.944 testes aprovados; 14 arquivos/74 casos condicionados a ambientes externos ficaram ignorados pelo runner. Todas as 18 fixtures do gate de integração PGlite passaram. `git diff --check` limpo. Auditoria `npm audit --omit=dev` não apontou vulnerabilidades de produção em nenhum dos dois repositórios.

## Publicação e reversão

Publicação depende de autorização explícita. Subir backend/migração antes do frontend: a interface exige resposta de regime e prévia financeira do novo contrato.

Antes de habilitar operações históricas, verificar reconciliação do tenant com leitura autenticada. Não preencher datas ausentes nem criar eventos de compensação automaticamente. Divergências exigem correção auditável própria.

Antes de qualquer suspensão persistida, código pode voltar à versão anterior mantendo a coluna aditiva. Depois de uma suspensão, rollback do backend deve manter leitores e bloqueios compatíveis com o marcador; versão antiga pura pode reabrir cobrança indevida. Preferir correção progressiva. Pagamentos, perdas, auditoria e suspensões não devem ser apagados no rollback. Retificação financeira exige comando auditado, separado da reversão de código.
