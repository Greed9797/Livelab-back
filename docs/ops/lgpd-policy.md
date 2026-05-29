# Política de Privacidade e Retenção de Dados — LGPD

**Versão:** 1.0  
**Data:** 2026-05-18  
**Responsável:** Equipe de Engenharia

---

## 1. Dados Pessoais Coletados

| Dado | Tabela | Campo | Base Legal (LGPD) |
|------|--------|-------|-------------------|
| Nome completo | `clientes` | `nome` | Execução de contrato |
| E-mail | `clientes`, `users` | `email` | Execução de contrato |
| Celular / Telefone | `clientes` | `celular`, `telefone` | Execução de contrato |
| CPF | `clientes` | `cpf` | Obrigação legal |
| CNPJ / Razão Social | `clientes`, `tenants` | `cnpj`, `razao_social` | Execução de contrato |
| Endereço (CEP, cidade, estado) | `clientes` | `cep`, `cidade`, `estado` | Execução de contrato |
| Geolocalização (lat/lng) | `clientes` | `lat`, `lng` | Legítimo interesse |
| Dados de acesso (IP, papel) | logs de autenticação | — | Segurança / obrigação legal |
| Histórico de lives e faturamento | `lives` | `fat_gerado`, `iniciado_em` | Execução de contrato |
| Token de sessão | armazenamento cliente (localStorage) | — | Execução de contrato |

## 2. Política de Retenção

| Categoria | Retenção | Justificativa |
|-----------|----------|---------------|
| Dados cadastrais do cliente | 5 anos após encerramento do contrato | Obrigação fiscal/contábil |
| Dados de lives e faturamento | 5 anos | Obrigação fiscal (Lei 9.430/96) |
| Logs de auditoria (`audit_log`) | 2 anos | Segurança e compliance |
| Logs de notificação (`notification_log`) | 1 ano | Operacional |
| Refresh tokens expirados (`refresh_tokens`) | Purgar mensalmente | Sem valor após expiração |
| Dados de onboarding | Enquanto ativo, 1 ano após cancelamento | Suporte ao franqueado |
| Soft-deleted (`deleted_at IS NOT NULL`) | 30 dias, depois purgar | Janela de recuperação |

## 3. Como Exportar Dados de um Cliente

### Via API (endpoint LGPD)

```
GET /v1/clientes/:id/exportar-dados
Authorization: Bearer <token>
```

- Exige papel `franqueador_master` ou `franqueado` do tenant do cliente.
- Retorna JSON com `Content-Disposition: attachment` (download direto).
- Inclui: nome, email, celular, cnpj, cpf, razao_social, nicho, cidade, estado, criado_em, total_lives, ultima_live, gmv_acumulado.

### Via banco de dados (admin)

```sql
SELECT c.nome, c.email, c.celular, c.cpf, c.cnpj, c.razao_social,
       c.cidade, c.estado, c.criado_em,
       COUNT(l.id) AS total_lives
FROM clientes c
LEFT JOIN lives l ON l.cliente_id = c.id
WHERE c.id = '<uuid-do-cliente>'
GROUP BY c.id;
```

## 4. Como Deletar Dados de um Cliente (Direito ao Esquecimento)

### Passo 1 — Soft delete via API

```
DELETE /v1/clientes/:id
Authorization: Bearer <token> (papel franqueado ou master)
```

Define `deleted_at = NOW()`. O cliente some das listagens mas os dados permanecem por 30 dias.

### Passo 2 — Purga definitiva (após 30 dias ou a pedido)

```sql
-- Verificar antes de purgar
SELECT id, nome, deleted_at FROM clientes
WHERE id = '<uuid>' AND deleted_at IS NOT NULL;

-- Remover dados pessoais (anonimizar em vez de deletar para preservar integridade referencial)
UPDATE clientes SET
  nome = 'ANONIMIZADO',
  email = NULL,
  celular = NULL,
  cpf = NULL,
  cnpj = NULL,
  razao_social = NULL,
  lat = NULL, lng = NULL, cep = NULL, cidade = NULL, estado = NULL
WHERE id = '<uuid>' AND deleted_at IS NOT NULL;
```

> Nota: lives e faturamento podem ser mantidos anonimizados por obrigação fiscal.

## 5. Segurança e Não-Vazamento de Dados

- **Logs de erro**: `errorContext` nunca inclui `request.body` — apenas `request_id`, `tenant_id`, `papel` (ver `src/app.js`).
- **CORS**: em produção, sem wildcard `'*'`. Allowlist explícita em `src/app.js` e via `CORS_ORIGIN` no deploy.
- **JWT**: armazenado em `localStorage` no frontend — ver nota de segurança em `src/services/auth-storage.ts`.
- **Senhas**: hash bcrypt (custo 10), nunca logadas. Campos `senha_hash` e `password` nunca aparecem em logs.
- **Sentry**: apenas `user.id` e `papel` enviados — sem email, CPF ou dados pessoais.

## 6. Endpoints Relevantes

| Endpoint | Descrição | Papel necessário |
|----------|-----------|-----------------|
| `GET /v1/clientes/:id/exportar-dados` | Exportação LGPD de dados pessoais | franqueado, franqueador_master |
| `DELETE /v1/clientes/:id` | Soft-delete do cliente | franqueado, gerente, franqueador_master |
| `GET /v1/financeiro/franqueadora` | Visão financeira consolidada (royalties/marketing) | franqueador_master |
| `GET /v1/financeiro/resumo?scope=franqueadora` | Resumo financeiro com visão franqueadora | franqueador_master |

## 7. Contato para Exercício de Direitos

Para solicitações de acesso, correção, exclusão ou portabilidade de dados (Art. 18 LGPD), o titular deve contatar o encarregado (DPO) da franqueadora responsável pela unidade em questão.
