# Caixa operacional e vencimentos

Sources:

- Conversation - user decisions on baseline, scope, aggregate cash, overdue treatment, horizon and explicit approval to implement all plan phases A-D.
- `/Users/lucas/Downloads/PLANO-CODEX-CAIXA-E-VENCIMENTOS-2026-10-09.md` - evidence and candidate acceptance cases; the conversation subsequently approved local implementation of phases A-D.
- Backend GitHub tracking ref `93c8d35afa09cd9919295c934f336006625865dd`; frontend ref `d8d78d4d5bf3d0537a5b48fb17e686b0041dd7fa`. The live deployment SHAs remain unverified because network access failed.

## Problem

The existing flow groups obligations into five-day buckets and a separate card bucket, then derives the minimum from the aggregates. This can hide a negative day and place card costs after their real due date. The annual series ends in December, and each month is projected independently. Paid-in-advance titles can therefore appear again in future obligations. The resulting view can misstate cash availability and timing.

Phases A+B establish regression proofs and a read-only backend contract for a continuous six-month projection. The user has since explicitly approved implementation of all plan phases, so C (concentrated interface) and D (incremental financial commands) are now in scope for local code and tests.

## Out of scope

| Excluded | Why |
| --- | --- |
| Production transactions or real payment/reversal/reconciliation execution | Never part of local implementation or test authorization. |
| New ledger, account registry, schema migration, backfill | Reuse canonical movements and the existing aggregate opening/cutoff unless evidence proves it impossible. |
| New commission forecast, commercial formula, tax rule, or aging redesign | No new financial assumptions approved. |
| Push, merge, deploy, production reads/writes | Not authorized. |

## Assumptions

| Assumption | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Cash universe | One aggregate of all available cash; pending processor/card settlement stays separate. | User selected a single aggregate. | y |
| Forecast horizon | Current month plus five following months. | User approved six months. | y |
| Overdue receivables | Visible as pending, excluded from scheduled inflows absent a defensible expected date. | User approved. | y |
| Overdue payables | Residual reduces projected availability as a reserve; no cash movement is fabricated. | User approved. | y |
| Future commissions | Unknown future commissions are marked not estimated, never confirmed zero. | User approved. | y |
| Date and opening convention | São Paulo date; preserve existing cutoff convention (opening before cutoff-day movements); current-day realized events count once. | Existing route and cutoff tests establish this convention; changing it risks double-counting. | n |
| Deployment source | Use the production-designated refs above for local work; compare actual Railway/Vercel deployed SHAs before release. | Network was unavailable, so exact deployed SHA is not proven. | n |

**Open questions:** none for local A-D implementation. Deployment SHA and validity of the current opening/cutoff are go-live evidence checks, not authorization to change real balances.

## Criteria

### S1: Read-only operational forecast contract (P1)

**Acceptance Criteria**

1. WHEN an authorized finance reader requests `GET /v1/financeiro/caixa-operacional` THEN the system SHALL return a data base, current month plus five following months, daily rows, monthly totals and explicit pending groups.
2. IF aggregate opening/cutoff is absent THEN the system SHALL return `caixa.configurado=false` and `caixa.saldo_atual=null`, never a confirmed zero.
3. IF a database read fails THEN the system SHALL return the established API error shape and SHALL NOT substitute zero or DRE values.
4. WHEN the endpoint is requested THEN the system SHALL perform no financial write, payment, reconciliation or materialization.

**Independent test:** route tests exercise authorized response, unconfigured cash, database failure and zero write calls.

### S2: Residual selection and due-date reads (P1)

**Acceptance Criteria**

5. WHEN an obligation has payments, losses, cancellation or suspension THEN the system SHALL project only its eligible residual, with materialized identity taking precedence over its virtual counterpart.
6. WHEN a materialized obligation is due inside the horizon THEN the system SHALL select it by due date without requiring its competence to be in the period.
7. WHEN a canonical cash event is read THEN the system SHALL count it once on its event date, including advances already reflected in the data-base balance.
8. WHEN a canonical movement is dated after the data base THEN the system SHALL exclude it from current cash and project it on its recorded date.
9. WHEN an obligation is overdue at the data base THEN overdue receivables SHALL remain unscheduled and overdue payables SHALL reduce projected availability as an explicit reserve without creating a cash event.
10. WHEN a future commission has no defensible estimate THEN the system SHALL mark it not estimated, not confirmed zero.
11. WHEN totals, due-date list and CSV use the same period and filters THEN the system SHALL use the same obligation identity and exact values in all three outputs.
12. WHEN the payment axis selects a period THEN the system SHALL return `liquidado_no_periodo` from canonical dated events separately from accumulated `valor_pago`.

**Independent test:** service/route tests cover residuals, precedence, due-date selection, overdue rules, movement identity and list/CSV consistency using synthetic fixtures.

### S3: Daily chronology and continuity (P1)

