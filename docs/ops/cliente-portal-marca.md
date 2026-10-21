# Portal do cliente: publicação e rollback

Implementação local do portal somente de leitura da marca contratante. Login, refresh, recuperação e troca de senha usam a autenticação existente. Nenhum acesso real é criado pelo código desta entrega.

## Escopo e contratos

- Uma conta `cliente_parceiro` resolve um único cliente e uma única marca `tipo='cliente'` no tenant do token. Inconsistências devolvem 403.
- Apenas lives encerradas, revisadas ou publicadas, não arquivadas, não absorvidas e sem união desfeita entram em resultados e histórico.
- As únicas leituras do cliente são `/v1/cliente/home`, `/v1/cliente/conteudo/lives`, `/v1/cliente/analytics/diario`, `/v1/cliente/perfil` e `/v1/cliente/meta`.
- A única escrita de dados pessoais no portal é a própria senha, via `PATCH /v1/auth/senha`. Logout continua disponível.
- Rotas antigas de financeiro, operação, relatórios, onboarding e recursos internos respondem 403 ao cliente. Papéis internos mantêm suas permissões.
- Respostas usam `private, no-store`; dados de apresentadoras e textos internos não fazem parte do DTO.
- O histórico usa `offset` e página fixa de 50. `total` e `resumo` cobrem o período completo. Ausência de medida retorna null; zero real permanece zero.
- Não há novas migrations ou dependências nesta entrega. Não executar SQL de backfill para transformar rascunhos antigos em revisados.

## Bases e preservação

Backend base: `b987be35afb4bacd8f8160970b7ec3ba8c7e5506`. Frontend base do GitHub: `ff3df3347d5db81c226f52d5b163b3c02de3e7e7`.

A versão pública do frontend consultada em 21/10/2026 identificou o build como `1791570506329` (09/10/2026, 15:28, São Paulo). Esse identificador não é um commit nem um ID de deployment. O workflow anterior bem-sucedido é `37973187138`, commit `0155a0f5`, com deployment `https://liveshop-saas-frontend-react-87zj73jit-leonardoames-projects.vercel.app` e inspeção `https://vercel.com/leonardoames-projects/liveshop-saas-frontend-react/7iQ1geBnGKxENnyUuqLVmrCktGRH`. O log confirma o alias `app.grupolivelab.com.br`. Não assumir que a base do GitHub corresponde ao build publicado.

O projeto Vercel antigo no scope `greed9797s-projects` não atende o alias atual. A produção do workflow está no scope `leonardoames-projects`; usar os secrets já configurados no GitHub Actions, sem substituir seus IDs pelos exemplos antigos da documentação. O token Vercel disponível no shell nesta sessão alcança o projeto antigo e não deve ser usado para publicar o app atual.

O trabalho local anterior está preservado em `/Users/lucas/livelab-analysis/local-sync-20261021-093618`, nas branches e stashes registrados nos arquivos `restore.json`. Caches do indexador gerados na análise foram guardados fora dos diffs de implementação.

## Gates locais

Backend, na raiz: `npm test`. A suíte inclui consultas reais PGlite com marcas e tenants sintéticos e testes de JWT, bloqueio de rotas e revogação de sessão.

Frontend, em `react-app/`: `npm run typecheck`, `npm run test`, `npm run build`. Executar também `npx playwright test --config=playwright.cliente-portal.config.ts`, com APIs interceptadas e dados sintéticos. Nunca usar o smoke de produção para esses testes.

Na máquina compartilhada, `npm test -- --maxWorkers=4` executa a suíte inteira do backend com concorrência limitada. A primeira execução sem esse limite teve timeout de inicialização em uma fixture PGlite já existente; a repetição passou sem alterar timeouts, omitir testes ou mudar as asserções.

O relatório independente em `.specs/features/cliente-portal-marca/validation.md` registra evidências, gates e sensores de regressão. A implementação só está validada quando esse relatório indicar PASS.

