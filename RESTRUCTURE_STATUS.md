# LiveLab — Status da Reestruturação
**Branch:** `stabilization/core-restructure`  
**Última atualização:** 2026-05-18

---

## Resumo executivo

A branch `stabilization/core-restructure` contém **21 commits no backend** e **9 no frontend**, cobrindo os 17 PRs do plano original. O sistema está pronto para deploy em staging e, após validação, produção.

---

## O que foi implementado

### Arquitetura / Banco

| Item | Arquivo | Status |
|---|---|---|
| `lives.js` extraído de `cabines.js` | `src/routes/lives.js` (724 linhas) | ✅ |
| Status `ativa` removido das cabines | `migrations/081` | ✅ |
| `lives.cliente_id` nullable | `migrations/081` | ✅ |
| `lives.tipo` (cliente/afiliado/teste) | `migrations/081` | ✅ |
| `lives.status_publicacao` (rascunho/revisado/publicado) | `migrations/081` | ✅ |
| `lives.origem_dados` (manual/api) | `migrations/081` | ✅ |
| Histórico de GMV | `migrations/082` — tabela `live_metric_revisions` | ✅ |
| Aprovação de comissões | `migrations/083` — coluna `status_aprovacao` em `vendas_atribuidas` | ✅ |
| Índices de performance | `migrations/084` — 9 índices compostos | ✅ |

### Backend

| PR | O que foi feito | Arquivo principal |
|---|---|---|
| PR 0 | Docs ops: environments, runbook, backup, open-questions | `docs/ops/` |
| PR 1 | Auditoria técnica: rotas, roles, tenant risks, coupling | `docs/audit/` |
| PR 3 | Tenant hardening: fix query sem tenant_id em contratos.js | `src/routes/contratos.js` |
| PR 4a | `contrato_id` opcional na reserva de cabines | `src/routes/cabines.js` |
| PR 5 | Agenda integrada ao iniciar/encerrar live; recorrência; alertas de conflito | `src/routes/lives.js`, `src/routes/agenda.js` |
| PR 6a | Extração de `lives.js` — refactor puro | `src/routes/lives.js` |
| PR 6b | `tipo`, `status_publicacao`, `origem_dados` no fluxo de live | `src/routes/lives.js` |
| PR 9 | Ranking público hardened (master excluído, fallback, rate-limit verificado) | `src/routes/franqueado.js` |
| PR 10 | `PATCH /v1/lives/:id/publicar`; `GET /v1/lives/:id/historico-gmv` | `src/routes/lives.js` |
| PR 11 | Motor de comissões: `MAX(fixo, variável)`, recalcula ao mudar GMV, fluxo de aprovação | `src/services/commission-engine.js`, `src/routes/comissoes.js` |
| PR 12 | Bloqueia live de cliente inadimplente (`status='inadimplente'`) | `src/routes/lives.js` |
| PR 13 | `GET /v1/financeiro/franqueadora` (só master); `visao` no resumo | `src/routes/financeiro.js` |
| PR 14 | Audit logs em contratos, clientes, usuários (ações antes não auditadas) | múltiplos routes |
| PR 15 | `GET /v1/clientes/:id/exportar-dados`; `docs/ops/lgpd-policy.md`; CORS confirmado | `src/routes/clientes.js` |
| PR 16 | `BizError` constants; `docs/ops/error-codes.md`; Sentry com `init()` + sanitização | `src/lib/errors.js`, `src/app.js` |
| PR 17 | E2E: `lives-restructure.spec.js`, `roles-permissions.spec.js` | `e2e/tests/` |
| CI/CD | GitHub Actions: backend (postgres + migrations) e frontend (tsc + vitest + build) | `.github/workflows/ci.yml` |

### Frontend