**Acceptance Criteria**

13. WHEN the six-month horizon crosses a month or year boundary THEN each month's projected close SHALL become the next month's projected opening.
14. WHEN cash events are projected THEN the system SHALL order by civil date before any presentation grouping and derive minimum available balance and first negative date from the daily series.
15. WHEN an outgoing card obligation has a due date THEN the system SHALL apply it on that date, not in a separate chronological bucket.
16. WHEN monthly totals are returned THEN they SHALL reconcile to daily rows to the cent.

**Independent test:** pure calculation tests cover early-month shortfall, card date, month/year continuity and daily-to-month reconciliation.

### S4: Tenant and legacy boundaries (P1)

**Acceptance Criteria**

17. WHEN an unauthenticated or unauthorized caller requests a finance route THEN the system SHALL preserve `READ_FINANCEIRO` 401/403 behavior and return no tenant data.
18. WHEN the system assembles one operational response THEN every tenant-scoped source SHALL be read from one repeatable-read snapshot.
19. WHEN a caller uses an existing finance route THEN the system SHALL preserve its response and semantics except the approved additive consultation fields and optional due-date competence bounds.
20. IF canonical payment history is inconsistent or an undated payment prevents an exact balance THEN the system SHALL return HTTP 409 with a reconciliation-required error and SHALL NOT return a confirmed balance.
21. IF tenant history lacks a defensible start, due date, or amount for an old obligation source THEN the system SHALL expose a null-valued pending item or undated obligation, set `historico_obrigacoes_completo=false`, and SHALL NOT represent that source as confirmed zero.
22. WHEN a canonical payment or reversal for an overdue obligation is dated after the data base THEN the system SHALL retain or restore the reserve until that event date, adjust availability on that date, and SHALL NOT use cumulative future payments to reduce current availability.

**Independent test:** route tests cover authorization, tenant/snapshot isolation and the unchanged legacy flow contract.

### S5: Concentrated finance interface (P1)

23. WHEN a user opens Financeiro THEN the system SHALL present Caixa, Vencimentos and Conciliação as the three primary areas, with existing DRE, aging, commissions, closures and other reports preserved under Mais/advanced navigation.
24. WHEN an existing finance URL or alias is opened THEN the system SHALL preserve valid period/filter parameters, route to its existing content and retain current role permissions.
25. WHEN Caixa loads THEN it SHALL consume the operational API, clearly label registered versus projected values and show loading, error, missing configuration and incomplete history as distinct states; it SHALL NOT use DRE as a cash fallback.
26. WHEN the user changes the visible forecast month or period THEN the current cash data-base SHALL remain today in São Paulo and the selected period SHALL remain consistent in drill-downs.
27. WHEN used on desktop or mobile THEN the three areas, daily/monthly projection, pending items and drill-downs SHALL remain usable without hiding incomplete totals as consolidated availability.

**Independent test:** render tests cover navigation, aliases, permission visibility, API states, date-base semantics, drill-down filters and responsive structure.

### S6: Incremental and idempotent money commands (P1)

28. WHEN a caller records a receipt or payment THEN the request SHALL carry the amount of this operation and event date; existing `valor_pago` cumulative clients SHALL retain their prior contract.
29. WHEN the client retries the same operation key and payload THEN the system SHALL return the same liquidation without duplicating it; reusing the key with a different payload SHALL return a conflict.
30. WHEN two operations race on the same obligation THEN the source lock SHALL serialize them and the combined amount SHALL NOT exceed the eligible residual.
31. WHEN the operation is applied THEN the server SHALL update the compatibility projection atomically with the canonical event, tenant and actor; failures SHALL roll back both and invalidate existing caches only after commit.
32. WHEN a user links to an already registered liquidation THEN the system SHALL link it without creating another movement; a genuinely new partial payment SHALL create exactly one new liquidation.
33. WHEN a user enters a partial operation THEN the UI SHALL show operation amount/date, accumulated amount before, remaining residual and the preview; it SHALL clearly report what was applied.
34. WHEN a payment is recorded THEN it SHALL NOT trigger a bank transfer; future event dates SHALL remain future in cash views.

**Independent test:** PGlite tests cover 400+300=700 with 300 residual, replay and payload conflict, concurrent overpayment prevention, rollback, tenant isolation and linking without duplicate movement; UI render tests cover incremental input and success/error states.

## Traceability

| ID | Slice | Criteria | Status |
| --- | --- | --- | --- |
| CAIXA-01 | S1 | 1-4 | Implemented; focused and full backend suite green |
| CAIXA-02 | S2 | 5-12 | Implemented; focused and full backend suite green |
| CAIXA-03 | S3 | 13-16 | Implemented; focused and full backend suite green |
| CAIXA-04 | S4 | 17-22 | Implemented; focused and full backend suite green |
| CAIXA-05 | S5 | 23-27 | Implemented; frontend typecheck, full tests, and build green |
| CAIXA-06 | S6 | 28-34 | Implemented; focused PGlite and UI tests green; full backend suite green |

