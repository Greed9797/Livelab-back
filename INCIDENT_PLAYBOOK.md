# Incident Playbook — LiveShop SaaS

**Versão**: 1.0 — 2026-05-08
**Owner**: tech lead `@leonardo`
**Severity SLA**:
- 🔴 **P0** Critical (data leak, auth quebrada, app down) — resposta < 15min, mitigação < 1h
- 🟠 **P1** High (feature crítica down, latência > 5s, deploy falhou) — < 1h / < 4h
- 🟡 **P2** Medium (UX bug visível, pequeno data drift) — < 1 dia útil
- 🔵 **P3** Low (cosmético, log noise) — backlog

---

## 0. Quick reference (panic links)

| Recurso | URL |
|---|---|
| App prod | https://app.grupolivelab.com.br · https://livelab-3601f.web.app |
| Backend | https://liveshop-saas-api-production.up.railway.app/v1 |
| Health | https://liveshop-saas-api-production.up.railway.app/health |
| Railway dashboard | https://railway.app/project/<id> |
| Supabase dashboard | https://supabase.com/dashboard/project/wvmakdsjkuauwbcpubem |
| Firebase Hosting | https://console.firebase.google.com/project/livelab-3601f |
| Sentry (quando ativo) | https://sentry.io/organizations/livelab |
| UptimeRobot (quando ativo) | https://uptimerobot.com/dashboard |
| Status pages | https://status.supabase.com · https://status.railway.app · https://www.firebasestatus.com |
| Repo backend | https://github.com/Greed9797/liveshop_saas_api-backend- |
| Repo frontend | https://github.com/Greed9797/-liveshop_saas-frontend- |

### Credenciais teste (não-prod data)

| Role | Email | Senha |
|---|---|---|
| franqueador_master | admin@liveshop.com | admin123 |
| franqueado | franqueado@liveshop.com | teste123 |
| cliente_parceiro | cliente@liveshop.com | teste123 |

---

## 1. API Down (Backend Railway)

**Sintomas**: UptimeRobot alerta, frontend mostra "Erro de conexão", `curl /health` falha.

### Triagem (5min)

```bash
# 1. Confirmar
curl -i https://liveshop-saas-api-production.up.railway.app/health

# 2. Status Railway
open https://status.railway.app

# 3. Logs recente
railway logs --tail 200
```

### Causas comuns

| Sintoma | Causa | Ação |
|---|---|---|
| 502/503 + container restart loop | Crash no boot | Railway dashboard → Logs → procurar `Error:` na primeira linha |
| `ECONNREFUSED postgres` | DB indisponível | Pular pra "DB Down" |
| `JWT_SECRET undefined` | Env var sumiu | Railway → Variables → restaurar de `.env.example` |
| Out of memory | Query pesada / leak | Aumentar plano OR rollback último deploy |
| 5xx em todas rotas | Bug em deploy recente | **Rollback** (próx seção) |

### Rollback Railway (< 2min)

1. Railway dashboard → Deployments
2. Clicar no deploy ANTERIOR ao quebrado → "Redeploy"
3. Aguardar health check verde
4. `curl /health` confirma 200

### Postmortem

Após restaurar:
- Criar issue GitHub com timeline (alerta → mitigação → resolução)
- Adicionar regression test que pegue o bug
- Atualizar este playbook se nova classe de erro

---

## 2. Frontend Down (Firebase Hosting)

**Sintomas**: `app.grupolivelab.com.br` 502/503, `livelab-3601f.web.app` mostra erro.

### Triagem

```bash
curl -I https://livelab-3601f.web.app
# 200 esperado
```

### Causas comuns

| Sintoma | Causa | Ação |
|---|---|---|
| Tela cinza após deploy | JS bundle quebrado | Rollback Firebase |
| Custom domain falha mas web.app OK | DNS issue | Cloudflare/Registro.br |
| Service Worker stale | Cache corrupto | DevTools → Application → Storage → Clear site data |

