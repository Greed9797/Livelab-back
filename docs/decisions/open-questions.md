# Questões Abertas — LiveLab Reestruturação Core (PR 0)

Documento que registra decisões necessárias antes de continuar com PRs 1-5 da reestruturação core. Deve ser revisado semanalmente com o time e atualizado conforme decisões são tomadas.

---

## Q1 — Migração live_requests → agenda_eventos

**Status:** BLOCKER para PR 5 (Agenda como fonte oficial)

**Contexto:**
- `live_requests` (tabela legada) e `agenda_eventos` (tabela nova) coexistem sem integração
- `agenda_eventos` ainda não é fonte oficial de verdade para agendas de lives
- Existe duplicação de dados e lógica em múltiplas rotas

**Opções:**
- **A:** Deprecar `live_requests`, migrar dados históricos para `agenda_eventos`
  - Vantagem: Fonte única de verdade
  - Desvantagem: Migration complexa, risco de inconsistência
  
- **B:** Manter ambas — `live_requests` = "solicitação cliente", `agenda_eventos` = "agenda interna"
  - Vantagem: Menos complexidade
  - Desvantagem: Duplicação de código, confusão para novos devs

- **C:** Usar `agenda_eventos` apenas pra futuro, deprecar lentamente
  - Vantagem: Gradual, menos risco
  - Desvantagem: Debt acumula

**Decisão necessária:** Antes de implementar PR 5

**Responsável:** Tech lead + Product

**Informações para decidir:**
- Quantas lives ativas usam `live_requests`?
- Histórico é importante? (dados > 90 dias)
- Como clients acessam agendas? (API? Dashboard?)

---

## Q2 — Status 'ativa' nas cabines (Remanente de Cleanup)

**Status:** MEDIUM PRIORITY — Antes de ir pra produção

**Contexto:**
- Migration 080 removeu constraint `status` em cabines, mantendo o enum `['disponivel', 'reservada', 'ativa']`
- Código ainda referencia `status='ativa'` em alguns lugares
- Produção pode ter cabines com status inválido após migration

**Opções:**
- **A:** Remover 'ativa' do enum completamente, zerar cabines com esse status para 'disponivel'
  - Vantagem: Limpo, uma source of truth
  - Desvantagem: Perda de informação sobre cabines que estavam "ativas"
  
- **B:** Manter 'ativa' porém mapear para 'reservada' internamente
  - Vantagem: Compatibilidade
  - Desvantagem: Confusão semântica

- **C:** Reintroduzir 'ativa' com significado claro (ex: "em live agora")
  - Vantagem: Mais informação
  - Desvantagem: Replica state que já está em `live_sessions`

**Decisão necessária:** Antes de data de cutover para produção

**Query para análise:**
```sql
SELECT status, COUNT(*) FROM cabines GROUP BY status;
-- Quantas cabines estão com cada status em produção?

SELECT * FROM cabines WHERE status = 'ativa' LIMIT 10;
-- Qual contexto dessas cabines? Estão em live agora?
```

**Responsável:** Product + Backend lead

---

## Q3 — Live sem cliente: qual marca usar?

**Status:** BLOCKER para múltiplos tipos de live

**Contexto:**
- Tabela `marcas` exige `cliente_id` quando `tipo='cliente'`
- Algumas lives são iniciadas sem cliente específico (afiliado, teste, interna)
- Código atual falha ao tentar criar marca pra essas lives

**Opções:**
- **A:** Criar marca genérica por unidade (ex: "Marca Teste Unidade 01")
  - Vantagem: Simples, tudo tem marca
  - Desvantagem: Poluição de dados, confusão em reports

- **B:** Deixar `cliente_id = NULL` quando `tipo != 'cliente'`
  - Vantagem: Semântica correta
  - Desvantagem: Precisa validação em queries que usam `cliente_id`

- **C:** Campo `marca_id` obrigatório apenas se `tipo='cliente'`
  - Vantagem: Flexibilidade, validação clara
  - Desvantagem: Lógica condicional aumenta

- **D:** Sempre exigir marca, mas permitir marca "Sistema/Teste"
  - Vantagem: Source única de verdade
  - Desvantagem: Seed data inicial complexa

**Decisão necessária:** Antes de implementar rotas de live_apresentadores

**Responsável:** Product + Design

**Impacta:** 
- `/v1/api/live_apresentadores` (criar live)
- `/v1/api/marcas` (schema validation)
- Reports & analytics (como agrupar lives sem cliente?)

---

## Q4 — Múltiplos tenants por usuário: fluxo de login

**Status:** MEDIUM — Feature for future sprints

