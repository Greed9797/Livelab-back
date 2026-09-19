# src/routes/portal_apresentadora.js

- normalizeSubmissionMetrics · function · L52-L65 — function normalizeSubmissionMetrics(data)
- normalizeOfficialMetrics · function · L67-L81 — function normalizeOfficialMetrics(data)
- ownProfile · function · L83-L93 — function ownProfile(db, tenantId, userId, papel)
- resolveOwnProfile · function · L95-L99 — async function resolveOwnProfile(db, tenantId, userId, papel)
- recordHistory · function · L101-L113 — function recordHistory(db, { tenantId, submissionId, version, action, actorId, motivo = null })
- inSubmissionTransaction · function · L114-L119 — async function inSubmissionTransaction(db, work)
- requirePortalEnabled · function · L121-L124 — async function requirePortalEnabled(request, reply)
- monthOr400 · function · L126-L133 — function monthOr400(query, reply)
- requiresPast · function · L135-L139 — function requiresPast({ iniciado_em, encerrado_em }, now = new Date())
- requiresCurrentPortalMonth · function · L141-L147 — function requiresCurrentPortalMonth({ iniciado_em, encerrado_em }, now = new Date())
- portalApresentadoraRoutes · function · L149-L385 — async function portalApresentadoraRoutes(app)
- requireFreshManager · function · L162-L165 — requireFreshManager = async (request, reply)
