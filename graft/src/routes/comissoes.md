# src/routes/comissoes.js

- comissoesCacheKey · function · L18-L27 — function comissoesCacheKey(tenantId, range, query = {}, extra = {})
- buildComissaoFilters · function · L29-L53 — function buildComissaoFilters(query, tenantId)
- add · function · L32-L35 — add = (sql, value)
- addDays · function · L55-L59 — function addDays(dateString, days)
- performanceRangeFromComissaoQuery · function · L61-L68 — function performanceRangeFromComissaoQuery(query = {})
- csvEscape · function · L70-L75 — function csvEscape(value)
- serializeFaixaDefault · function · L105-L114 — function serializeFaixaDefault(row)
- substituirEscadasNaoPersonalizadas · function · L121-L178 — async function substituirEscadasNaoPersonalizadas(db, tenantId, conjuntoAntigo, conjuntoNovo)
- comissoesRoutes · function · L180-L1072 — async function comissoesRoutes(app)
- dispararRecalculoApresentadoras · function · L833-L846 — function dispararRecalculoApresentadoras(tenantId, apresentadoraIds, mesReferencia)
