# Caixa operacional checks

Profile: light
Plan: `.specs/features/caixa-operacional/plan.md`

34 checks in 6 slices · 3 one-way doors · 0 open, of which 0 block

## Checks

### S1 - Read-only operational forecast contract

**C1** - Authorized `GET /v1/financeiro/caixa-operacional` returns current month plus five months and the required response groups (CAIXA-01, AC 1)
Proof: `npm test -- test/financeiro_caixa_operacional.test.js -t "horizonte de seis meses"`

**C2** - Missing opening/cutoff returns `configurado=false` and `saldo_atual=null` (CAIXA-01, AC 2)
Proof: `npm test -- test/financeiro_caixa_operacional.test.js -t "não assume zero sem configuração"`

**C3** - Database error preserves the established error shape and has no DRE/zero fallback (CAIXA-01, AC 3)
Proof: `npm test -- test/financeiro_caixa_operacional.test.js -t "propaga indisponibilidade sem fallback"`

**C4** - Read request causes no write or title materialization (CAIXA-01, AC 4)
Proof: `npm test -- test/financeiro_caixa_operacional.test.js -t "é somente leitura"`

### S2 - Residual selection and due-date reads

**C5** - Partial payment, loss, cancellation, suspension and materialized precedence produce only eligible residual (CAIXA-02, AC 5)
Proof: `npm test -- test/financeiro_caixa_operacional.test.js -t "residual e precedência materializada"`

**C6** - Materialized title with prior competence is selected by due date (CAIXA-02, AC 6)
Proof: `npm test -- test/financeiro_consulta.test.js -t "vencimento sem competência no período"`

**C7** - Canonical events and cutoff opening are counted once on their dates (CAIXA-02, AC 7)
Proof: `npm test -- test/financeiro_caixa_operacional.test.js -t "movimento e corte sem duplicação"`

**C8** - Future-dated canonical movement is excluded from current cash and projected on its recorded date (CAIXA-02, AC 8)
Proof: `npm test -- test/financeiro_caixa_operacional.test.js -t "movimento futuro só na data registrada"`

**C9** - Overdue receivable is unscheduled; overdue payable reduces availability as a reserve with no fake movement (CAIXA-02, AC 9)
Proof: `npm test -- test/financeiro_caixa_operacional.test.js -t "reserva vencido sem movimento fictício"`

**C10** - Unsupported future commission is marked `nao_estimada`, never confirmed zero (CAIXA-02, AC 10)
Proof: `npm test -- test/financeiro_caixa_operacional.test.js -t "comissão futura não estimada"`

**C11** - `GET /v1/financeiro/consulta` and `GET /v1/financeiro/consulta.csv` use the same due-date selection, identity and cent-exact total (CAIXA-02, AC 11)
Proof: `npm test -- test/financeiro_consulta.test.js -t "JSON e CSV compartilham seleção por vencimento"`

**C12** - Payment-axis `liquidado_no_periodo` is dated by canonical event while `valor_pago` remains cumulative (CAIXA-02, AC 12)
Proof: `npm test -- test/financeiro_consulta.test.js -t "separa liquidado no período do acumulado"`
Proof: `npm test -- test/financeiro_movimentos_periodo.pglite.test.js -t "liquidações parciais em datas distintas"`

### S3 - Daily chronology and continuity

**C13** - Fixed six-month window crosses December/January (CAIXA-03, AC 13)
Proof: `npm test -- test/financeiro_caixa_operacional.test.js -t "atravessa virada de ano"`

**C14** - Monthly close becomes next opening, including a 1500 close followed by 200 outflow and 1300 close (CAIXA-03, AC 13)
Proof: `npm test -- test/financeiro_caixa_operacional.test.js -t "encadeia fechamento e abertura"`

**C15** - Daily minimum and first negative detect an intra-bucket shortfall (CAIXA-03, AC 14)
Proof: `npm test -- test/financeiro_caixa_operacional.test.js -t "mínimo diário antes de agrupar"`

**C16** - Card expense remains on due date and changes chronological daily balance there (CAIXA-03, AC 15)
Proof: `npm test -- test/financeiro_caixa_operacional.test.js -t "cartão permanece na data de vencimento"`

