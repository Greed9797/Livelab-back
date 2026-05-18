# Ambientes LiveLab

## Produção
- Frontend URL: https://app.grupolivelab.com.br
- Backend URL: https://liveshop-saas-api-production.up.railway.app/v1
- Banco: PostgreSQL via Supabase (db.SEU_PROJETO.supabase.co)
- Branch: main / master
- Deployment: Railway (frontend: Firebase, backend: Railway)

## Homologação/Staging
- Frontend URL: PLACEHOLDER (ex: https://staging.grupolivelab.com.br ou Firebase staging)
- Backend URL: PLACEHOLDER (ex: https://liveshop-saas-api-staging.up.railway.app/v1)
- Banco: PLACEHOLDER (PostgreSQL separado de produção, preferencialmente Supabase separada)
- Branch: stabilization/core-restructure (em implementação)
- Status: A CONFIGURAR
- Nota: Deve ser um ambiente completo para validar PRs antes de merge para main

## Desenvolvimento Local
- Frontend: http://localhost:5173
- Backend: http://localhost:3000
- Banco: PostgreSQL local ou contra branch de staging via proxy (vide vite.config.ts)
- NODE_ENV: development

## Variáveis de Ambiente Obrigatórias — Backend

### Produção (imprescindíveis para boot)
- `JWT_SECRET` (mínimo 32 caracteres, CRÍTICO)
- `DATABASE_URL` (PostgreSQL connection string)

### Banco de Dados
- `DATABASE_URL`: postgresql://user:pass@host:5432/dbname
- `DB_SSL_REJECT_UNAUTHORIZED`: true (produção), false (dev)

### Autenticação & Segurança
- `JWT_SECRET`: Token secreto (gerar com: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
- `JWT_EXPIRES_IN`: 15m (default)
- `OAUTH_STATE_SECRET`: HMAC secret para validação OAuth (separado de JWT_SECRET, S-13)
- `TOKEN_ENCRYPTION_KEY`: AES-256-GCM para tokens TikTok (gerar igual acima, S-07)
- `HEALTH_CHECK_TOKEN` (opcional): Se setado, /health requer header X-Health-Token (S-11)

### CORS & Frontend
- `CORS_ORIGIN`: Origins permitidas (comma-separated). Vazio = permitir tudo (dev only)
  - Produção default: https://app.grupolivelab.com.br, https://www.grupolivelab.com.br, https://livelab-3601f.web.app, https://livelab-3601f.firebaseapp.com
- `FRONTEND_URL`: Base URL para montar links em e-mails e OAuth redirect (default: https://livelab-3601f.web.app)

### Servidor
- `PORT`: 3001 (default)
- `NODE_ENV`: production / development / test

### Integrações Externas

#### TikTok Live (opcional)
- `TIKTOK_OAUTH_ENABLED`: false (default) | true
- `TIKTOK_CLIENT_KEY`: Client ID do app TikTok
- `TIKTOK_CLIENT_SECRET`: Client secret do app TikTok
- `TIKTOK_REDIRECT_URI`: https://api.seudominio.com/v1/tiktok/callback
- `TIKTOK_WEBHOOK_REQUIRE_SIGNATURE`: true (validar HMAC dos webhooks)
- `TIKTOK_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS`: 300 (tolerância de timestamp)
- `TIKTOK_CB_THRESHOLD`: 5 (circuit breaker: falhas até rejeitar)
- `TIKTOK_CB_WINDOW_MS`: 300000 (5 min: janela pra contar falhas)
- `TIKTOK_MAX_CONNECTORS`: 20 (máx conexões TikTok Live simultâneas)

#### Bio CRM (Webhooks, S-08)
- `BIO_CRM_WEBHOOK_SECRET`: Secret para validar HMAC (obrigatório em produção)
- `BIO_WEBHOOK_DEFAULT_FRANQUEADORA_ID`: ID franqueadora padrão para leads via webhook

#### Appmax (Gateway de Pagamento)
- `APPMAX_APP_ID`: ID do aplicativo (painel Appmax → Desenvolvimento)
- `APPMAX_API_KEY`: API key gerada após instalação
- `APPMAX_WEBHOOK_SECRET`: Secret para validar webhooks Appmax
- `APPMAX_BASE_URL`: https://admin.appmax.com.br/api/v3 (padrão)

#### Supabase (Storage, opcional)
- `SUPABASE_URL`: https://SEU_PROJETO.supabase.co
- `SUPABASE_SERVICE_KEY`: Service role key para upload de arquivos

#### Resend (E-mail, F1)
- `RESEND_API_KEY`: API key Resend (se ausente, hooks viram no-op)
- `EMAIL_FROM`: noreply@grupolivelab.com.br (remetente padrão)

#### Sentry (Observability)
- `SENTRY_DSN`: DSN do projeto Sentry (opcional, recomendado em prod)
- `SENTRY_RELEASE`: liveshop_saas_api@X.X.X (versão, default: 1.0.0)

### Backup S3
- `BACKUP_S3_BUCKET`: liveshop-prod-backups (se ausente, cron ignorado)
- `BACKUP_S3_REGION`: us-east-1
- `BACKUP_S3_ACCESS_KEY`: AWS access key (AKIA...)
- `BACKUP_S3_SECRET_KEY`: AWS secret key
- `BACKUP_S3_ENDPOINT`: Para Cloudflare R2: https://<accountid>.r2.cloudflarestorage.com
- `BACKUP_RETENTION_DAYS`: 30 (default)

---

## Variáveis de Ambiente Obrigatórias — Frontend

### API
- `VITE_API_URL`: Base URL da API backend
  - Produção: https://liveshop-saas-api-production.up.railway.app/v1
  - Staging: PLACEHOLDER/v1
  - Local dev: http://localhost:3000/v1 (ou /v1 com proxy)

### Desenvolvimento Local (opcional)
- `VITE_DEV_API_PROXY_TARGET`: Proxy target para dev (ex: https://liveshop-saas-api-production.up.railway.app)
- `VITE_DEV_API_PROXY_ORIGIN`: Origin header do proxy (default: https://livelab-3601f.web.app)

---

## Providers de Infraestrutura (Confirmados)

| Serviço | Provider | Anotações |
|---------|----------|-----------|
| Backend API | Railway | liveshop-saas-api-production |
| Frontend (Produção) | Firebase Hosting | livelab-3601f.web.app, livelab-3601f.firebaseapp.com |
| Banco PostgreSQL | Supabase | db.SEU_PROJETO.supabase.co:5432 |
| Storage (arquivos) | Supabase Storage | Opcional, S-07 com criptografia |
| E-mail | Resend | F1: opcional, hooks no-op se ausente |
| Pagamentos | Appmax | Substituiu 100% Asaas (deprecado) |
| Webhooks | Bio CRM | Leads, S-08 com HMAC |
| Observability | Sentry | Opcional, recomendado produção |
| Backups | AWS S3 / Cloudflare R2 | Opcional, retenção 30 dias |

---

## Checklist de Configuração por Ambiente

### Staging (Antes do deploy)
- [ ] DATABASE_URL aponta para instância separada
- [ ] JWT_SECRET gerado novo (não reutilizar produção)
- [ ] CORS_ORIGIN inclui URL staging
- [ ] FRONTEND_URL aponta para staging frontend
- [ ] TikTok OAuth apps diferenciados (sandbox vs produção)
- [ ] Appmax configurado com sandbox credentials
- [ ] Sentry DSN dedicado (ou desativado)
- [ ] Backups S3 apontando para bucket staging

### Produção (Deploy)
- [ ] JWT_SECRET, TOKEN_ENCRYPTION_KEY, OAUTH_STATE_SECRET preenchidos
- [ ] DATABASE_URL & DB_SSL_REJECT_UNAUTHORIZED=true
- [ ] CORS_ORIGIN rigorosamente definido (nunca vazio)
- [ ] FRONTEND_URL = https://app.grupolivelab.com.br
- [ ] BIO_CRM_WEBHOOK_SECRET preenchido
- [ ] HEALTH_CHECK_TOKEN definido (segurança S-11)
- [ ] SENTRY_DSN preenchido
- [ ] Backups S3 testados e monitores configurados
- [ ] NODE_ENV=production
