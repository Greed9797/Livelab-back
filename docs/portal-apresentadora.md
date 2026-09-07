# Portal da apresentadora

Implementação local autorizada em 2026-09-07. Usa o login existente e os papéis
`apresentadora` e `apresentador`; não cria outro sistema de autenticação.

## Comportamento

- **Meu desempenho**: lives oficiais próprias, horas e GMV atribuídos, GMV/h,
  fixo mensal cadastrado e ranking da unidade. Por decisão explícita, o ranking
  mostra `fixo`, `comissao_variavel` e `total_recebido` das colegas da mesma
  unidade. `total_recebido` é uma estimativa do período (`fixo + comissão
  variável`) e não inclui adicionais/extras nem representa fechamento a pagar.
- **Minhas lives**: histórico próprio e envio de lives já realizadas. Campos
  declarados não alimentam nenhuma tabela oficial antes da aprovação.
- Gestão confere dados oficiais e cria uma live histórica ou vincula uma live
  existente. Vínculo não altera GMV, participação nem comissão da live existente.
- Fluxo: `pendente → devolvida → pendente → aprovada`. Somente envios devolvidos
  podem ser corrigidos ou cancelados pela autora; cancelamento é lógico.
- Toda transição grava um snapshot versionado na mesma transação. Aprovação
  inclui agenda, rateio, cálculo de comissão e atualização mensal; qualquer falha
  reverte a operação. O sucesso HTTP só é enviado após o commit.

## Limites de acesso

O servidor resolve `JWT.sub + tenant_id → apresentadoras.user_id`. Perfil
inexistente, ambíguo, arquivado ou usuário inativo/com papel alterado não ganha
acesso. Gestão também tem papel ativo conferido no banco a cada requisição.
As rotas operacionais genéricas de agenda, cabines e lives deixam de aceitar
papéis de apresentadora; apenas ocultar os menus não protegeria os dados.

O ranking é uma exceção deliberada ao escopo individual: nomes, desempenho e
os três campos de remuneração permitidos (`fixo`, `comissao_variavel`,
`total_recebido`) de colegas da mesma unidade podem aparecer. E-mail, telefone,
CPF/CNPJ, endereço, contatos e extras individuais não são retornados. O ranking
público mantém seu comportamento/API existente e não recebe esses campos.

As novas tabelas têm RLS de unidade com USING/WITH CHECK. A migration **145**
cria o role NOLOGIN/NOBYPASSRLS `livelab_portal_runtime`, com grants restritos
ao fluxo do portal. Cada request usa uma transação própria com `SET LOCAL ROLE`
e `set_config(..., true)`; não existe fallback para o pool de sistema ou para
o role BYPASSRLS. Autorização pessoal continua aplicada na API em todas as
consultas e mutações. Isso não troca `DATABASE_URL`, grants de integrações nem
APIs públicas.

## API

Prefixo pessoal `/v1/portal/apresentadora`:

| Método e rota | Uso |
| --- | --- |
| GET `/me?mes=YYYY-MM` | Performance própria, fixo e ranking seguro |
| GET `/lives?mes=YYYY-MM` | Histórico oficial e envios próprios |
| GET `/opcoes` | Marcas vinculadas e identificação mínima de cabines |
| POST `/submissoes` | Novo envio; `request_id` UUID permite replay seguro |
| PATCH `/submissoes/:id` | Salvar correção de envio devolvido |
| POST `/submissoes/:id/reenviar` | Reenviar correção para revisão |
| DELETE `/submissoes/:id` | Cancelar logicamente envio devolvido |

Gestão: GET `/v1/lives/submissoes-apresentadoras`, POST
`/v1/lives/submissoes-apresentadoras/:id/devolver` com `motivo`, e POST
`/v1/lives/submissoes-apresentadoras/:id/aprovar` com `live_id` para vincular ou
`marca_id`, `cabine_id`, `iniciado_em`, `encerrado_em`, `gmv_oficial` e
`pedidos_oficiais` para criar. Unidade/autora nunca vêm do corpo da requisição.
Respostas do portal e da revisão usam `Cache-Control: private, no-store`.

## Ativação e rollback

Migrations **144** e **145** são aditivas e estão registradas em
`apply_migrations.js`.
`PORTAL_APRESENTADORA_TENANT_ALLOWLIST` contém UUIDs de unidades separados por
vírgula; vazio mantém o piloto fechado. A publicação e a configuração desse
valor exigem autorização explícita. A interface deve tratar indisponibilidade
do piloto sem carregar telas operacionais no lugar.

Antes de ativar: aplicar e validar a migration no ambiente autorizado, conferir
role/grants/RLS, revisar vínculos de usuários e testar uma conta de apresentadora
e uma de gestão na unidade piloto. Não corrigir vínculos ambíguos automaticamente.

Para suspender o piloto, remover sua unidade da allowlist. Preservar tabelas,
submissões, histórico e lives aprovadas. Rollback visual não deve reabrir as
permissões genéricas que foram fechadas. Não desfazer pagamentos ou aprovações
automaticamente e não executar downgrade destrutivo de schema.

## Validação reproduzível

`npm test` executa a suíte de regressão e os testes de fronteira do portal.
Os scripts abaixo executam SQL real em um banco PGlite descartável, com fixtures
sintéticas. `PGLITE_MODULE` pode apontar para uma instalação temporária da
dependência; nenhuma conexão de produção é utilizada:

```sh
PGLITE_MODULE=/caminho/temporario/pglite/dist/index.js node test/portal_apresentadora_performance.pglite.mjs
PGLITE_MODULE=/caminho/temporario/pglite/dist/index.js node test/portal_apresentadora_flow.pglite.mjs
```

O segundo script executa as migrations 144/145 e exercita os handlers HTTP reais
e o motor de comissões, com falhas deliberadas de auditoria/commit, role
NOBYPASSRLS, `current_user`/GUC transacionais, reset do client reutilizado,
tentativa cross-tenant bloqueada, revisão completa, isolamento de autoria,
cancelamento e dois envios em split ligados à mesma live. Ele usa um schema
sintético mínimo; a validação final de catálogo/grants no PostgreSQL autorizado
continua necessária antes de ativar o piloto.
A autenticação criptográfica é substituída por identidade sintética no harness;
os testes gerais de autenticação continuam separados. A conversão SQL DATE
replica `src/lib/pg-date-string.js`.

No frontend: `npm run typecheck`, `npm test`, `npm run build` e os testes
`tests/e2e/presenter-portal.e2e.ts` em desktop/mobile. Testes E2E usam API simulada
e se complementam com os testes HTTP/SQL acima.