Na preparação autorizada de 21/10, os lockfiles receberam patches compatíveis: `follow-redirects` 1.16.1 nos dois repositórios e Vite 7.3.7 no frontend. Nenhuma dependência foi adicionada. A repetição de `npm audit --omit=dev --json` retornou zero vulnerabilidades de produção nos dois projetos. Referências dos patches: [follow-redirects](https://github.com/advisories/GHSA-q3jh-wrc6-jgq8), [Vite](https://github.com/advisories/GHSA-587h-7wmj-h5pm).

Os gates finais também são executados nos runners do GitHub antes de avançar as branches de produção. A máquina local apresentou carga 186 em 10 núcleos e timeouts de 5 segundos em arquivos diferentes, embora os arquivos isolados passassem. Não aumentar timeouts, omitir testes nem tratar uma execução cancelada ou com timeout como PASS.

Liberação de 21/10: backend `d24ceac980204cc19b0e59a6234dfc086549246e`, [CI 39620918729](https://github.com/Greed9797/Livelab-back/actions/runs/39620918729), com 2.183 testes aprovados, zero falhas e 67 skips preexistentes, além das fixtures SQL. Frontend `2cbf087c469b9cf541b623b179210963a711c78f`, [CI 39615198644](https://github.com/Greed9797/Livelab-Front/actions/runs/39615198644), com tipagem, 971 testes e build aprovados; os quatro cenários sintéticos de navegador também passaram. A revisão independente do escopo cadastral está em `.specs/features/agente-cadastros/validation.md`, com oito critérios atendidos e cinco regressões simuladas detectadas. O commit posterior de registro altera somente documentação; o código e os testes são idênticos aos do gate.

## Publicação autorizada em 21/10/2026

O usuário autorizou explicitamente implementar e publicar o portal e o escopo de atualização cadastral do agente. O responsável indicou uma marca piloto e um e-mail nesta sessão, mantidos fora do repositório. A associação exige conferir a ficha/marca existente e usar uma sessão administrativa válida; não criar outra marca nem alterar os resultados para fazer o teste passar. A entrega não executa a correção em massa de dados reais.

1. Registrar os commits aprovados dos dois repositórios, o commit backend atualmente servido por `/health`, a versão pública do frontend e os IDs dos deployments anteriores no Railway e na Vercel.
2. Conferir os diffs de `migrations/` e `apply_migrations.js` e as migrations pendentes do ambiente com o responsável. O Railway executa migrations antes de servir o container novo; nenhuma migration nova pertence a este recurso.
3. Obter autorização explícita para push e publicação. Push em `codex/blumenau-operational-fase1` publica o backend. Push em `feat/multi-apresentadora-agenda` ou `migration/react-vercel` dispara o workflow de produção do frontend.
4. Publicar o backend primeiro. Conferir `/health`, `/readyz` e, com uma conta de teste autorizada, os bloqueios de rotas e o DTO seguro. Durante a transição, o frontend antigo pode receber 403 nas rotas removidas; não reabrir essas rotas para contornar o erro.
5. Publicar o frontend pelo fluxo já configurado. Não usar `vercel --prebuilt`; conferir a URL da API utilizada no build e a versão pública.
6. Após autorização específica para o acesso real, usar o cadastro administrativo existente para criar ou verificar o login da marca piloto, papel `cliente_parceiro` e vínculo correto. Não criar outro cliente ou associar por e-mail como fallback. Conferir primeiro os resultados usando somente essa conta.
7. Entregar as credenciais por canal aprovado pelo responsável, sem registrá-las em commits, logs, relatórios ou neste chat. Orientar a troca da senha em Minha conta.
8. Monitorar erros 401/403/5xx e relatos de divergência do piloto antes de liberar mais contas. Não registrar payloads ou dados de apresentadoras na observabilidade.

## Rollback seguro

Se houver exposição entre marcas ou de dados internos, suspender imediatamente o acesso das contas afetadas pelo controle administrativo e invalidar suas sessões. Essa é uma ação de produção e exige autorização operacional explícita.

Reverter a interface para o deployment anterior pode reexibir telas antigas; manter o backend restrito para que chamadas antigas continuem bloqueadas. Antes de retornar a um backend anterior que não tenha essas restrições, suspender todos os acessos de cliente afetados. Conferir novamente o isolamento após qualquer retorno.

Não apagar históricos, vínculos, submissões ou lives para fazer rollback. Não rodar migrations reversas: esta entrega não cria schema.
