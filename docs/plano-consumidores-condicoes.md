# Inventário de consumidores de condições comerciais

Atualizado em 2026-09-16 para o lote contratual T5. Este documento é o baseline
verificável antes da escrita de `marca_condicoes_comerciais`. A fonte canônica
passará a ser a condição cuja `vigencia_inicio` seja o último primeiro dia de
mês menor ou igual à data do fato gerador. Campos atuais de `marcas` permanecem
compatibilidade até que cada leitor seja migrado.

## Regra e classificação

| Consumidor | Fonte atual | Fato gerador / competência | Destino no modelo temporal | Proteção |
| --- | --- | --- | --- | --- |
| `src/routes/marcas.js` POST/PATCH/import | `marcas.comissao_franquia_pct`, `comissao_franqueadora_pct`, `valor_fixo_minimo`, `tipo_cobranca` | cadastro da marca | PATCH financeiro será encaminhado ao serviço temporal; cadastro e identidade continuam no PATCH | condição criada com marco explícito, revisão e auditoria |
| `src/services/client-brand.js` | criação/espelho da marca do cliente; não calcula valores | criação da marca | preservar como escritor estrutural; baseline temporal é criado pelo backfill | FK composta e escopo do tenant |
| `src/lib/marca-sql.js` | resolve `marcas` por `l.marca_id` | data da live | trocar por lateral temporal em tarefa T9/T10 | nunca filtrar status ao contabilizar receita |
| `src/services/commission-engine.js` | percentuais da marca; grava `vendas_atribuidas` | `lives.iniciado_em` em São Paulo | resolver condição pela data da live e registrar `condicao_id` em novo snapshot | venda aprovada/snapshot não é reescrita |
| `src/routes/vendas_atribuidas.js` | percentuais da marca para criação/edição/reprocessamento | `vendas_atribuidas.data` ou data da origem | migrar cálculo em T12 | preservar divisão e bloquear aprovação fechada |
| `src/routes/lives.js` + `src/services/portal-apresentadora-aprovacao.js` | fechamento e snapshot de comissão | início/encerramento da live oficial | adaptar o escritor indireto em T12 | união/reversão mantém atribuição e lock financeiro |
| `src/jobs/recalcular_comissoes.js` e importações | recalcula linhas pendentes usando marca atual | data original da venda/live | resolver condição histórica em T9/T12 | somente linhas abertas; falha não zera comissão |
| `src/lib/performance-rollups.js` | fixa variável por marca e fixo mensal | cada mês com atividade | parcelas por competência em T10/T11 | não aplicar `MAX` ao intervalo inteiro |
| `src/routes/financeiro.js` | DRE/faturamento inline por marca e `valor_fixo_minimo` | mês da live/vídeo e competência do fixo | payload aditivo com parcelas em T10 | boleto/snapshot fechado preservado |
| `src/jobs/billing_engine.js` | comissão persistida e `contratos.valor_fixo` | quinzena/mês faturado | migrar leitura da entrada temporal em T11/T13 | lock `lockTenantLiveFinance`; gateway idempotente |
| `src/services/comissao-snapshot.js` | snapshot de comissão de apresentadora | origem da live | adicionar identificação da condição quando novo snapshot for gravado | snapshot existente é imutável |
| `src/services/reports.js`, `src/routes/relatorios.js` e PDF/CSV | agregados/snapshots e campos financeiros exportados | período do relatório | preservar snapshot fechado; adaptar somente leitores de cálculo em T11/T24 | PDF/CSV não pode usar valor corrente para fato histórico |
| `src/routes/cliente_insights.js`, `src/routes/cliente_dashboard.js` | contrato e agregados do cliente | mês consultado | migrar apenas se apresentar receita financeira; manter fonte declarada em T11 | escopo tenant e dados aprovados |
| `src/routes/contratos.js` e `src/services/contratos_auditoria.js` | contrato formal: `valor_fixo`, `comissao_pct` | vigência/status do contrato | entidade distinta; não copiar para condição de marca sem procedência | auditoria formal permanece separada |
| `src/services/live-merge.js` | topologia, faturamento e snapshots das lives | data das origens/destino | não recalcular condição; preservar condição identificada nos snapshots | lock financeiro e bloqueio de boleto |

## Evidência do inventário

O inventário foi conferido com busca no código versionado:

```text
rg -n 'valor_fixo_minimo|comissao_franquia_pct|comissao_franqueadora_pct|tipo_cobranca' src migrations test
rg -n 'contratos.*valor_fixo|valor_fixo.*contratos|comissao_pct' src/routes src/services src/lib src/jobs
```

As fontes de schema são `migrations/080_marcas_agenda_videos_vendas.sql`,
`090_comissao_metas_compat.sql`, `116_marca_fixo_mensal_semantica.sql`,
`132_marca_tipo_cobranca.sql`, `137_apresentadora_fixo_historico.sql` e
`141_comissao_apresentadora_snapshot_do_motor.sql`. A migration temporal nova
é aditiva e não recalcula números existentes.

## Baseline de validação

Fixture mínima para as tarefas seguintes, sem dados de produção:

1. Uma unidade e uma marca tipo `cliente`, com baseline técnico `1900-01-01`,
   `fixo_confirmado=false` e `comissao_confirmada=false`.
2. Condição sintética de agosto: R$ 1.000, 5%, cobrança aditiva; GMV de R$ 10.000
   produz R$ 1.500.
3. Condição sintética de setembro: R$ 1.200, 8%, cobrança aditiva; GMV de R$ 10.000
   produz R$ 2.000.
4. Consulta agosto–setembro soma R$ 3.500. Para `fixo_ou_comissao`, o fixo
   parcelado soma R$ 2.200; nunca se escolhe um vencedor para o intervalo inteiro.
5. Uma live com boleto/snapshot aprovado é fechada; a prévia informa bloqueio,
   a confirmação retorna 409 e nenhuma condição é inserida.
6. Duas condições com o mesmo tenant, marca e marco são rejeitadas; uma marca
   de outro tenant não passa pela FK composta/RLS.

## Tarefas posteriores obrigatórias

T5 não habilita escrita. T9–T13 precisam adaptar os leitores listados acima
antes de ativar o editor de condições. Qualquer consumidor descoberto depois
deste inventário recebe tarefa atômica própria; não deve ser corrigido em um
megacommit. O histórico formal de `contratos` e cobranças emitidas não será
reescrito.
