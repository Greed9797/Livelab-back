# Handoff MCP Livelab — Railway

Entrega: PR https://github.com/Greed9797/Livelab-back/pull/81, branch de produção `codex/blumenau-operational-fase1`. O serviço é o que atende `https://liveshop-saas-api-production.up.railway.app`. Não crie outro backend nem altere variáveis de banco, JWT ou do painel.

## 1. Código e banco

O merge do PR aciona o auto-deploy configurado no Railway. Confira no serviço **Deployments** que o commit publicado contém o PR 81 e que o pre-deploy terminou com sucesso. `railway.json` mantém Dockerfile, Node 22, `node apply_migrations.js` e healthcheck `/readyz`. A migration `185_mcp_oauth.sql` é aditiva e está na lista do runner; não aplique SQL manualmente. Com `MCP_ENABLED` ausente ou false, a API atual funciona e `/mcp` retorna 404.

## 2. Configuração privada pronta

Neste computador, o pacote está em `/Users/lucas/livelab-analysis/mcp-railway-handoff-20261014/railway-mcp.variables.json`, com permissão 0600. Ele contém chaves novas de cookie, armazenamento e assinatura. O arquivo não foi versionado. Preserve estas chaves entre deploys; não gere outro conjunto depois de conectar usuários.

Preencha os dois campos pendentes antes de ativar:

| Variável | Valor |
| --- | --- |
| MCP_PUBLIC_URL | https://liveshop-saas-api-production.up.railway.app |
| MCP_CHATGPT_CLIENT_ID | Client ID usado na configuração OAuth da conexão ChatGPT; deve coincidir exatamente |
| MCP_CHATGPT_REDIRECT_URI | URI de callback exata exibida na página de gestão da conexão MCP do ChatGPT |
| MCP_COOKIE_KEYS | Já gerado no arquivo: string contendo array JSON |
| MCP_STORAGE_KEY | Já gerado no arquivo: base64 de 32 bytes |
| MCP_JWKS | Já gerado no arquivo: string contendo JWKS privado JSON |
| MCP_ENABLED | true somente depois de completar os dois campos acima |

Este servidor usa **cliente previamente cadastrado**, PKCE S256 e `token_endpoint_auth_method=none`; não tem client secret, DCR ou CIMD habilitados. Selecione configuração de cliente OAuth existente/manual na integração. Caso a interface da conta não ofereça essa opção, a conexão depende de adaptar o registro de clientes; não configure um fluxo diferente silenciosamente. Não invente o callback nem use wildcard. Railway token não é credencial do MCP.

No Railway, serviço correto → **Variables** → **RAW Editor**: importe os sete campos do JSON, preservando todas as outras variáveis existentes. Os valores JSON de COOKIE_KEYS e JWKS são strings; deixe o editor fazer o parse do arquivo, sem remover as aspas internas manualmente. Revise as alterações pendentes e publique. A documentação do Railway informa que alterações de variáveis precisam ser revisadas e implantadas para aplicar.

Se a página ChatGPT exigir discovery antes de mostrar a configuração do cliente, obtenha o cadastro pela área de gestão da integração; não habilite produção com placeholders. Esta etapa ainda precisa da conta ChatGPT/workspace, não foi validada em uma conexão real.

## 3. Validar ativação

Após o deploy, execute o script local `verificar.mjs` do pacote, usando Node 22:

```sh
node /Users/lucas/livelab-analysis/mcp-railway-handoff-20261014/verificar.mjs
```

Ele confirma readiness, metadata de recurso, discovery OAuth e rejeição de chamada MCP sem token. Não acessa valores financeiros nem autentica uma pessoa. Esperado: `/readyz` 200; metadata/discovery 200; POST `/mcp` 401 com WWW-Authenticate. `/mcp` GET não é um teste de saúde: a integração é Streamable HTTP e consultas usam POST.

## 4. Conectar ao ChatGPT/dot

URL: `https://liveshop-saas-api-production.up.railway.app/mcp`. Autenticação OAuth; client ID igual ao Railway, sem segredo. Escopos `livelab:analytics:read livelab:finance:read`; acrescente `offline_access` se o formulário pedir explicitamente escopos para renovação. O consentimento no backend autoriza o acesso persistente. Login com conta Livelab que já tenha as permissões necessárias, sem senha no chat.

Valide: resumo do mês → apresentadores com horas e venda zero → resultado operacional → fechamento mensal de uma pessoa → memória desse fechamento. Compare os números com as telas na mesma régua. Confirme que um usuário sem acesso financeiro é impedido. Revogue a conexão e confira que os tokens anteriores não permitem consultas; reconecte ao final. Só então habilite a conexão nas ferramentas do dot.

## 5. Diagnóstico e rollback

- 404 em `/mcp`: código ainda não publicado ou MCP_ENABLED diferente de true.
- Erro de inicialização “Configuração MCP OAuth incompleta”: variável ausente, JSON inválido ou callback incorreto. Desabilite MCP_ENABLED e corrija a configuração.
- `invalid_client`/`invalid_redirect_uri`: client ID e callback precisam coincidir com o cadastro.
- 401 em consulta autenticada: token expirado/revogado, troca de senha, bloqueio ou mudança de tenant; reconecte.
- 403 financeiro: permissão atual da conta ou escopo consentido insuficiente.
- Pre-deploy falhou: veja logs do runner; não marque migration como aplicada nem retire a lista para contornar erro.

Rollback: `MCP_ENABLED=false`, revise e publique o restart/redeploy no Railway. Preserve as tabelas aditivas e as três chaves; não rode DROP. O MCP/OAuth fica desligado e as rotas existentes continuam disponíveis.

## Evidência e limites

Validação local anterior: 2.061 testes passaram, 74 testes opt-in/preexistentes pulados; parser PostgreSQL e PGlite validaram GMV, rateio, horas, zero, NULL, fuso, tenant, migration, contratos, custos, adicionais e prejuízo. Revisão de segurança sem apontamentos, auditoria runtime sem vulnerabilidades. O CI do GitHub deve ficar verde antes do merge. Isso não substitui o teste final na conexão real do ChatGPT.

O token Railway fornecido foi recusado. Nenhuma variável de produção foi configurada por esta entrega. O estado real do deploy e da ativação deve ser conferido no serviço; código integrado e MCP conectado são etapas distintas.

Fontes: https://docs.railway.com/variables e https://developers.openai.com/plugins/build/auth.