**C17** - Monthly totals equal their daily rows to the cent (CAIXA-03, AC 16)
Proof: `npm test -- test/financeiro_caixa_operacional.test.js -t "reconcilia totais diários e mensais"`

### S4 - Tenant and legacy boundaries

**C18** - Finance auth failures preserve 401/403 and reveal no tenant rows (CAIXA-04, AC 17)
Proof: `npm test -- test/financeiro_caixa_operacional.test.js -t "preserva autorização financeira"`

**C19** - All projection reads use one tenant-scoped repeatable-read snapshot and cache key (CAIXA-04, AC 18)
Proof: `npm test -- test/financeiro_caixa_operacional.test.js -t "snapshot e cache com escopo de tenant"`

**C20** - Legacy `/fluxo-caixa` remains available with its prior response contract (CAIXA-04, AC 19)
Proof: `npm test -- test/financeiro_caixa_operacional.test.js -t "preserva contrato legado do fluxo"`

**C21** - Undated or inconsistent canonical payment history returns sanitized 409 code/details and never a confirmed balance on JSON and CSV (CAIXA-04, AC 20)
Proof: `npm test -- test/financeiro_consulta.test.js -t "JSON e CSV preservam reconciliação 409"`

**C22** - Unknown historical presenter source remains null and marks history incomplete rather than inventing zero (CAIXA-04, AC 21)
Proof: `npm test -- test/financeiro_caixa_operacional.test.js -t "início histórico desconhecido"`

**C23** - Historical materialized obligations without due dates remain pending; virtual commercial obligations use known contract validity (CAIXA-04, AC 21)
Proof: `npm test -- test/financeiro_caixa_operacional.pglite.test.js -t "materializados antigos sem vencimento"`
Proof: `npm test -- test/financeiro_caixa_operacional.pglite.test.js -t "histórico comercial virtual independe de outras fontes"`

**C24** - Future-dated canonical settlement/reversal changes reserve only on its recorded date, including beyond the horizon (CAIXA-04, AC 22)
Proof: `npm test -- test/financeiro_caixa_operacional.pglite.test.js -t "pagamento futuro"`
Proof: `npm test -- test/financeiro_caixa_operacional.pglite.test.js -t "estorno futuro"`

### S5 - Concentrated finance interface

**C25** - Finance navigation presents Caixa, Vencimentos and Conciliação as primary areas; legacy tabs remain reachable under Mais and aliases preserve valid URL parameters (CAIXA-05, AC 23-24)
Proof: `cd react-app && npm run test -- FinanceiroNavigation`

**C26** - Caixa uses the operational API and distinguishes loading, API error, unconfigured cash and incomplete history; no DRE fallback (CAIXA-05, AC 25)
Proof: `cd react-app && npm run test -- CaixaOperacionalPanel`

**C27** - Current cash data-base remains today while forecast period and drill-down filters follow the user's selection (CAIXA-05, AC 26)
Proof: `cd react-app && npm run test -- CaixaOperacionalPanel`

**C28** - Primary areas, forecast and pending/detail states remain usable on mobile and desktop under existing role permissions (CAIXA-05, AC 27)
Proof: `cd react-app && npm run typecheck && npm run test && npm run build`

### S6 - Incremental and idempotent money commands

**C29** - Incremental operation adds 300 after 400 prior, returns 700 accumulated and 300 remaining; legacy cumulative payload remains unchanged (CAIXA-06, AC 28)
Proof: `npx vitest run test/financeiro_liquidacoes_incrementais.pglite.test.js -t "aplica 300 sobre 400"`

**C30** - Retry with same idempotency key and payload replays; different payload on same key conflicts (CAIXA-06, AC 29)
Proof: `npx vitest run test/financeiro_liquidacoes_incrementais.pglite.test.js -t "replay"`

**C31** - Concurrent partial operations cannot exceed residual; compatibility projection and canonical event roll back atomically on failure (CAIXA-06, AC 30-31)
Proof: `npx vitest run test/financeiro_liquidacoes_incrementais.pglite.test.js -t "concorrentes|rollback"`

**C32** - Existing-liquidation reconciliation link does not create another movement; new partial payment does (CAIXA-06, AC 32)
Proof: `npx vitest run test/financeiro_liquidacoes_incrementais.pglite.test.js -t "vincula|concilia 300"`

