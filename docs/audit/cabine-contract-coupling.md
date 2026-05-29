# Acoplamento Cabine → Contrato

> Auditoria gerada em: 2026-05-18
> Branch: `stabilization/core-restructure`
> Contexto: O plano de reestruturação prevê desacoplar cabines de contratos, tornando a cabine uma entidade independente associada diretamente ao cliente (via `cliente_id`), sem dependência de `contrato_id`.

---

## Arquivos com `contrato_id` em cabines

### `src/routes/cabines.js` — **39 ocorrências**

| Linha | Contexto | Tipo | Prioridade de remoção |
|---|---|---|---|
| 19 | `reservarCabineSchema: z.object({ contrato_id: z.string().uuid() })` | Schema de entrada | ALTA — endpoint de reserva depende disso |
| 123 | `const { contrato_id } = parsed.data` | Extração do body | ALTA |
| 153 | `SELECT c.id, ... c.contrato_id, ct.status AS contrato_status, ct.tiktok_username` | SELECT principal de listagem | MÉDIA — campo retornado na API |
| 169 | `LEFT JOIN contratos ct ON ct.id = c.contrato_id` | JOIN de contratos | MÉDIA |
| 242–258 | Endpoint `fila-ativacao`: `WHERE ct.status = 'ativo' AND NOT EXISTS (SELECT 1 FROM cabines cb WHERE cb.contrato_id = ct.id)` | Lógica de negócio inteira depende do vínculo | ALTA — endpoint deve ser redesenhado |
| 293 | `SELECT id, status, live_atual_id, contrato_id FROM cabines WHERE id = $1` | DELETE check | MÉDIA |
| 304 | `if (cabine.contrato_id) { return reply.code(409).send(...) }` | Guard no DELETE | MÉDIA |
| 357 | `const { contrato_id } = parsed.data` | Reservar endpoint | ALTA |
| 363–369 | `SELECT id, numero, status, contrato_id, live_atual_id FROM cabines WHERE id = $1 FOR UPDATE` | Lógica de reserva | ALTA |
| 382 | `if (cabine.status !== 'disponivel' \|\| cabine.contrato_id \|\| ...)` | Condição de disponibilidade | ALTA |
| 387–393 | `SELECT id, cliente_id, status FROM contratos WHERE id = $1 FOR UPDATE` | Busca do contrato para validar status | ALTA |
| 406–411 | `SELECT id, numero FROM cabines WHERE contrato_id = $1 LIMIT 1` | Verifica vínculo existente | ALTA |
| 419–424 | `UPDATE cabines SET status = 'reservada', contrato_id = $1, live_atual_id = NULL` | **Write principal do vínculo** | ALTA |
| 430 | `contratoId: contrato_id` em `logCabineEvent` | Auditoria de contrato | MÉDIA |
| 439 | `metadata: { contrato_id, cliente_id }` em `app.audit.log` | Audit log | BAIXA |
| 456–462 | `SELECT id, numero, status, contrato_id, live_atual_id FROM cabines WHERE id = $1 FOR UPDATE` | Liberar endpoint | ALTA |
| 477 | `UPDATE cabines SET status = 'disponivel', contrato_id = NULL` | **Limpa vínculo** | ALTA |
| 483 | `if (cabine.contrato_id \|\| cabine.status !== 'disponivel')` | Condição para logar evento | MÉDIA |
| 487 | `contratoId: cabine.contrato_id` em logCabineEvent | Auditoria | BAIXA |
| 684–686 | `LEFT JOIN cabines c ON c.id = l.cabine_id` + `c.contrato_id` no SELECT live-atual | Retorna contrato_id na resposta da live | MÉDIA |
| 692 | `LEFT JOIN contratos ct ON ct.id = c.contrato_id` | JOIN no live-atual | MÉDIA |
| 731 | `contrato_id: liveData.contrato_id ?? null` | Campo na resposta da live | MÉDIA |
| 868–874 | `SELECT ... contrato_id ...` em `status` endpoint | Guard de manutenção | ALTA |
| 886 | `if (status === 'disponivel' && cabine.contrato_id)` | Guard de status | ALTA |
| 891 | `if (status === 'manutencao' && cabine.contrato_id)` | Guard de status | ALTA |
| 905 | `contratoId: cabine.contrato_id` em logCabineEvent | Auditoria | BAIXA |
| 941–946 | `SELECT id, numero, status, contrato_id, live_atual_id FROM cabines WHERE id = $1 FOR UPDATE` | Iniciar live | ALTA |
| 955 | `let resolvedContratoId = cabine.contrato_id` | Lógica auto-reserve | ALTA |
| 957 | `if (!['reservada', 'ativa'].includes(cabine.status) \|\| !cabine.contrato_id)` | Condição de fluxo | ALTA |
| 983–989 | Busca contrato ativo pelo cliente quando não há contrato vinculado | Auto-reserve logic | ALTA |
| 991–996 | `UPDATE cabines SET status = 'reservada', contrato_id = $1 WHERE id = $2` | Auto-vincula contrato | ALTA |
| 1030 | `await db.query('UPDATE cabines SET contrato_id = $1 WHERE id = $2', ...)` | Atualiza contrato ativo | ALTA |
| 1069–1070 | `contratoId: resolvedContratoId` em logCabineEvent | Auditoria | BAIXA |
| 1116–1119 | `SELECT c.contrato_id, ct.comissao_pct FROM cabines c LEFT JOIN contratos ct ON ct.id = c.contrato_id` | Cálculo de comissão | ALTA (lógica de negócio crítica) |
| 1233–1235 | `SELECT ct.comissao_pct FROM cabines c LEFT JOIN contratos ct ON ct.id = c.contrato_id` | PATCH /lives/:id — comissão | ALTA |
| 1328 | `c.contrato_id` no SELECT de GET /v1/lives | Campo na listagem de lives | MÉDIA |
| 1393 | `SELECT id, contrato_id, status FROM cabines WHERE id = $1 FOR UPDATE` | Encerrar live | ALTA |
| 1401 | `const contratoQ = cabine?.contrato_id ?` | Guard de encerramento | ALTA |
| 1407 | `SELECT ... FROM contratos WHERE id = $1 FOR UPDATE` | Busca contrato no encerramento | ALTA |
| 1480–1491 | `const proximoStatus = contrato?.status === 'ativo' ? 'ativa' : 'disponivel'` + `UPDATE cabines SET contrato_id = $2` | **Lógica crítica: determina status pós-live** | ALTA |