## Observable

| Surface | Decision | Landing |
| --- | --- | --- |
| API operational cash view | Loading/error response | HTTP status and established API error shape |
| API operational cash view | Missing opening/cutoff | AC 2 |
| API operational cash view | Destructive action | n/a - read-only |
| API due-date consultation | Competence filter optional | AC 6 |
| API payment-axis consultation | Period amount and accumulated amount | AC 12 |
| API CSV consultation | Same selected rows/totals | AC 11 |

Evidence: existing boundary at `src/routes/financeiro.js`; existing calendar flow and selectors in `src/services/financeiro-agregador.js`; canonical event source and command service in `src/services/financeiro-movimentos-periodo.js` and `src/services/financeiro-liquidacoes-command.js`; repeatable-read helper in `src/services/financeiro-read-snapshot.js`; frontend target in `FinanceiroPage.tsx`, `FinanceiroNavigation.tsx` and `LancamentoModals.tsx`.

## Flow

Reuse the aggregate opening/cutoff, canonical movement reader, obligation selectors, tenant auth, cache and repeatable-read snapshot. Do not derive cash from GMV or add a ledger.

1. Request passes existing finance route auth (`READ_FINANCEIRO`).
2. Route resolves São Paulo date and uses the existing tenant read-snapshot/cache path.
3. Existing obligation and canonical movement sources feed a pure daily projection.
4. Projection returns daily/monthly series plus unprogrammed items; request ends without writes.

## Relations

None - no stored-data shape change.

## Surface

| Route | Input | Output | Statuses |
| --- | --- | --- | --- |
| `GET /v1/financeiro/caixa-operacional` | No query | Six-month operational response groups | 200, 401, 403, 409, 5xx |
| `GET /v1/financeiro/consulta` | Existing filters; due-date competence bounds optional | Shared selector; period and accumulated settlement amounts | 200, 400, 401, 403, 409 |
| `GET /v1/financeiro/consulta.csv` | Same filters as JSON | Same selected rows/totals | 200, 400, 401, 403, 409 |
- HTTP 200 response: `{ data_base, horizonte: { inicio, fim, meses: 6 }, caixa: { configurado, saldo_atual, data_corte }, serie_diaria: [{ dia, saldo_inicial, entradas_realizadas, saidas_realizadas, entradas_projetadas, saidas_projetadas, reserva_vencida, saldo_final_projetado, saldo_disponivel_projetado }], meses: [{ mes, saldo_inicial, entradas_realizadas, saidas_realizadas, entradas_projetadas, saidas_projetadas, reserva_vencida, saldo_final_projetado, saldo_disponivel_final, menor_saldo_diario, primeiro_dia_negativo }], pendencias: { recebiveis_vencidos, pagaveis_vencidos, sem_data, comissao_futura: 'nao_estimada' } }`.
- `pendencias.movimentos_futuros` lists dated canonical events after the data base; these are projected on their recorded dates and excluded from current cash.
- Money uses exact decimal strings at cent precision; absent opening/cutoff is `configurado=false`, `saldo_atual=null`.
- HTTP 401/403 follow existing auth behavior; invalid query values remain 400; database failures use established 5xx shapes.
- When presenter history cannot establish a start or fixed obligation, `pendencias.historico` carries a null-valued item and `completude.historico_obrigacoes_completo=false`; no amount is fabricated.

## Landing

| Door | Literal shape | Rejected alternative and why |
| --- | --- | --- |
| Additive API contract | `GET /v1/financeiro/caixa-operacional`, fixed six-month window, groups `caixa`, `serie_diaria`, `meses`, `pendencias`. | Mutate legacy `/fluxo-caixa`: existing consumers depend on annual/bucket output. |
| Persistence | None; current canonical movement and obligation records only. | Account registry/parallel ledger: user chose one aggregate and existing tenant config represents it. |
| Due-date query | `eixo=vencimento` can omit competence bounds; existing explicit bounds remain accepted as an advanced filter. | Keep competence bounds mandatory: a person looking at due dates should not need to know competence. |

## Impact

| Area | Existing meaning | Change |
| --- | --- | --- |
| Legacy `/fluxo-caixa` | Existing grouped annual projection | Preserved; new API is additive. |
| Opening/cutoff | Aggregate tenant balance and cutoff; opening precedes same-day events | Read only; no rebase or cleanup. |
| Payment totals | Title accumulated amount differs from dated cash events | Projection uses canonical dated events; legacy amount semantics stay unchanged. |
| Stored data | Current obligations, losses and movements | No migration, backfill or write. |

## Handoff

- **Boundary:** A-D local implementation and test; no production reads/writes, push, merge or deploy.
- **Settled:** aggregate balance, six-month horizon, overdue treatment and unsupported commission treatment.
- **Abandoned:** none.
