# Estado do backend LiveLab

Última verificação: 26/10/2026. Este arquivo registra o estado observado nessa data; confira a produção e a branch remota antes de preparar outro release.

## Produção verificada

- API: https://liveshop-saas-api-production.up.railway.app.
- Branch conectada à Railway: `codex/blumenau-operational-fase1`.
- Commit: `894e903b57610b8a38431b3a1e220ecbe4499089`, sobre a publicação do portal `9d0e02c`.
- Railway: projeto `kind-rebirth`, serviço `liveshop-saas-api`, ambiente `production`.
- Deploy `4bd1f6ef-0b73-4c71-b307-17a51331da35`: sucesso.
- `/health` e `/readyz`: HTTP 200; armazenamento configurado e saudável.
- Migrações registradas até `186_training_video.sql`, sem pendências na inspeção do banco efetivo do serviço.

## Entrega mais recente

Treinamentos em vídeo e correção da conversão do CRM estão publicados. O CRM fica em `/clientes/crm` no frontend e usa a API existente `/v1/leads`, com autenticação e escopo da unidade. A conversão verifica `convertido_cliente_id`, sem depender apenas da etapa do Kanban.

Treinamentos usam o catálogo existente, players YouTube/Panda, capas no armazenamento existente, união dos trechos assistidos e conclusão a 90%. O progresso mantém posição, percentual e data de conclusão separados. Gestão e relatórios seguem os papéis existentes.

## Evidências

- [CI completo do release](https://github.com/Greed9797/Livelab-back/actions/runs/40413286251): sucesso; 2.200 testes passaram e 67 foram ignorados conforme a suíte existente, além de coverage e fixtures SQL isoladas.
- Testes focados do release: 50 passaram em 6 arquivos.
- Auditoria de dependências de produção: nenhuma vulnerabilidade encontrada nessa execução.
- [Registro de produção e operação](docs/production-release-2026-10-26.md).
- [Guia de treinamentos](docs/training-module.md).

## Limites de validação

Não foi executado novo smoke visual em produção com sessão de franqueado/master, nem reprodução de vídeo da própria conta Panda no domínio de produção. Os exemplos públicos dos players foram verificados durante a implementação local. A ativação do MCP/OAuth não foi alterada nem validada por este release.

O checkout principal pode conter trabalho local anterior ao SHA publicado. Preserve essas alterações e use a branch remota e o SHA efetivo como referência de release. O grafo Graft descreve o código do checkout em que foi gerado.

O [status anterior](docs/archive/status-backend-before-2026-10-26.md) foi arquivado; suas métricas, tarefas manuais e avaliações globais não foram revalidadas nesta entrega.