### `src/routes/solicitacoes.js` — **1 ocorrência indireta**

| Linha | Contexto | Tipo | Prioridade |
|---|---|---|---|
| 159 | `UPDATE cabines SET status = 'reservada', contrato_id = $1 WHERE id = $2 AND ... AND status = 'disponivel'` | Aprovação reserva cabine com contrato | ALTA |

### `src/config/role_groups.js` — 0 ocorrências (sem acoplamento)

---

## Migrations relevantes

| Migration | Arquivo | O que faz |
|---|---|---|
| 017 | `017_cabines_reservas_eventos.sql` | **Criou o campo `contrato_id` na tabela `cabines`** — FK para `contratos(id)`, índice e triggers de auto-liberação |
| 017 | `017_cabines_reservas_eventos.sql` | Criou tabela `cabine_eventos` com campo `contrato_id UUID REFERENCES contratos(id)` |
| 016 | `016_auditoria_implantacao.sql` | Criou `contrato_eventos` com `contrato_id UUID NOT NULL REFERENCES contratos(id)` |
| 080 | `080_marcas_agenda_videos_vendas.sql` | Não toca `cabines.contrato_id` diretamente, mas introduz `marcas` e `agenda_eventos` que desacoplam cabines de contratos |

---

## O que já foi removido / desacoplado

Análise das migrations e do código atual:

