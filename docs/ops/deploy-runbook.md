# Deploy Runbook — LiveLab PR 0

## Pré-Deploy Checklist

### 1. Validar Status da Branch
```bash
cd /tmp/Livelab-back
git status
git log --oneline -5
```
- [ ] Branch: stabilization/core-restructure (ou main para produção)
- [ ] Sem commits não-pushed
- [ ] Sem arquivos uncommitted

### 2. Validar Testes
```bash
npm test
npm run lint
```
- [ ] Todos os testes passando
- [ ] Sem warnings de lint críticos

### 3. Verificar Migrations
```bash
npx knex migrate:status
```
- [ ] Todas as migrations da branch estão listed
- [ ] Não há conflicts entre migrations

### 4. Validar Secrets & Variáveis
- [ ] Confirmar com DevOps que vars de produção estão atualizadas em Railway/Render
- [ ] JWT_SECRET (novo ou rotacionado?)
- [ ] DATABASE_URL aponta para DB correto
- [ ] BIO_CRM_WEBHOOK_SECRET, APPMAX secrets preenchidos
- [ ] Certificados SSL/HTTPS válidos

### 5. Comunicação
- [ ] Notificar #deploys Slack com:
  - Nome da branch
  - Resumo das mudanças (PRs incluídas)
  - Janela estimada
  - Plano de rollback

### 6. Backup Pré-Deploy
```bash
# No painel de infraestrutura (Railway/Supabase):
# Trigger backup manual do banco de dados
# Validar que backup foi executado com sucesso
```
- [ ] Backup banco de dados completado
- [ ] Backup S3 recente (< 24h)

---

## Deploy de Backend

### Estratégia 1: Railway (Atual — Recomendado)

#### 1.1 Via Railway Dashboard
1. Acessar https://railway.app → Projeto LiveLab
2. Selecionar Plugin: liveshop-saas-api-production
3. Deploy tab → "Latest Commit" ou branch específica
4. Clicar "Deploy"
5. Aguardar logs até "Service deployed successfully"

#### 1.2 Via CLI (Alternativa)
```bash
# Instalar Railway CLI: npm install -g @railway/cli
# Fazer login
railway login

# Deploy da branch atual
cd /tmp/Livelab-back
railway up --service liveshop-saas-api-production
```

#### 1.3 Validar Deploy
```bash
# Health check
curl -H "X-Health-Token: $HEALTH_CHECK_TOKEN" \
  https://liveshop-saas-api-production.up.railway.app/health

# Expected response: { "ok": true }
```

### Estratégia 2: Render (Se migrar de Railway)
```bash
# Render CLI: não tem deploy automático direto
# Deploy acontece via webhook GitHub (push para main)
# Manual: via Render dashboard → Services → liveshop-api → "Deploy"
```

### Verificações Pós-Deploy Backend
```bash
# 1. Verificar logs no painel de infra
railway logs --service liveshop-saas-api-production

# 2. Testar endpoints críticos
curl https://liveshop-saas-api-production.up.railway.app/v1/health
curl -H "Authorization: Bearer TOKEN" \
  https://liveshop-saas-api-production.up.railway.app/v1/api/home

# 3. Verificar métricas (Sentry, logs)
# Via https://sentry.io → project liveshop-saas-api
# Procurar por erros críticos (5xx) nos últimos 5 min

# 4. Verificar banco de dados
psql $DATABASE_URL -c "SELECT version();"
```
- [ ] /health respondendo 200
- [ ] Nenhum erro 5xx nos últimos 5 minutos
- [ ] Conexão banco de dados OK

---

## Deploy de Frontend

### Estratégia: Firebase Hosting (Atual)

#### 1. Build Local
```bash
cd /tmp/Livelab-Front/react-app

# Instalar deps se necessário
npm install

# Build
npm run build

# Expected: ./dist/index.html e assets compilados
```

#### 2. Deploy via Firebase CLI
```bash
# Instalar Firebase CLI se não tiver
npm install -g firebase-tools

# Fazer login (salva credenciais)
firebase login

# Deploy
firebase deploy --project livelab-3601f

# Ou apenas frontend:
firebase deploy --only hosting --project livelab-3601f
```

#### 3. Deploy via GitHub Actions (Alternativa — Se Configurado)
```bash
# Push para main (ou branch de deploy)
git push origin stabilization/core-restructure

# GitHub Actions detecta e faz deploy automático
# Acompanhar em: https://github.com/OWNER/repo/actions
```

#### 4. Validar Deploy
```bash
# Acessar URL de produção
https://app.grupolivelab.com.br
# ou
https://livelab-3601f.web.app

# Checklist visual:
# - Página carrega sem erros de rede
# - Logo e layout aparecem
# - Console do browser sem erros críticos
# - API calls apontando para backend correto (vide Network tab)
```

