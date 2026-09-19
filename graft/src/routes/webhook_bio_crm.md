# src/routes/webhook_bio_crm.js

- verifySignature · function · L72-L89 — function verifySignature(signedString, signatureHeader, secret)
- resolveSignatureInput · function · L96-L119 — function resolveSignatureInput(headers, rawBody, strictV2)
- pickFirstNonEmpty · function · L121-L132 — function pickFirstNonEmpty(...vals)
- formatLeadFicha · function · L134-L182 — function formatLeadFicha(payload)
- addSection · function · L139-L146 — addSection = (title, entries)
- buildLeadRow · function · L184-L226 — function buildLeadRow(payload, franqueadoraId)
- webhookBioCrmRoutes · function · L228-L378 — async function webhookBioCrmRoutes(app)
- reject · function · L245-L248 — reject = (status, reason)