1. **Migration 080** introduziu `marcas`, `agenda_eventos`, `videos`, `vendas_atribuidas` — novo modelo de dados que **não usa `contrato_id` em cabines**. A agenda opera via `marca_id` e `cabine_id` diretamente.

2. **`agenda.js`** — zero menções a `contrato_id`. O novo módulo de agenda está completamente desacoplado de contratos.

3. **`iniciarLiveSchema` (cabines.js linha 23)** — não exige mais `contrato_id` como campo obrigatório. A lógica foi movida para auto-resolve via `live_requests` e `contratos` buscados por `cliente_id` (lógica complexa nas linhas 955–1045).

4. **`liveManualSchema` (cabines.js linha 38)** — `cliente_id` é obrigatório, `cabine_id` é obrigatório, mas **não há `contrato_id` como campo de entrada**. O contrato é buscado internamente.

---

## O que ainda precisa ser removido

### Prioridade CRÍTICA (bloqueiam o desacoplamento)

1. **`PATCH /v1/cabines/:id/reservar`** — endpoint inteiro depende de `contrato_id` como parâmetro obrigatório. Precisa ser refatorado para receber `cliente_id` diretamente. *(cabines.js:18–19, 352–446)*

2. **`GET /v1/cabines/fila-ativacao`** — lógica baseada em "contratos sem cabine". Precisa de novo conceito: "clientes sem cabine ativa". *(cabines.js:229–259)*

3. **Campo `contrato_id` na tabela `cabines`** — a migration 017 criou este campo como FK. Para o desacoplamento completo, seria necessária uma migration que:
   - Remove `contrato_id` de `cabines`
   - Adiciona `cliente_id` direto em `cabines`
   - Atualiza o índice e triggers

4. **Lógica de comissão no encerramento** (cabines.js:1116–1119, 1233–1235, 1401–1413) — atualmente busca `comissao_pct` via `cabines.contrato_id → contratos`. Precisa ser movida para uma associação direta `cabines → clientes → comissao_pct` ou para uma configuração de taxa por cliente.

5. **Status pós-live** (cabines.js:1480–1491) — `contrato.status === 'ativo' ? 'ativa' : 'disponivel'` determina o status da cabine após encerrar live. Com desacoplamento, esta lógica muda.

### Prioridade ALTA

6. **`cabine_eventos` com `contrato_id`** (migration 017, linha 52) — tabela de auditoria também armazena `contrato_id`. Manter para histórico ou migrar para `cliente_id`.

7. **Resposta da live-atual** (cabines.js:731) — retorna `contrato_id` ao frontend. Se o frontend depende disso, precisa ser atualizado junto.

8. **Listagem `/v1/lives`** (cabines.js:1328) — retorna `c.contrato_id` no JOIN com cabines.

### Prioridade MÉDIA

9. **`logCabineEvent`** helper (cabines.js:109–141) — aceita `contratoId` como parâmetro e grava em `cabine_eventos`. Manter por compatibilidade histórica mas deprecar campo.

10. **Audit logs** com `contrato_id` em metadata — manter para rastreabilidade, não bloqueia desacoplamento funcional.

---

## Sumário de impacto

| Área | Impacto | Arquivos |
|---|---|---|
| API de reserva de cabine | ALTO — endpoint obsoleto | cabines.js |
| API de fila de ativação | ALTO — lógica precisa reescrita | cabines.js |
| Cálculo de comissão | ALTO — depende do contrato | cabines.js |
| Fluxo de iniciar live | ALTO — auto-reserve por contrato | cabines.js |
| Fluxo de encerrar live | ALTO — status pós-live via contrato | cabines.js |
| Solicitações (agendamento) | ALTO — aprova + reserva com contrato | solicitacoes.js |
| Schema banco de dados | ALTO — campo FK na tabela | migration necessária |
| Listagem de cabines | MÉDIO — retorna contrato_id | cabines.js |
| Eventos/auditoria | BAIXO — compatibilidade histórica | cabines.js, migration 017 |
| Frontend | A verificar | domain.ts usa `reservarCabine(id, contratoId)` |
