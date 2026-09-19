# test/webhook_make_crm.test.js

- sign · function · L24-L26 — function sign(body, secret = SECRET)
- signV2 · function · L29-L37 — function signV2(body, { ts, nonce = 'nonce-1234-abcd', secret = SECRET } = {})
- buildApp · function · L39-L58 — async function buildApp({ insertFails = false, replayInserted = 1 } = {})
- post · function · L60-L67 — function post(app, body, headers = {})