**Contexto:**
- `user_tenant_access` já modelado (permite N tenants por user)
- RLS por `tenant_id` implementado
- Mas **painel assume um tenant único por sessão**
- Usuário com acesso a múltiplas unidades não sabe pra qual fazer login

**Opções:**
- **A:** Tela de seleção (pós-login): "Selecione sua unidade"
  - Vantagem: Explícito, fácil de implementar
  - Desvantagem: UX ruim pra usuários do-day (sempre seletar)

- **B:** Última unidade usada armazenada em browser
  - Vantagem: UX boa, hidden complexity
  - Desvantagem: E se usuário perder acesso? Redirect em cascata?

- **C:** Unidade padrão no profile do usuário (`usuarios.tenant_id_default`)
  - Vantagem: Administrativo, flexível
  - Desvantagem: Mais um campo pra gerenciar

- **D:** Login flow retorna todas as unidades, JS escolhe primeira (ou default)
  - Vantagem: Zero UX impact
  - Desvantagem: Backend precisa listar tenants no auth endpoint

**Decisão necessária:** Sprint planning (não é blocker agora)

**Responsável:** Frontend lead + Product

**Teste:**
- Criar usuário com 2+ tenants
- Fazer login, verificar qual tenant é selecionado
- Verificar RLS funciona corretamente

---

## Q5 — URLs de Produção e Staging

**Status:** CRITICAL — Antes de qualquer deploy pra homolog

**Contexto:**
- Variáveis de ambiente assumem URLs específicas
- CORS_ORIGIN, FRONTEND_URL hardcoded
- Staging não está configurado

**Questões:**
- Qual é a URL atual de produção do frontend? (app.grupolivelab.com.br? Firebase?)
- Qual é a URL atual de produção do backend? (Railway? Render?)
- Banco de produção está **separado** de dev?
- Existe backup configurado em produção?
- Staging terá URL separada ou é branch diferente no mesmo painel?

**Checklist:**
- [ ] Confirmar URLs com infraestrutura team
- [ ] Validar CORS_ORIGIN inclui ambos (prod + staging)
- [ ] Confirmar Railway/Render projects separados pra prod vs staging
- [ ] Confirmar Supabase databases separadas
- [ ] Backup S3 configurado & testado
- [ ] Rollback procedure documentado

**Referência:** `/tmp/Livelab-back/docs/ops/environments.md`

---

## Q6 — Supabase Storage vs S3 para Upload de Arquivos

**Status:** MEDIUM — Design decision

