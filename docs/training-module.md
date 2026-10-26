# Treinamentos

O catálogo de treinamentos pertence à rede. O progresso e o relatório pertencem à unidade autenticada.

## Acesso

- Alunos: **Base**, em `/conhecimento`, com as trilhas e aulas existentes.
- Gestão: `/conhecimento/treinamentos/gerenciar`, somente `franqueador_master`.
- Relatório: `/conhecimento/treinamentos/relatorio`, para `franqueador_master`, `franqueado` e `gerente`, sempre na unidade da sessão.
- Os demais papéis mantêm o acesso de leitura definido em `READ_TRAINING`. Não há novo cadastro, login, plano ou mecanismo de ativação.

## Cadastro

Trilhas e aulas têm título, capa e posição. Novas trilhas usam um módulo interno de aulas; a interface não exige administrar módulos. A ordenação da trilha também determina a próxima aula.

As capas usam o upload autenticado existente e o bucket `tenant-assets`. Mantêm-se os requisitos existentes de `SUPABASE_URL` e `SUPABASE_SERVICE_KEY`, exclusivamente no servidor. Não há upload ou processamento próprio de vídeos.

YouTube aceita identificador de 11 caracteres ou URL oficial. Panda aceita URL oficial do player ou UUID externo acompanhado do identificador da biblioteca (`pullzone_name`). Não usar o ID interno de vídeo da API Panda. HTML de embed e scripts não são aceitos.

Alterações de título, capa e ordem preservam o progresso. Substituir a fonte do vídeo cria uma versão de medição; o histórico anterior permanece armazenado. Excluir uma trilha remove aulas e registros dependentes após confirmação. Nenhuma exclusão chama APIs de exclusão de vídeos nos provedores.

## Progresso

Abrir uma aula não registra reprodução. O estado começa em **Não iniciou**, passa a **Em andamento** quando há reprodução observada e chega a **Concluiu** quando a união dos trechos assistidos cobre pelo menos 90% da duração.

A última posição não é o percentual assistido. Repetições e sobreposições não somam duas vezes, e saltos não preenchem os intervalos pulados. O percentual da trilha é a proporção de aulas concluídas.

O player salva periodicamente durante a reprodução e tenta salvar também ao pausar, terminar, trocar de aula e sair da página. O salvamento ao sair é uma tentativa adicional; não é a única persistência. O servidor mescla intervalos em transação, e a revisão da posição impede que reenvios antigos sobrescrevam uma posição mais recente.

Conclusões anteriores são preservadas com percentual **não medido**. Não são convertidas artificialmente em 90% ou 100%. Materiais sem vídeo conservam a conclusão manual. Novas conclusões de vídeo são calculadas pelo servidor.

As APIs dos players informam reprodução, não comprovação de atenção. O coletor deriva intervalos pela posição, relógio e velocidade, descartando transições ambíguas. Posições repetidas do SDK Panda não geram crédito nem reiniciam o relógio de uma reprodução contínua. A precisão depende dos tempos informados pelos SDKs; não existe mecanismo adicional de vigilância ou antifraude.

## PaceLab

