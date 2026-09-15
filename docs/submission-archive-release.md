# Atualização de vínculo e devolução com arquivamento

## Escopo aprovado

- Vínculo consulta candidatas ao abrir, permite atualização manual e não depende da fila oculta.
- Invalidação operacional também invalida candidatas. Lista da gestão e portal atualizam ao recuperar foco e a cada 30 segundos enquanto visíveis, sem polling em segundo plano.
- Gestão pode devolver normalmente ou solicitar arquivamento com motivo e versão esperada.
- Solicitação sai da lista atual da gestão; continua visível à autora, que confirma ou contesta com motivo.
- Confirmação fica recolhida em “Mostrar arquivados”. Contestação devolve o mesmo envio à revisão e mostra sua justificativa.

## Dados, segurança e compatibilidade

Migration 149 adiciona `arquivamento_status` e `motivo_contestacao`, sem remover dados, alterar status existentes ou executar backfill. A constraint exige `solicitado/devolvida` ou `confirmado/cancelada`. Execução repetida foi testada em banco descartável.

As transições usam transação, RLS, identificação da própria apresentadora, versão esperada e histórico com snapshot. Operações comuns de editar/reenviar/cancelar e aprovação direta não podem ultrapassar uma solicitação de arquivamento. Motivos são texto, limitados a 1.000 caracteres e renderizados sem HTML.

Histórico reutiliza ações existentes: `devolvida` com estado solicitado, `reenviada` com motivo da contestação e `cancelada` com confirmação. A devolução agora incrementa a versão. Clientes antigos ainda podem devolver normalmente sem versão; arquivamento exige versão.

Não cria ou exclui lives oficiais, vendas, agenda nem pagamentos. Permanecem as regras atuais: pendentes entram nos indicadores/relatórios; devolvidos e cancelados não são declarações pendentes; comissão apenas após validação. Contestação volta a ser pendente, sem gerar comissão. Vídeos, fixos, fórmulas de comissão e filtros de elegibilidade do vínculo não foram modificados.

Responder a arquivamento já solicitado pode ocorrer após a virada do mês: não é novo cadastro e não aceita mudanças em datas ou métricas. Cadastro, edição e reenvio comum continuam limitados ao mês atual. O histórico do portal continua filtrado pelo mês selecionado.

## Publicação — autorizada pelo usuário em 15/09/2026

1. Revisar os diffs finais e o estado das branches remotas; obter aprovação explícita para merge, migração e deploy.
2. Publicar backend primeiro: seu boot executa a migration 149 antes de subir. Verificar saúde, readiness e versão.
3. Publicar frontend com build remoto (nunca `--prebuilt`). Backend antigo rejeita os novos parâmetros; não inverter a ordem.
4. Smoke autenticado: vínculo após retorno vazio, atualização de lista, devolução normal e fluxo de arquivo usando registros de teste autorizados.

## Reversão

Não remover colunas nem apagar histórico. Se a nova funcionalidade ainda não foi usada, o código anterior pode ser restaurado mantendo as colunas aditivas. Depois de existirem solicitações, não reverter cegamente o backend: manter as proteções e o endpoint de resposta, suspender novas solicitações e corrigir adiante. O backend antigo não entende o fluxo; a constraint bloquearia algumas transições, e outras ações poderiam editar um envio aguardando resposta. Toda ação em produção exige autorização.

## Verificação local

- Teste de regressão do cache falhou antes da correção e passou depois.
- Integração HTTP + PGlite cobre SQL real, migração repetida, fila/lista/total ocultando solicitações, visibilidade da autora, motivos e snapshots, versão obsoleta, papéis, tenant/autoria e rollback de falha no histórico.
- Navegador usa APIs simuladas, sem dados ou escritas de produção; cenários desktop e celular cobrem atualização, vínculo e ambas as respostas ao arquivamento.
- Suítes completas, typecheck/build e revisão final devem ser confirmados no handoff. Não houve benchmark do banco de produção: correção de cache não é evidência de latência SQL.

Resultados locais em 15/09/2026: backend 1.020 testes passaram e 7 foram ignorados; frontend 512 passaram; typecheck, lint de hooks, build e verificações de sintaxe passaram. Integrações SQL do fluxo e de desempenho passaram. Portal: 42 cenários desktop/celular passaram. O teste adicional de detalhes/rateio tinha seletores antigos; foi atualizado para a seção recolhida e os nomes atuais, sem mudar o comportamento do produto.

Os dois cenários adicionais de detalhes/rateio passaram após a atualização dos seletores: total de 44 cenários de navegador aprovados nas execuções finais de cada arquivo. Revisão do diff e `git diff --check` concluídas sem erros.

O usuário autorizou explicitamente a consulta npm e, sem bloqueios, merge, migração e deploy. A auditoria `npm audit --omit=dev --audit-level=high` foi repetida após essa autorização: zero vulnerabilidades no backend e no frontend. Nenhuma dependência foi alterada. Os resultados da publicação serão registrados separadamente, com os commits e verificações dos serviços em produção.
