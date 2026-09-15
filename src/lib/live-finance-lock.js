export async function lockTenantLiveFinance(db, tenantId) {
  await db.query(
    `/* live-finance:tenant-lock */
     SELECT pg_advisory_xact_lock(
       hashtextextended('livelab:live-finance:' || $1::text, 0)
     )`,
    [tenantId],
  )
}
