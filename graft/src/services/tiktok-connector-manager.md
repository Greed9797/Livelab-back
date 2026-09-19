# src/services/tiktok-connector-manager.js

- getWebcastPushConnection · function · L26-L43 — async function getWebcastPushConnection()
- init · function · L47-L50 — function init({ db, log })
- getEmitter · function · L52-L54 — function getEmitter()
- has · function · L56-L58 — function has(liveId)
- syncLives · function · L65-L101 — async function syncLives()
- stopConnector · function · L106-L148 — async function stopConnector(liveId)
- _resetForTests · function · L151-L161 — function _resetForTests()
- startConnector · function · L165-L375 — async function startConnector(liveId, tenantId, username)
- _flushToDb · function · L377-L416 — async function _flushToDb(liveId, entry)
- _handleChat · function · L418-L452 — async function _handleChat(data, { liveId, tenantId, state, produtos })