**C33** - Incremental form displays operation amount/date, accumulated-before, residual and preview, and reports applied result/error (CAIXA-06, AC 33)
Proof: `cd react-app && npm run test -- LancamentoModals`

**C34** - A recorded payment does not create bank transfer; future-dated command remains future in operational cash (CAIXA-06, AC 34)
Proof: `npx vitest run test/financeiro_liquidacoes_incrementais.pglite.test.js -t "evento futuro"`

## Coverage

| Set (size) | Member -> proof | Unproven |
| --- | --- | --- |
| New operational endpoint statuses (5) | 200 C1 · auth 401 C18 · auth 403 C18 · reconciliation 409 C21 · DB 5xx C3 | - |
| Consultation endpoint statuses (5) | 200 C11-C12 · invalid filter 400 C6 · auth 401 C18 · auth 403 C18 · reconciliation 409 C21 | - |
| CSV endpoint statuses (5) | 200 C11 · invalid filter 400 C6 · auth 401 C18 · auth 403 C18 · reconciliation 409 C21 | - |
| Residual states (5) | partial payment C5 · loss C5 · cancellation C5 · suspension C5 · materialized precedence C5 | - |
| Source/due identity (5) | previous competence due in period C6 · virtual/materialized identity C5 · advance C7 · future dated C8 · legacy event limitation C12 | - |
| Chronological cases (4) | within-bucket early shortfall C15 · card due date C16 · month boundary C13-C14 · year boundary C13 | - |
| Tenant and cache (2) | tenant scope C19 · repeatable-read snapshot C19 | - |
| Read side effects (1) | no write/materialization C4 | - |
| Historical source completeness (1) | unknown presenter start and null amount C22 | - |
| Future settlement timing (3) | within horizon C24 · beyond horizon C24 · reversal reopens reserve C24 | - |
| Primary navigation and aliases (2) | 3-area navigation C25 · preserved legacy URL parameters C25 | - |
| Cash interface states (4) | operational API C26 · loading/error C26 · unconfigured C26 · incomplete C26 | - |
| Responsive and authorization (2) | mobile/desktop C28 · existing finance role C28 | - |
| Incremental commands (6) | 400+300 residual C29 · replay C30 · key conflict C30 · concurrency C31 · rollback C31 · reconcile link C32 | - |
| No external bank action (2) | no transfer C34 · future-dated event C34 | - |
| Legacy interface (1) | `/fluxo-caixa` C20 | - |

- Response/status claims C1-C3 and C18 cross their route boundaries.
- No UI claim exists in phase A+B.

## Swept

- validation: C1 fixed operational route; C6 validates due-date query bounds and optional competence bounds.
- failure modes: C2 unconfigured state; C3 database failure; C6 invalid query.
- idempotency: C1-C24 read paths are read-only; C29-C34 cover incremental command replay, conflicts, and reconciliation links.
- authorization: C18 preserves existing `READ_FINANCEIRO` guard.
- concurrency and ordering: C15-C17 daily date order and totals; C19 repeatable-read snapshot.
- data lifecycle: n/a - no persistence, migration, backfill or retention change.
- external-dependency failure: C3 preserves DB error without a fallback.
- state transitions: C5 residual after payment/loss/cancel/suspend; C9 reserve is removed only when later canonical events/obligation state change.
- observability: n/a - no new logging or metrics requirement was approved; existing error logging remains.

## Verification record

- Frontend: `npm run typecheck`, Vitest (370 suites / 939 tests), `npm run build`, and `git diff --check` passed after C+D integration.
- Backend focused C+D regression: independent rerun of 8 test files / 137 tests passed; implementation run also passed 8 files / 158 tests. PGlite covers projection, incremental settlement, Asaas partial reconciliation, replay after a later settlement, idempotency, concurrency, tenant isolation, and linking an existing liquidation without duplication.
- Backend full suite: `npm test -- --maxWorkers=2` passed with loopback-only sandbox escalation: 214 files passed, 14 skipped; 2029 tests passed, 74 skipped. The previously timing-out PGlite file and CLI file also passed individually (2/2 and 19/19).
- No commit, push, merge, deployment, or external financial transfer was performed.
