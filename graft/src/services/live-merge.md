# src/services/live-merge.js

- LiveMergeError · class · L14-L22 — class LiveMergeError extends Error
- constructor · method · L15-L21 — constructor(message, { code, statusCode = 400, blockers } = {})
- normalizedIds · function · L24-L26 — function normalizedIds(liveIds)
- requestHash · function · L28-L35 — function requestHash({ liveIds, previewToken, motivo, metricasPorTrecho })
- jsonParam · function · L37-L39 — function jsonParam(value)
- safeRollback · function · L41-L43 — async function safeRollback(db)
- loadLiveMergeSources · function · L45-L128 — async function loadLiveMergeSources(db, { tenantId, liveIds, lock = false })
- readPreview · function · L130-L134 — async function readPreview(db, { tenantId, liveIds, lock = false })
- previewLiveMerge · function · L136-L146 — async function previewLiveMerge(db, { tenantId, liveIds })
- sourceSnapshots · function · L148-L154 — function sourceSnapshots(sources)
- choosePrincipal · function · L156-L162 — function choosePrincipal(presenters)
- financialFingerprint · function · L164-L196 — function financialFingerprint({ live, sales })
- mergeLives · function · L198-L410 — async function mergeLives(db, { tenantId, userId, liveIds, previewToken, requestId, motivo, metricasPorTrecho, uuidFactory = randomUUID, })
- getLiveMergeHistory · function · L412-L436 — async function getLiveMergeHistory(db, { tenantId, liveId })
- loadUnionForUndo · function · L438-L445 — async function loadUnionForUndo(db, { tenantId, unionId })
- undoLiveMerge · function · L447-L578 — async function undoLiveMerge(db, { tenantId, userId, unionId, requestId, motivo, })
