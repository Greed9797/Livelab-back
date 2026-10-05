# Fechamento financeiro FIN-03A

`GET /v1/financeiro/fechamentos/:mes` devolve `estado`, `versao_atual`, `versoes` (snapshots fechados) e `eventos`, com `mes` em `AAAA-MM`. A competência sem eventos aparece como `aberto`, versão 0.

`POST /v1/financeiro/fechamentos/:mes` aceita corpo vazio e fecha a competência com um snapshot do `calcularDreMes` executado no servidor. Apenas `financeiro` e `franqueador_master` podem fechar. Repetir o fechamento de uma competência já fechada devolve 409.

`POST /v1/financeiro/fechamentos/:mes/reabrir` exige `{ "motivo": "..." }` e papel `franqueador_master`. Reabrir uma competência aberta devolve 409. O fechamento seguinte cria a próxima versão. Fechamentos e reaberturas gravam eventos imutáveis e audit log na mesma transação.

Recebimentos posteriores de títulos antigos continuam permitidos pelos escritores existentes e não alteram snapshots anteriores. O DRE vivo continua calculado pelas rotas existentes. O snapshot registra o documento de Resultados retornado por `calcularDreMes` no instante do fechamento, inclusive a data `hoje`; nenhuma quantia vem do cliente.

A migration é aditiva, não exige backfill e não modifica escritores existentes. O lock da linha do tenant serializa transições; falha no cálculo ou na auditoria desfaz toda a operação. Rollback operacional: desregistrar a rota; preservar a tabela histórica e seus snapshots para consulta/auditoria.
