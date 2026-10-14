# MCP Livelab: desempenho e financeiro

O backend fornece 17 ferramentas MCP de consulta. O transporte é Streamable HTTP
sem sessão, em `/mcp`. A identidade vem da conta Livelab via OAuth, nunca de um
tenant informado pelo modelo. O MCP está desligado por padrão.

## Ferramentas

| Nome | Entrada principal | Resultado |
| --- | --- | --- |
| buscar_entidades | tipo, nome, limite | Candidatos e indicação de ambiguidade |
| consultar_resumo | inicio, fim e filtros | GMV de lives/vídeos, pedidos, horas, ticket e produtividade |
| consultar_evolucao | período, granularidade dia/mes | Série e acumulado desde o início solicitado |
| consultar_apresentadores | período e filtros | GMV atribuído, presença/produtividade, incluindo venda zero |
| consultar_marcas | período e filtros | Desempenho e participação por marca |
| consultar_cabines | período e filtros, origem live | Desempenho de transmissões por cabine |
| consultar_metas | mes, tipo unidade/apresentadora, apresentadora_id opcional | Metas e realizado na régua correspondente |
| comparar_periodos | atual, anterior, financeiro opcional | Diferenças absolutas e percentuais |
| consultar_lives | período, filtros, pagina, limite, origem live | Transmissões paginadas que sustentam indicadores |
| detalhar_live | live_id | Transmissão e atribuição individual |
| consultar_funil_audiencia | período, marca/apresentadora opcionais | Funil e cobertura da fonte |
| consultar_resultado_operacional | inicio/fim em YYYY-MM | Entradas calculadas, despesas e resultado, inclusive negativo |
| consultar_receitas_marcas | inicio/fim em YYYY-MM | Componentes e critério contratual por marca |
| consultar_custos | meses, categoria opcional, pagina, limite | Custos previstos efetivos, valores pagos registrados e totais por categoria/competência |
| consultar_comissoes | período, marca/apresentadora/origem opcionais | Comissões calculadas, sem comprovação de pagamento |
| consultar_fechamento_apresentadores | mes, apresentadora_id opcional | Fixo, comissão, adicionais e total mensal |
| consultar_memoria_financeira | mes, tipo operacional/apresentadora | Lançamentos, bases e faixas disponíveis; individual exige ID |

Períodos diários usam `YYYY-MM-DD`, são inclusivos e limitados a 366 dias.
Períodos financeiros usam meses completos, até 12 meses. Listagens começam na
página 0, com limite máximo 100. Consultas com mais de 10.000 fatos ou respostas
acima de 2 MB são rejeitadas: reduza o período ou filtre, sem truncar totais.
Não há ferramenta de escrita, SQL livre, pagamento ou reprocessamento.

## Significado dos valores

- GMV é venda bruta; não representa receita da unidade nem dinheiro recebido.
- GMV de lives segue `ads_gmv → manual_gmv → fat_gerado`; vídeos seguem vendas
  atribuídas não reprovadas, como diário/ranking. Outras telas usam video_registros.
- Cada live conta uma vez na unidade. Horas individuais podem se sobrepor.
- Presença usa a régua própria de `metric-sql`, incluindo registros legados.
  Ausência de tempo medido é identificada como estimativa, nunca como falta.
- GMV/h individual usa horas de produtividade; GMV de vídeo não entra na razão.
- O dia é o início da live em America/Sao_Paulo, inclusive quando atravessa a madrugada.
- O padrão é live encerrada. Em andamento usa dados parciais registrados e pode
  usar o término previsto para horas; não é coleta instantânea do TikTok.
- GMV ausente deixa totais completos indisponíveis. `gmv_conhecido` é subtotal
  registrado; a resposta informa cobertura. Divisão sem denominador retorna null.
- Metas individuais preservam a fonte do endpoint vigente; meta zero pode ser
  ausência de cadastro. Meta diária segue dias úteis seg–sex, sem mudar feriados.
- Financeiro reutiliza as rotas atuais dentro do processo, mantendo guards,
  contratos fixo+comissão/maior dos dois, histórico de fixos, adicionais e custos.
- Resultado operacional usa `/v1/financeiro/operacional`, preservando prejuízo.
  A integração não transforma GMV em caixa. As rotas financeiras vigentes são preservadas.
- O fechamento não confirma que o valor foi pago. Remunerações da equipe sem
  cadastro dependem dos custos manuais, conforme as pendências da fonte.

Respostas contêm período, filtros, moeda, fuso, horário de consulta, origem e
avisos. Horário da consulta não é horário da última atualização do TikTok.

## OAuth e configuração