Foi examinado o código do commit `d0b1bb00c6fbc2c2d08053b5d3d4f6536acd2127` de [AjmalX0/Pacelab.lms](https://github.com/AjmalX0/Pacelab.lms/tree/d0b1bb00c6fbc2c2d08053b5d3d4f6536acd2127).

Não foi copiado código. O README declara MIT, mas a árvore examinada não inclui arquivo de licença ou concessão completa. A stack Next.js/NestJS/Prisma também difere do LiveLab. O player usa posição/duração para conclusão, o serviço de progresso recebe um campo diferente do enviado pela tela e o relatório administrativo contém métricas fixas. Esses comportamentos não atendem aos critérios deste módulo.

Evidências do código fixadas no commit examinado:

- [Player, linhas 251–252](https://github.com/AjmalX0/Pacelab.lms/blob/d0b1bb00c6fbc2c2d08053b5d3d4f6536acd2127/components/video-player.tsx#L251): compara posição/duração com 95%, sem união de trechos reproduzidos.
- [Tela da aula, linha 130](https://github.com/AjmalX0/Pacelab.lms/blob/d0b1bb00c6fbc2c2d08053b5d3d4f6536acd2127/app/course/%5Bid%5D/page.tsx#L130) envia `completed`; [serviço, linhas 87–103](https://github.com/AjmalX0/Pacelab.lms/blob/d0b1bb00c6fbc2c2d08053b5d3d4f6536acd2127/apps/api/src/lessons/lessons.service.ts#L87) lê `progress` e converte valor ausente em zero.
- [Serviço administrativo, linhas 14–17](https://github.com/AjmalX0/Pacelab.lms/blob/d0b1bb00c6fbc2c2d08053b5d3d4f6536acd2127/apps/api/src/admin/admin.service.ts#L14) usa valores fixos para conclusão e atividade.
- A [árvore recursiva completa desse commit](https://api.github.com/repos/AjmalX0/Pacelab.lms/git/trees/d0b1bb00c6fbc2c2d08053b5d3d4f6536acd2127?recursive=1), consultada sem truncamento, não lista `LICENSE`, `LICENCE` ou `NOTICE`.

Foram reutilizados os componentes, autenticação, catálogo, serviços e armazenamento do próprio LiveLab. As integrações seguem documentação oficial:

- [YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference).
- [Panda Player API](https://docs.pandavideo.com/reference/player-api).
- [Eventos do Panda](https://docs.pandavideo.com/reference/receive-events).

## Critérios de aceite

| ID | Comportamento exigido |
| --- | --- |
| TR01 | Somente master administra o catálogo global; alunos continuam autenticados no sistema existente. |
| TR02 | Criar, editar, excluir, ordenar e mostrar trilhas/aulas/capas com os componentes atuais. |
| TR03 | Validar provedores, URLs, IDs e biblioteca Panda; rejeitar HTML e hosts indevidos. |
| TR04 | Abrir ou preparar o player não inicia; reprodução observada inicia. |
| TR05 | Persistir intervalos únicos, sem crédito por saltos, repetição, pausa ou buffering. |
| TR06 | Concluir em 90% reais, antes do arredondamento, sem conclusão manual de novos vídeos. |
| TR07 | Salvar posição separadamente, retomar, suportar reenvios e mesclar abas concorrentes. |
| TR08 | Preservar conclusões anteriores sem fabricar percentual assistido. |
| TR09 | Relatório inclui usuários ativos elegíveis que nunca iniciaram e permite filtrar usuário/trilha. |
| TR10 | Cada usuário altera apenas seu progresso; relatórios e gravações respeitam o tenant autorizado. |
| TR11 | Carregar SDKs somente em aulas e liberar listeners, timers e players ao sair. |
| TR12 | Verificar desktop/celular e distinguir evidência real dos provedores de simulação. |

## Implantação e validação

A implementação e os testes locais não autorizam publicação ou alterações no banco de produção. A migração deve ser aplicada pelo executor existente somente após revisão e autorização do ambiente de destino. Não executar o comando de inicialização apontado a um banco de produção para testar o módulo.

Antes de publicar, executar testes aplicáveis do backend, migração em banco descartável, testes de isolamento e os gates do frontend (`typecheck`, testes e build). A revisão deve conferir autorização no servidor e união concorrente dos intervalos, além das telas.

A tabela de medições é adicional; a tabela de progresso legado permanece disponível. Em rollback da aplicação, preservar a migração e os dados de medição para posterior retomada, sem executar remoções destrutivas. A aplicação antiga não conhece as novas aulas de vídeo direto; o rollback não deve ser apresentado como suporte dessas aulas na versão anterior.

Aplicar `migrations/186_training_video.sql` pelo executor existente (`apply_migrations.js`). A migração adiciona campos ao catálogo e cria `training_video_progress`, com RLS obrigatório por unidade; não migra conclusões antigas para percentuais fictícios. Nenhuma migração foi aplicada a ambientes compartilhados durante esta implementação. Não há dependência nova nem chave de API de vídeo necessária para os players. Permanecem necessárias as configurações de armazenamento já existentes, e vídeos Panda precisam da biblioteca/pullzone correta e de permissão para reprodução no domínio de destino.

### Evidências locais

- Backend: 42 testes aplicáveis, executados em grupos: rotas/serviço/normalização (27), fluxo integrado com banco PGlite descartável (10) e SQL legado (5). A migração foi executada nesse banco de teste.
- Frontend: 35 testes em 10 arquivos do módulo na execução integrada; em seguida, foram acrescentados casos de relógio quantizado do SDK Panda e de compatibilidade com vídeos avulsos (37 casos aplicáveis no total). Os 13 testes de player/coletor e os três testes da tela de aula passaram após os respectivos ajustes. `npm run typecheck`, `npm run build` e uma segunda geração do bundle Vite passaram; a proteção final de previews avulsos foi conferida pelo teste da tela e pela checagem de tipos.
- Fluxos integrados cobrem cadastro/capas/ordenação/movimentação, relatório com usuários sem início, permissões, RLS de leitura e escrita, reenvio, abas intercaladas, saltos, repetições, duração fracionária, limite exato de 90%, versão do vídeo e progresso legado.
- Navegador Playwright, com usuários sintéticos e API/banco locais descartáveis: cadastro de trilha pela interface, relatório em desktop/celular, carregamento dos dois players e player Panda sem overflow em 390 px. No YouTube público oficial, foram observados reprodução, persistência e retomada na posição salva; o avanço nativo de 10 segundos não foi somado como trecho assistido. No vídeo público Panda de 6,083 segundos, uma aula nova abriu sem início e foi concluída pelo servidor com 91,40226862% assistido. Capturas ficam em `output/playwright/`.
- `node --check` dos arquivos JavaScript alterados e `git diff --check` passaram. O grafo Graft do backend foi atualizado.

### Limites da validação

- A suíte geral do frontend foi executada com interrupção na primeira falha: `ReceberPagarPanel.test.tsx:158`, que espera “Histórico parcial”. A mesma falha foi reproduzida em uma extração limpa do HEAD anterior à implementação. Por isso, a suíte geral não está integralmente verde; o conjunto de treinamentos passou.
- Os testes reais usaram vídeos públicos de demonstração. Ainda é necessário verificar um vídeo da conta Panda e suas restrições de domínio no ambiente de destino. O exemplo público apresentou erros de mídia/HLS em tentativas iniciais; o reteste final reproduziu até o fim e registrou a conclusão. A retomada Panda foi coberta no teste do SDK; a retomada com reprodução real foi conferida no YouTube.
- O upload real ao bucket Supabase não foi executado com credenciais de ambiente; reuso do upload, persistência de URLs de capas e payloads da interface foram verificados localmente.
- PGlite valida SQL, migração e RLS; o harness serializa conexões. Foram testadas abas intercaladas e reenvios, mas não transações simultâneas em um servidor PostgreSQL real. O código usa bloqueio de linha e transação para mesclar intervalos.
- O SDK Panda não documenta evento específico de buffering. Posições sem avanço não geram crédito, e lacunas ambíguas são descartadas; a resolução da medição permanece limitada pela atualização de posição do provedor.

Comandos reproduzíveis: backend, `npx vitest run test/training.test.js test/training_service.test.js test/training_video_helpers.test.js --maxWorkers=1 --testTimeout=30000`; integração, `npx vitest run test/training_video_flow.pglite.test.js test/training_sql.pglite.test.js --maxWorkers=1 --testTimeout=120000`; frontend, `npm run typecheck`, testes focados de treinamento com `--maxWorkers=1 --testTimeout=30000` e `npm run build`. Os limites maiores acomodam a inicialização de PGlite e o ambiente local lento; não alteram a configuração padrão de testes do projeto.
