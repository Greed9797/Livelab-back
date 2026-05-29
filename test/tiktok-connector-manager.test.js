// test/tiktok-connector-manager.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock tiktok-live-connector before importing the manager
vi.mock('tiktok-live-connector', () => ({
  WebcastPushConnection: vi.fn().mockImplementation(function(username) {
    this.username = username
    this.connect = vi.fn().mockResolvedValue(undefined)
    this.disconnect = vi.fn().mockResolvedValue(undefined)
    this.on = vi.fn()
    this.off = vi.fn()
  }),
}))

// Import after mock
const { init, syncLives, stopConnector, has, getEmitter, _resetForTests } =
  await import('../src/services/tiktok-connector-manager.js')

const makeDb = (rows = []) => ({
  query: vi.fn().mockResolvedValue({ rows }),
})

beforeEach(() => {
  _resetForTests()
})

describe('TikTokConnectorManager', () => {
  it('init armazena db e log', () => {
    const db = makeDb()
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    init({ db, log })
    expect(getEmitter()).toBeDefined()
  })

  it('syncLives inicia connector para live ao_vivo sem connector ativo', async () => {
    const liveId = 'live-uuid-1'
    const db = makeDb([
      { id: liveId, tenant_id: 'tenant-1', tiktok_username: 'user_test' },
    ])
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    init({ db, log })

    await syncLives()

    expect(has(liveId)).toBe(true)
  })

  it('syncLives para connector quando live sai do resultado', async () => {
    const liveId = 'live-uuid-2'
    const db = makeDb([
      { id: liveId, tenant_id: 'tenant-1', tiktok_username: 'user_test' },
    ])
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    init({ db, log })

    await syncLives() // Inicia
    expect(has(liveId)).toBe(true)

    // Simular live que sumiu do resultado (encerrada)
    db.query.mockResolvedValue({ rows: [] })
    await syncLives() // Para

    expect(has(liveId)).toBe(false)
  })

  it('syncLives não duplica connectors se já existe', async () => {
    const liveId = 'live-uuid-3'
    const db = makeDb([
      { id: liveId, tenant_id: 'tenant-1', tiktok_username: 'user_test' },
    ])
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    init({ db, log })

    await syncLives()
    await syncLives() // Segunda chamada não deve duplicar

    expect(has(liveId)).toBe(true)
    // Deve ter chamado query para live_products apenas uma vez (no startConnector inicial)
    const callCount = db.query.mock.calls.filter(([sql]) => sql.includes('live_products')).length
    expect(callCount).toBe(1)
  })

  it('getEmitter retorna o mesmo emitter sempre', () => {
    init({ db: makeDb(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } })
    const e1 = getEmitter()
    const e2 = getEmitter()
    expect(e1).toBe(e2)
  })

  it('handler gift acumula diamantes e emite event:liveId', async () => {
    const liveId = 'live-gift-1'
    const db = makeDb([
      { id: liveId, tenant_id: 'tenant-1', tiktok_username: 'user_test' },
    ])
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    init({ db, log })

    await syncLives()

    const receivedEvents = []
    getEmitter().on(`event:${liveId}`, (evt) => receivedEvents.push(evt))

    const { WebcastPushConnection } = await import('tiktok-live-connector')
    const connection = WebcastPushConnection.mock.instances.at(-1)
    const giftCall = connection.on.mock.calls.find(([evt]) => evt === 'gift')
    expect(giftCall).toBeDefined()
    const giftHandler = giftCall[1]

    // Streak em progresso — NÃO deve contar
    giftHandler({
      giftType: 1, repeatEnd: false, repeatCount: 3,
      diamondCount: 10, uniqueId: 'alice', giftName: 'Rose',
    })
    expect(receivedEvents.length).toBe(0)

    // Streak finalizado — conta multiplicado
    giftHandler({
      giftType: 1, repeatEnd: true, repeatCount: 3,
      diamondCount: 10, uniqueId: 'alice', giftName: 'Rose',
    })
    expect(receivedEvents.length).toBe(1)
    expect(receivedEvents[0]).toMatchObject({
      type: 'gift', user: 'alice', giftName: 'Rose', diamonds: 30, repeatCount: 3,
    })

    // Gift único (não-streak) — conta imediato
    giftHandler({
      giftType: 2, diamondCount: 50,
      uniqueId: 'bob', giftName: 'Galaxy',
    })
    expect(receivedEvents.length).toBe(2)
    expect(receivedEvents[1]).toMatchObject({
      type: 'gift', user: 'bob', giftName: 'Galaxy', diamonds: 50,
    })
  })

  it('handler share incrementa shares_count e emite event:liveId', async () => {
    const liveId = 'live-share-1'
    const db = makeDb([
      { id: liveId, tenant_id: 'tenant-1', tiktok_username: 'user_test' },
    ])
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    init({ db, log })

    await syncLives()

    const receivedEvents = []
    getEmitter().on(`event:${liveId}`, (evt) => receivedEvents.push(evt))

    const { WebcastPushConnection } = await import('tiktok-live-connector')
    const connection = WebcastPushConnection.mock.instances.at(-1)
    const shareCall = connection.on.mock.calls.find(([evt]) => evt === 'share')
    expect(shareCall).toBeDefined()
    const shareHandler = shareCall[1]

    shareHandler({ uniqueId: 'carol' })
    shareHandler({ uniqueId: 'dave' })

    expect(receivedEvents.length).toBe(2)
    expect(receivedEvents[0]).toMatchObject({ type: 'share', user: 'carol' })
    expect(receivedEvents[1]).toMatchObject({ type: 'share', user: 'dave' })
  })

  it('handler streamEnd para o connector', async () => {
    const liveId = 'live-end-1'
    const db = makeDb([
      { id: liveId, tenant_id: 'tenant-1', tiktok_username: 'user_test' },
    ])
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    init({ db, log })

    await syncLives()
    expect(has(liveId)).toBe(true)

    const { WebcastPushConnection } = await import('tiktok-live-connector')
    const connection = WebcastPushConnection.mock.instances.at(-1)
    const streamEndCall = connection.on.mock.calls.find(([evt]) => evt === 'streamEnd')
    expect(streamEndCall).toBeDefined()
    const streamEndHandler = streamEndCall[1]

    streamEndHandler()

    // stopConnector é async — aguarda microtasks + pending db.query promises
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    expect(has(liveId)).toBe(false)
  })

  it('handler chat emite event:liveId com comment', async () => {
    const liveId = 'live-chat-1'
    const db = makeDb([
      { id: liveId, tenant_id: 'tenant-1', tiktok_username: 'user_test' },
    ])
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    init({ db, log })

    await syncLives()

    const receivedEvents = []
    getEmitter().on(`event:${liveId}`, (evt) => receivedEvents.push(evt))

    const { WebcastPushConnection } = await import('tiktok-live-connector')
    const connection = WebcastPushConnection.mock.instances.at(-1)
    const chatCall = connection.on.mock.calls.find(([evt]) => evt === 'chat')
    expect(chatCall).toBeDefined()
    const chatHandler = chatCall[1]

    chatHandler({ uniqueId: 'eve', comment: 'adorei a live' })

    // chatHandler é async (via _handleChat.catch), aguarda microtask
    await new Promise(r => setImmediate(r))

    const chatEvt = receivedEvents.find(e => e.type === 'chat')
    expect(chatEvt).toBeDefined()
    expect(chatEvt).toMatchObject({ type: 'chat', user: 'eve', comment: 'adorei a live' })
  })

  it('stopConnector popula final_* em lives', async () => {
    const liveId = 'live-final-1'
    const db = makeDb([
      { id: liveId, tenant_id: 'tenant-1', tiktok_username: 'user_test' },
    ])
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    init({ db, log })

    await syncLives()

    // Mutate state via handlers pra ter valores não-zero pra gravar
    const { WebcastPushConnection } = await import('tiktok-live-connector')
    const connection = WebcastPushConnection.mock.instances.at(-1)
    const roomUserHandler = connection.on.mock.calls.find(([evt]) => evt === 'roomUser')[1]
    const likeHandler = connection.on.mock.calls.find(([evt]) => evt === 'like')[1]

    roomUserHandler({ viewerCount: 100 })
    likeHandler({ likeCount: 5 })

    // Limpa queries feitas no start
    db.query.mockClear()
    db.query.mockResolvedValue({ rows: [] })

    await stopConnector(liveId)

    const updateCall = db.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE lives') && sql.includes('final_peak_viewers')
    )
    expect(updateCall).toBeDefined()
    expect(updateCall[0]).toContain('final_total_likes')
    expect(updateCall[0]).toContain('final_total_comments')
    expect(updateCall[0]).toContain('final_total_shares')
    expect(updateCall[0]).toContain('final_gifts_diamonds')
    expect(updateCall[0]).toContain('final_orders_count')
    // Verifica que passou os valores acumulados (peak = 100, likes = 5)
    expect(updateCall[1]).toEqual([100, 5, expect.any(Number), 0, 0, 0, liveId])
  })

  it('circuit breaker abre após 5 erros e emite health event', async () => {
    const liveId = 'live-cb-1'
    const db = makeDb([
      { id: liveId, tenant_id: 'tenant-1', tiktok_username: 'user_test' },
    ])
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    init({ db, log })

    await syncLives()

    const healthEvents = []
    getEmitter().on(`health:${liveId}`, (evt) => healthEvents.push(evt))

    const { WebcastPushConnection } = await import('tiktok-live-connector')
    const connection = WebcastPushConnection.mock.instances.at(-1)
    const errorCall = connection.on.mock.calls.find(([evt]) => evt === 'error')
    expect(errorCall).toBeDefined()
    const errorHandler = errorCall[1]

    // 4 erros — abaixo do threshold
    for (let i = 0; i < 4; i++) errorHandler(new Error(`err ${i}`))
    expect(healthEvents.length).toBe(0)

    // 5º erro — circuit breaker abre
    errorHandler(new Error('err 5'))

    // Aguarda microtask pro UPDATE lives async
    await new Promise(r => setImmediate(r))

    expect(healthEvents.length).toBe(1)
    expect(healthEvents[0]).toMatchObject({
      type: 'connector_degraded',
      liveId,
      errorCount: 5,
    })

    // UPDATE lives foi chamado com 'degraded'
    const updateCall = db.query.mock.calls.find(([sql, params]) =>
      sql.includes('tiktok_connector_status') &&
      sql.includes("'degraded'") &&
      Array.isArray(params) && params.includes(liveId)
    )
    expect(updateCall).toBeDefined()
  })

  it('_flushToDb persiste gifts_diamonds e shares_count nos snapshots', async () => {
    const liveId = 'live-flush-1'
    const db = makeDb([
      { id: liveId, tenant_id: 'tenant-1', tiktok_username: 'user_test' },
    ])
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    init({ db, log })

    await syncLives()

    // Fire roomUser pra marcar dirty e garantir flush
    const { WebcastPushConnection } = await import('tiktok-live-connector')
    const connection = WebcastPushConnection.mock.instances.at(-1)
    const roomUserHandler = connection.on.mock.calls.find(([evt]) => evt === 'roomUser')[1]
    roomUserHandler({ viewerCount: 42 })

    // Limpa queries do start e força resolved value pra UPDATE lives do stopConnector
    db.query.mockClear()
    db.query.mockResolvedValue({ rows: [] })

    await stopConnector(liveId)

    const insertCall = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO live_snapshots'))
    expect(insertCall).toBeDefined()
    expect(insertCall[0]).toContain('gifts_diamonds')
    expect(insertCall[0]).toContain('shares_count')
  })
})
