# Auditoria de pendencias do PDF - LiveLab Franqueado

Data: 2026-05-19

## Escopo

Auditoria complementar das pendencias visiveis no PDF e nos prints recentes, sem apagar historico nem remover codigo automaticamente. O objetivo foi separar o que ja esta coberto por contrato ativo, o que ficou estabilizado nesta rodada e o que ainda exige limpeza/manual review.

## Contratos ja ativos

- `GET /v1/clientes/:id/operacional` existe em `src/routes/clientes.js` e usa `src/lib/operacional.js` para agregar cliente, marcas, vendas atribuidas, lives e videos.
- `GET /v1/marcas/:id/operacional` existe em `src/routes/marcas.js` com contrato equivalente para afiliadas/marcas.
- `GET/PATCH /v1/configuracoes/ranking-publico` existe em `src/routes/configuracoes.js`.
- `GET /v1/lives/:liveId/tiktok-status` existe em `src/routes/tiktok.js`.
- `GET/POST/PATCH/DELETE /v1/apresentadoras/:id/faixas-comissao` existe em `src/routes/apresentadoras.js`.
- `POST/PATCH /v1/agenda` ja bloqueia conflito de cabine/apresentadora e recorrencia via `AGENDA_CONFLICT`.

## Ajustes aplicados nesta rodada

- Frontend passou a consultar `GET /v1/lives/:id/tiktok-status` no detalhe da live atual da cabine.
- Toolkit de live em cabine agora mostra viewers, GMV, pedidos, likes, comentarios, status do conector TikTok, ultimo snapshot e erro do conector quando existir.
- Pre-validacao de agenda no frontend agora envia `cabine_id` e `apresentadora_id` para `/agenda/conflitos`, alinhada ao bloqueio real do backend.
- Resumo de comissoes passou a expor `gmv_lives` e `gmv_videos` nos totais para evitar divergencia entre GMV base e GMV de lives.

## Paginas frontend sem rota direta ativa

Estas telas nao devem ser apagadas automaticamente porque algumas ainda sao componentes embutidos ou rotas legadas redirecionadas.

| Arquivo | Estado |
| --- | --- |
| `AnalyticsPage.tsx` | Usada dentro de `ConteudoPage` como aba `analytics`. |
| `CabinesPage.tsx` | Usada dentro de `ConteudoPage` como aba `cabines`. |
| `BoletosPage.tsx` | `BoletosPanel` usada dentro de `FinanceiroPage`; rota `/boletos` redireciona para financeiro. |
| `ApresentadorasPage.tsx` | Sem rota ativa; `/apresentadoras` redireciona para `Configurações > Usuários`. Candidata a remocao apos confirmar que nao ha import dinamico externo. |
| `ComissoesPendentesPage.tsx` | Sem rota ativa; `/comissoes/pendentes` redireciona para financeiro. Candidata a remocao apos QA. |
| `LiveManualPage.tsx` | Sem rota ativa; `/lives/manual` redireciona para `Conteúdo > Lives realizadas`. Candidata a remocao apos QA. |
| `PlaceholderPage.tsx` | Sem rota ativa localizada. Candidata a remocao. |

## Rotas backend registradas sem consumidor frontend direto encontrado

Estas rotas podem ser integracoes, jobs, master/admin ou compatibilidade. Nao remover sem revisar logs e clientes externos.

- `appmax.js`: webhook externo Appmax e billing engine.
- `audit_log.js`: auditoria administrativa.
- `apresentadora_disponibilidade.js`: disponibilidade operacional/testes.
- `excelencia.js`: metricas antigas de excelencia.
- `manuais.js`: compatibilidade com base antiga; `knowledge.js` tambem usa `manuais`.
- `notificacoes.js`: log interno/testado.
- `pacotes.js`: usado por contratos, leads e portal cliente.
- `recomendacoes.js`: fluxo antigo de recomendacoes.
- `regional_managers.js`: master/regional, com testes.
- `relatorios.js`: CSV/PDF, com testes.

## Duplicatas de dados

Ja existe relatorio anterior em `docs/audit/franqueado-sessao-1.md` para duplicatas de clientes/marcas e vinculos operacionais. O criterio continua:

- auto-merge somente com mesmo `tenant_id` e match forte de CNPJ ou e-mail normalizado;
- migrar vinculos antes de arquivar perdedor;
- nunca apagar historico;
- casos ambiguos devem ir para revisao manual.

## Riscos restantes

- Antes de remover paginas legadas, rodar busca por imports dinamicos e smoke test de navegacao em `/conteudo`, `/financeiro`, `/configuracoes` e `/comercial`.
- Antes de desligar rotas backend sem consumidor frontend, verificar chamadas externas, jobs, automacoes e dashboards de master.
- Se producao ainda retornar `500` em `/clientes/:id/operacional`, a proxima investigacao deve usar o log Railway com o ID real do cliente e a query de `src/lib/operacional.js`; localmente o contrato existe e esta coberto por teste unitario de helper.