| PR | O que foi feito | Arquivo principal |
|---|---|---|
| PR 1 | Auditoria: `frontend-pages.md`, `api-calls.md` | `react-app/docs/audit/` |
| PR 2 | Roles simplificadas: `masterRoles` só com `franqueador_master`; `normalizeRole()`; labels `(legado)` | `src/utils/access.ts` |
| PR 7 | `useSelectedLive` hook; tipo `LiveAtual`; `getLivePorId`, `publishLive` | `src/hooks/useSelectedLive.ts` |
| PR 9 | Ranking público verificado — sem mudanças necessárias | `src/pages/PublicRankingPage.tsx` |
| PR 15 | Comentário de segurança no localStorage JWT | `src/services/auth-storage.ts` |
| PR 17 | E2E: `live-toolkit.e2e.ts` | `react-app/tests/e2e/` |
| Agenda | `criarEventoAgenda`, `atualizarEventoAgenda`, `getAgendaConflitos` | `src/services/domain.ts` |
| Router | `/agendamentos` → `/conteudo`; `apresentador` acessa `/conteudo` | `src/routes/AppRouter.tsx` |

---

## O que já existia e não precisou ser feito

| Item | Evidência |
|---|---|
| PR 8 — Usuários cliente | Fluxo de convite, `invite_token_hash`, `token_version`, force-logout já implementados em `usuarios.js` |
| PR 3 — RLS | Migrations 053/054/060 já tinham WITH CHECK em todas as tabelas |
| PR 14 — Audit log base | Plugin + migration 061 já operacionais; rotas de cabines/usuários já chamavam `app.audit.log` |
| Ranking público frontend | `PublicRankingPage.tsx` + rota pública já funcionais |

---

## Migrations para rodar

Execute ao fazer deploy da branch. O `npm start` roda `apply_migrations.js` automaticamente.

| # | Arquivo | Risco |
|---|---|---|
| 081 | `cabines_lives_restructure.sql` | Baixo — `UPDATE status='ativa'→'disponivel'`, colunas novas com `IF NOT EXISTS` |
| 082 | `live_metric_revisions.sql` | Zero — nova tabela |
| 083 | `vendas_atribuidas_aprovacao.sql` | Baixo — 4 novas colunas com defaults |
| 084 | `performance_indexes.sql` | Zero — só índices `IF NOT EXISTS` |

> ⚠️ **Antes de rodar em produção:** confirmar com `SELECT count(*), status FROM cabines GROUP BY status` quantas cabines estão com status `ativa`. Se houver, a migration 081 vai migrar para `disponivel`.

---

## Questões abertas antes do go-live

Ver `docs/decisions/open-questions.md` para lista completa. Prioridades:

1. **Q5 — URLs de produção e staging confirmadas** (crítico — infra)
2. **Q1 — live_requests vs agenda_eventos** (bridge funcional mas migração de dados pendente)
3. **Q2 — Confirmar zero cabines com status `ativa` em produção** antes da 081
4. **Seed de usuários de teste** para E2E rodarem sem `test.skip`

---

## Como fazer o deploy

```bash
# 1. No Railway (backend):
# Mudar branch deploy para stabilization/core-restructure
# As migrations rodam automático no boot (npm start = apply_migrations + server)

# 2. No Firebase (frontend):
cd /tmp/Livelab-Front/react-app
npm run build
firebase deploy --only hosting --project livelab-3601f

# 3. Verificar:
# GET /healthcheck → 200
# GET /v1/public/ranking → 200 sem auth
# Login com franqueado → dashboard carrega
# Login com cliente_parceiro → onboarding ou /cliente
```

---

## Push para GitHub

A conta `leonardoames` precisa de **write access** nos dois repos do `Greed9797`:
- `Greed9797/Livelab-back` → Settings → Collaborators → Add `leonardoames`
- `Greed9797/Livelab-Front` → Settings → Collaborators → Add `leonardoames`

Depois:
```bash
cd /tmp/Livelab-back && git push -u origin stabilization/core-restructure
cd /tmp/Livelab-Front && git push -u origin stabilization/core-restructure
```