**Contexto:**
- `.env.example` menciona Supabase Storage (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`)
- Mas também há backup em S3 (`BACKUP_S3_*`)
- Ambos implementados? Conflito de usos?

**Opções:**
- **A:** Tudo em Supabase Storage (simpler stack)
  - Vantagem: Menos providers, integração nativa
  - Desvantagem: Custo, performance se muitos arquivos

- **B:** User files em Supabase, backups em S3
  - Vantagem: Separação de concerns
  - Desvantagem: Dois providers

- **C:** Tudo em S3/Cloudflare R2 (mais barato)
  - Vantagem: Preço, performance
  - Desvantagem: Implementar auth/presigned URLs

**Decisão necessária:** Antes de otimizar upload flow

**Responsável:** Infra + Backend lead

---

## Q7 — Padrão de Versionamento de API

**Status:** LOW — Documentation only

**Contexto:**
- URLs usam `/v1` (ex: `/v1/api/clientes`)
- Plano pra `v2`?
- Como fazer migrations de endpoints?

**Documentar:**
- Lifecycle de endpoint: v1 → deprecated → v2 → removed
- Timeline: quando remover endpoints antigos?
- Comunicação com clients sobre deprecation

**Responsável:** Backend lead

---

## Q8 — Audit Log Retention & Gdpr

**Status:** LOW — Compliance item

**Contexto:**
- `audit_logs` cresce indefinidamente
- GDPR exige "direito ao esquecimento" (deletion de dados pessoais)
- Não há processo pra deletar dados antigos

**Questões:**
- Quanto tempo reter logs? (default: indefinido)
- Como fazer anonymization vs deletion?
- Notificar users antes de deletar seu histórico?

**Plano:**
- Documentar retention policy
- Implementar cron pra archived > 2 years
- Testar GDPR deletion

**Responsável:** Compliance + Backend lead

---

## Q9 — Integração TikTok: Fluxo de Dados

**Status:** MEDIUM — Antes de PR de TikTok Live

**Contexto:**
- `TIKTOK_OAUTH_ENABLED`, webhooks, circuit breaker configurados
- Mas fluxo end-to-end não está claro

**Questões:**
- Quando user autoriza TikTok, armazenar token onde?
- How to refresh tokens? (S-07 encryption clear?)
- Webhook TikTok → qual rota? Como validar signature?
- Rate limits TikTok vs Backend?

**Responsável:** Backend lead + Product

**Referência:** `src/routes/tiktok.js`, `src/plugins/tiktok*.js`

---

## Q10 — Appmax Payment Workflow

**Status:** MEDIUM — Antes de finalizar PR de pagamentos

**Contexto:**
- Asaas removido 100%, Appmax implementado
- `APPMAX_APP_ID`, `APPMAX_API_KEY`, `APPMAX_WEBHOOK_SECRET` configurados
- Mas fluxo não está documentado

**Questões:**
- Qual dados são enviados pra Appmax? (cliente, valor, vencimento)
- Webhook Appmax retorna quais eventos? (paid? overdue? cancelled?)
- Reconciliação: como validar que pagamento em Appmax = pagamento em DB?
- Retry logic: quantas tentativas antes de falhar?

**Responsável:** Financeiro + Backend lead

**Test:**
- Criar cobrança em staging
- Testar webhook (via ngrok ou painel Appmax)
- Validar que status atualiza em DB

---

## Q11 — Email Provider (Resend) Health Check

**Status:** LOW — Observability

**Contexto:**
- `RESEND_API_KEY` pode estar ausente (degradação segura)
- Mas se setado, como monitorar deliverability?

**Questões:**
- Hooks de e-mail tentam enviar, falham silenciosamente?
- Como saber se Resend está down?
- Rate limits: quantos e-mails por hora?

**Responsável:** Backend lead

---

## Q12 — RLS (Row-Level Security) por Tenant

**Status:** CRITICAL — Core da multi-tenancy

**Contexto:**
- RLS policies implementados em migrations
- Mas cobertura não é 100%

**Questões:**
- Quais tabelas ainda faltam RLS policy?
- Como testar RLS em produção sem quebrar?
- Fallback se RLS falhar: query retorna erro ou dados inválidos?

**Checklist:**
- [ ] Auditoria de todas as tabelas críticas
- [ ] Test RLS por tenant (criar 2 users, 2 tenants)
- [ ] Validar que user A não consegue ler data de user B

**Query pra listar policies:**
```sql
SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public';
```

**Responsável:** Backend lead

---

## Resumo das Ações Imediatas (Sprint Atual)

| Q | Prioridade | Deadline | Responsável |
|---|---|---|---|
| Q1 | BLOCKER | Antes de PR 5 | Tech lead |
| Q2 | HIGH | Antes de prod | Backend lead |
| Q3 | BLOCKER | Antes de live_apresentadores | Product |
| Q4 | MEDIUM | Sprint 3 | Frontend lead |
| Q5 | CRITICAL | Hoje | Infra team |
| Q6 | MEDIUM | Sprint 2 | Infra |
| Q7 | LOW | Documentation | Backend lead |
| Q8 | LOW | Compliance review | Compliance |
| Q9 | MEDIUM | Sprint 3 | Backend lead |
| Q10 | MEDIUM | Sprint 2 | Financeiro |
| Q11 | LOW | Sprint 2 | Backend lead |
| Q12 | CRITICAL | Sprint 1 | Backend lead |

---

## Process para Atualizar este Documento

1. **Semanal:** Review com tech lead (toda segunda 10:00)
2. **Decisão:** Quando Q é respondida, atualizar com:
   - `Status: DECIDED`
   - Decisão & rationale
   - Data da decisão
   - Link pra PR/issue se aplicável
3. **Arquivo:** Após decisão, mover pra `/tmp/Livelab-back/docs/decisions/YYYY-MM-DD-qN-decision.md`
4. **Comunicar:** Postar em #tech-decisions Slack

---

## Exemplo de Decisão Registrada (Template)

```markdown
## Q1 — Migração live_requests → agenda_eventos [DECIDED]

**Decisão:** Opção A — Deprecar live_requests, migrar dados

**Data:** 2026-05-18

**Rationale:**
- Fonte única de verdade = menos bugs
- Analytics simplificado
- Migration pode ser feita em staging antes de prod

**Implementação:**
- PR #123: Data migration script (rolling)
- PR #124: Remove live_requests routes
- PR #125: Update docs

**Teste:**
- [ ] Migration test em sandbox: 1M+ live_requests restored
- [ ] Validar agenda_eventos tem todos os campos
- [ ] Backward compat: old API calls redirectem a novo schema

**Comunicado em:** #tech-decisions, email para stakeholders
```

---

**Última atualização:** 2026-05-18  
**Próxima revisão:** 2026-05-25