#### 5. Rollback Frontend (Se Necessário)
```bash
firebase hosting:rollback --project livelab-3601f

# Ou voltar versão anterior via Firebase Console:
# https://console.firebase.google.com → Hosting → Versions
```

---

## Rollback de Backend

### Cenário: Deploy introduziu erro crítico

#### Option 1: Railway Rollback
1. Acessar https://railway.app → Deployments tab
2. Clicar na versão anterior (último deploy bom)
3. Clicar "Rollback to this deployment"
4. Confirmar e aguardar redeploy

#### Option 2: Git Rollback + Redeploy
```bash
cd /tmp/Livelab-back

# Voltar commit anterior (não force-push se possível)
git revert HEAD --no-edit
git push origin stabilization/core-restructure

# Railway detecta novo push e redeploy automaticamente
railway logs --follow --service liveshop-saas-api-production
```

#### Option 3: Hotfix Branch (Recomendado)
```bash
# Se o problema é específico e identificado:
git checkout -b hotfix/rollback-issue
# ... fix code ...
git commit -m "fix(hotfix): revert migration XX or fix bug Y"
git push origin hotfix/rollback-issue

# Merge via PR para revisão rápida
# Redeploy após merge em main
```

### Validar Rollback
```bash
# Health check
curl https://liveshop-saas-api-production.up.railway.app/health

# Verificar versão antiga está rodando (vide logs)
railway logs --tail 50

# Confirmar migração foi revertida (se necessário)
npx knex migrate:status
```

---

## Rollback de Frontend

### Cenário: Deploy frontend quebrou UI

#### Opção 1: Firebase Rollback (Instantâneo)
```bash
firebase hosting:rollback --project livelab-3601f
```

#### Opção 2: Redeploy build anterior
```bash
# Se você tem os builds em cache/git:
git checkout <commit-anterior>
npm run build
firebase deploy --only hosting --project livelab-3601f
```

#### Opção 3: Via Firebase Console
1. https://console.firebase.google.com → Hosting
2. Versões → Selecionar versão anterior
3. Clicar "Promover"

---

## Verificação Pós-Deploy

### 1. Health Checks
```bash
# Backend
curl -H "X-Health-Token: $HEALTH_CHECK_TOKEN" \
  https://liveshop-saas-api-production.up.railway.app/health

# Frontend (visual)
open https://app.grupolivelab.com.br
```

### 2. Testes Críticos (Manual ou Automatizados)
- [ ] Login com usuário de produção
- [ ] Navegar principais seções (Clientes, Cabines, Analytics)
- [ ] Criar / editar recurso (ex: nova cabine)
- [ ] Testar integração TikTok (se relevante)
- [ ] Verificar e-mails (Resend)
- [ ] Confirmar pagamentos (Appmax)

### 3. Monitoramento (1h pós-deploy)
```bash
# Sentry
# Procurar por erros novos ou escalação de taxa de erro

# Railway / Render dashboard
# - CPU, memória
# - Latência de resposta
# - Taxa de erro HTTP

# Logs
railway logs --service liveshop-saas-api-production --follow
```

### 4. Comunicação Final
- [ ] Postar em #deploys que deploy está completo
- [ ] Mencionar se houve incidentes / rollbacks
- [ ] Agendar retrospectiva se problems ocorreram

---

## Casos de Erro Comum

| Erro | Causa Provável | Solução |
|------|---|---|
| `connect ECONNREFUSED 127.0.0.1:5432` | DB_URL inválida ou banco offline | Verificar DATABASE_URL, checar painel Supabase |
| `JWT_SECRET is not defined` | Var não setada em Railway/Render | Adicionar em secrets/environment variables |
| `CORS error from frontend` | CORS_ORIGIN não inclui domínio | Atualizar CORS_ORIGIN em Railway secrets |
| `Migration error: table already exists` | Migration roinou idempotent | Revisar migration, fazer rollback se necessário |
| `413 Payload Too Large` | Arquivo upload > 5MB | Vide multipart limit em app.js (5MB) |
| `Sentry 429 Too Many Events` | Quota de eventos Sentry excedido | Revisar error handling, aumentar sampler rate |

---

## Pós-Deploy (24-48h)

- [ ] Monitorar Sentry por erros novos
- [ ] Revisar analytics/logs pra anomalias
- [ ] Comunicar à equipe para testes em staging
- [ ] Documentar qualquer desvio ou issue no PR
- [ ] Se tudo OK, marcar PR como "Production Validated"
