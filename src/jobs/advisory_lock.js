// Lock distribuído cross-instância para crons, extraído do padrão já usado em
// billing_engine.js. Necessário porque a flag `_running` em memória só protege
// dentro de um processo: com 2 réplicas Railway (ou deploy sobreposto) cada
// tick roda em dobro.
//
// pg_try_advisory_lock é de SESSÃO: o lock pertence à conexão que o adquiriu.
// Por isso pegamos um client dedicado do pool e liberamos nele mesmo — usar
// pool.query() pegaria conexões diferentes e o unlock viraria no-op.
//
// Chaves em uso (bigint, mantenha distintas):
//   7421900119911234 — billing_engine (inline no próprio arquivo)
//   7421900119911235 — tiktok poll + syncLives (server.js)
//   7421900119911236 — recalcular_comissoes
//   7421900119911237 — encerrar_lives_zumbi
//   7421900119911238 — agenda_autostart

/**
 * Executa `fn` apenas se conseguir o advisory lock. Não bloqueante: se outra
 * instância já segura o lock, loga em debug e retorna undefined.
 *
 * @param {import('pg').Pool} pool
 * @param {bigint} key
 * @param {string} label prefixo de log, ex: '[agenda autostart]'
 * @param {{ debug?: Function, error?: Function }} [log]
 * @param {() => Promise<any>} fn
 */
export async function withAdvisoryLock(pool, key, label, log, fn) {
  const keyStr = key.toString()
  const client = await pool.connect()
  let acquired = false

  try {
    const res = await client.query(
      'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
      [keyStr],
    )
    acquired = res.rows[0]?.acquired === true
    if (!acquired) {
      log?.debug?.(`${label} advisory lock ocupado por outra instância — tick pulado`)
      return undefined
    }
    return await fn()
  } finally {
    let unlockErr
    if (acquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [keyStr])
      } catch (err) {
        unlockErr = err
        log?.error?.({ err }, `${label} falha ao liberar advisory lock`)
      }
    }
    // Se o unlock falhou, a conexão volta pro pool AINDA segurando o lock. Com
    // idleTimeoutMillis de 10min ela sobrevive e o cron nunca mais roda.
    // release(err) destrói a conexão: o Postgres solta o lock ao fim da sessão.
    client.release(unlockErr)
  }
}