### Rollback Firebase Hosting

```bash
firebase hosting:rollback --project livelab-3601f
# Ou via UI: Console → Hosting → Versions → "Rollback"
```

### Cache invalidation total

`firebase.json` já força `must-revalidate` em `index.html`, `main.dart.js`, `flutter_bootstrap.js`. Usuário em aba normal pode ter SW stale — instruir aba anônima ou:
1. DevTools → Application → Storage → "Clear site data"
2. Hard refresh `Ctrl+Shift+R`

---

## 3. DB Down (Supabase Postgres)

**Sintomas**: backend 500 com `connection refused`, todas as queries falham.

### Triagem

```bash
# Status Supabase
open https://status.supabase.com

# psql direto
set -a; source .env; set +a
psql "$DATABASE_URL" -c "SELECT 1"
```

### Causas comuns

| Sintoma | Causa | Ação |
|---|---|---|
| `role X is not allowed to connect` | Senha rotacionada | Supabase → Settings → DB → Reset password → atualizar `DATABASE_URL` |
| `too many connections` | Pool exhaustion | Aumentar `max` em `src/plugins/db.js` (default 20) ou plano Supabase |
| Tudo 5xx | Supabase indisponível | Aguardar status Supabase. Status page atualiza ~5min |
| RLS bypass / data leak | Role com BYPASSRLS | **Pular pra seção 5 RLS Leak** |

### Backup restore (P0)

Supabase backup retention 7 dias (free) / 30 dias (Pro):

1. Supabase dashboard → Database → Backups
2. Selecionar timestamp pré-incident
3. "Restore" — confirma com nome do projeto
4. **Atenção**: restore SUBSTITUI DB inteira; perde dados pós-snapshot

Para backup offsite (preferido), ver seção P4.1 do plano P5.

---

## 4. Deploy Falhou

### Backend (Railway)

```bash
# Confirmar último commit aplicado
git log origin/master --oneline -5

# Forçar redeploy
railway up
# OU pelo dashboard
```

Se migration falhou:
1. Railway logs → procurar `[migrations] ❌ Falha em XXX.sql`
2. **Não** rodar `node apply_migrations.js` localmente em prod sem cuidado
3. Criar nova migration que corrige (ex `062_fix_xxx.sql`) — migrations são append-only

### Frontend (Firebase)

```bash
cd ~/Documents/Playground/-liveshop_saas-frontend-
flutter analyze
flutter build web --release --dart-define=API_URL=https://liveshop-saas-api-production.up.railway.app/v1
firebase deploy --only hosting --project livelab-3601f
```

`Authentication Error: Your credentials are no longer valid` → `firebase login --reauth`

---

## 5. RLS Leak / Data Cross-Tenant

**Sintomas**: usuário do tenant A vê dados de tenant B.

⚠️ **P0 Critical** — possible LGPD violation, escalate imediato.

### Triagem

```bash
# Confirmar role atual em uso
set -a; source .env; set +a
psql "$DATABASE_URL" -c "SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname=current_user"
# Se rolbypassrls=t → RLS NÃO está protegendo
```

### Mitigação imediata (5min)

1. **Rotate credentials** Supabase (Settings → DB → Reset password). Bloqueia acesso ativo.
2. **Atualizar** `DATABASE_URL` Railway com nova password
3. **Invalidar** sessões: rodar SQL
   ```sql
   UPDATE refresh_tokens SET revogado = true;
   ```
   (todos usuários precisam re-login)

### Fix definitivo (30min)

Ver `~/security-report.md` seção "CRITICAL FINDING (2026-05-07)":

1. Criar role `liveshop_app NOBYPASSRLS LOGIN`
2. Grants: `SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public`
3. Atualizar `DATABASE_URL` Railway pra nova role
4. Validar: `node scripts/audit-rls.js` reporta 🟢 BYPASSRLS=não