Requer Node 22+. O provedor `oidc-provider` está em `/oauth`, com login e
consentimento no backend, PKCE S256 obrigatório e cliente ChatGPT pré-cadastrado.
Tokens OAuth são opacos e restritos ao recurso `/mcp`. Artefatos persistidos são
criptografados; identificadores são armazenados por hash. Refresh tokens rotacionam.

| Variável | Conteúdo |
| --- | --- |
| MCP_ENABLED | true para habilitar; qualquer outro valor mantém desligado |
| MCP_PUBLIC_URL | Origem HTTPS pública da API, sem caminho ou query |
| MCP_CHATGPT_CLIENT_ID | ID do cliente configurado na conexão ChatGPT |
| MCP_CHATGPT_REDIRECT_URI | Callback HTTPS exato mostrado no ChatGPT, host chatgpt.com |
| MCP_COOKIE_KEYS | Array JSON de chaves de cookie, cada uma com pelo menos 32 caracteres |
| MCP_STORAGE_KEY | Chave AES de 32 bytes em base64 |
| MCP_JWKS | JWKS privado JSON com chave de assinatura, kid e d |

Gerar as três configurações secretas em arquivo privado, sem imprimir valores:

```sh
node scripts/generate_mcp_secrets.mjs /caminho/privado/livelab-mcp-secrets.json
```

O script não sobrescreve arquivos e usa permissão 0600. Transfira os valores ao
gerenciador de secrets do ambiente autorizado. Não versione esse arquivo e não
publique chaves privadas. Preserve chaves entre reinícios: trocar STORAGE_KEY
sem recriptografar os artefatos invalida a leitura das conexões existentes.

Escopos: `livelab:analytics:read` e `livelab:finance:read`. Cada chamada também
verifica papel, conta ativa, tenant e versão da sessão no banco. Metas permitem
apenas os papéis já autorizados pelas rotas; listagem/detalhe de lives exige a
permissão operacional existente. Conta sem permissão para os escopos solicitados
não autoriza a conexão. Configure escopos compatíveis com o papel da conta.

Troca de senha pelos dois caminhos do painel, reset, bloqueio e alteração de
tenant impedem o acesso antigo. A troca de senha também invalida sessões JWT
antigas; será necessário entrar novamente no painel. Revogar o refresh token
revoga a concessão e seus tokens. Login exige origem correta e proteção CSRF.

## Publicação e conexão ao dot

1. Revisar e aprovar alterações de autenticação, migration e deploy.
2. Aplicar a migration aditiva `185_mcp_oauth.sql`, registrada em MIGRATIONS_LIST.
   O runner normal do Railway a aplica antes do novo container; não rode outro
   comando de migration em produção sem aprovação.
3. Configurar o cliente e callback exato exibidos na conexão MCP do ChatGPT,
   inserir secrets no Railway e habilitar MCP_ENABLED.
4. Cadastrar a URL pública `/mcp` na conexão remota usando OAuth e os escopos
   desejados. Entrar com a conta Livelab e autorizar as consultas.
5. Disponibilizar a conexão ao dot na configuração de ferramentas permitida
   pela conta/workspace. Validar resumo, fechamento individual e memória.

Discovery: `/.well-known/oauth-protected-resource/mcp` e
`/oauth/.well-known/openid-configuration`. O alias RFC 8414 é
`/.well-known/oauth-authorization-server/oauth`. A origem ChatGPT só é liberada
nas rotas MCP/OAuth; a allowlist das outras rotas permanece restrita.

Rollback: definir MCP_ENABLED=false e reiniciar. A API atual continua operando;
as tabelas aditivas podem permanecer para recuperação. Não apagar dados OAuth
nem trocar secrets como parte automática do rollback.

## Validação

```sh
npm test
```

Parser e Postgres em memória, com dependências instaladas num diretório
descartável (fora do repositório):

```sh
npm install --prefix /tmp/livelab-mcp-validation @electric-sql/pglite libpg-query
PGLITE_MODULE=/tmp/livelab-mcp-validation/node_modules/@electric-sql/pglite/dist/index.js \
PG_QUERY_MODULE=/tmp/livelab-mcp-validation/node_modules/libpg-query/wasm/index.cjs \
node test/mcp_indicadores.pglite.mjs
```

Os testes cobrem protocolo real do SDK, OAuth/PKCE/renovação/revogação,
troca de senha, CORS da aplicação, permissões e casos de GMV/horas/financeiro.
O script SQL executa contratos financeiros, custos, adicionais e prejuízo com
dados controlados, além de rateio, NULL, fuso e isolamento de tenant.
Testar no ChatGPT real exige publicação e configuração autorizadas; o teste
local não afirma que a conexão já está instalada no dot.
