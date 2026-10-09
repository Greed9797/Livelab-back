/** Drain nested read branches before a caller can roll back/release its client. */
export async function esperarLeiturasFinanceiras(reads) {
  const results = await Promise.allSettled(reads)
  const failure = results.find(result => result.status === 'rejected')
  if (failure) throw failure.reason
  return results.map(result => result.value)
}

/** All totals and their detail see the same tenant connection and DB snapshot. */
export async function lerSnapshotFinanceiro(db, read) {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    const value = await read(db)
    await db.query('COMMIT')
    return value
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  }
}