### Verificação pós-fix

```bash
node scripts/audit-rls.js
# Deve reportar todas tabelas 🟢 ENABLED + 0 rows tenant_id NULL
```

---

## 6. Webhook Replay Attack

**Sintomas**: leads duplicados, eventos Asaas/Appmax processados múltiplas vezes.

### Triagem

```sql
-- Ver eventos repetidos webhook
SELECT source, nonce, COUNT(*)
  FROM webhook_replay_log
 WHERE recebido_em > NOW() - INTERVAL '1 hour'
 GROUP BY 1, 2 HAVING COUNT(*) > 1;
```

### Mitigação

```bash
# Confirmar replay protection ativo
railway variables get WEBHOOK_REPLAY_PROTECTION
# Esperado: true
```

Se ainda `false`, ativar imediato:

```bash
railway variables set WEBHOOK_REPLAY_PROTECTION=true
```

(requer sender bio-crm enviar `X-Livelab-Timestamp` + `X-Livelab-Nonce` — coordenar com Bio app team)

---

## 7. Performance Degradation

**Sintomas**: latência > 2s, frontend mostra spinners infinitos.

### Triagem

```bash
# Backend latência
time curl https://liveshop-saas-api-production.up.railway.app/health
# < 500ms esperado

# DB query lenta
psql "$DATABASE_URL" -c "
  SELECT query, calls, mean_exec_time
    FROM pg_stat_statements
   ORDER BY mean_exec_time DESC LIMIT 10
"
```

### Causas comuns

- Index ausente → `EXPLAIN ANALYZE` em query lenta + criar index
- Pool exhausto → aumentar `max` connections
- Query N+1 → batch ou JOIN
- Bundle Flutter Web 13MB → CDN canvaskit (Wave 3)

---

## 8. Credenciais vazadas

**Sintomas**: usuário externo reporta acesso indevido, ou suspeita-se de leak (commit acidental, screenshot público).

⚠️ **Rotate everything que possa ter vazado**:

| Credencial | Onde rotacionar |
|---|---|
| `DATABASE_URL` (senha PG) | Supabase Settings → DB |
| `JWT_SECRET` | Railway Variables (gera novo 32+ chars) — força re-login todos users |
| `ASAAS_API_KEY` / `APPMAX_API_KEY` | Painel respectivo |
| `BIO_CRM_WEBHOOK_SECRET` | Coordenar com Bio app team |
| `SENTRY_DSN` | sentry.io → Project Settings → Client Keys |
| Firebase service account | Console → IAM → revoke + new key |
| GitHub PAT (CI) | github.com/settings/tokens → revoke |

Plus: **invalidar sessões ativas**:

```sql
UPDATE refresh_tokens SET revogado = true;
```

---

## 9. Comunicação durante incidente

| Severity | Quem avisar | Como |
|---|---|---|
| P0 | Tech lead + product owner | WhatsApp + email |
| P1 | Tech lead | Slack #incidents |
| P2 | Time dev | GitHub issue |
| P3 | — | Backlog |

**Status page** (futuro): criar `/status` página pública refletindo Railway/Supabase/Firebase.

---

## 10. Pós-incident review (PIR)

Após qualquer P0/P1, dentro de 48h:

1. **Timeline**: quando começou, quando detectado, quando mitigado, quando fechado
2. **Causa raiz**: 5 whys
3. **Ações corretivas**:
   - Test que pega o bug
   - Monitoring que detecta antes (Sentry/UptimeRobot)
   - Atualizar este playbook se nova classe
4. **Blameless**: foco no sistema, não em pessoas

Template em `docs/incidents/<YYYY-MM-DD>-<slug>.md`.

---

## Manutenção deste playbook

- Cada incidente real → adicionar nova entrada à seção relevante
- Review mensal pra garantir links/comandos atuais
- Versionar mudanças via git (commits convencionais: `docs(playbook): ...`)
