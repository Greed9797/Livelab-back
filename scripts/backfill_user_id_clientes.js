import pg from 'pg'
import 'dotenv/config'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

async function main() {
  const client = await pool.connect()
  try {
    // Pré-check de duplicatas para evitar falha no UNIQUE
    const dup = await client.query(`
      SELECT c.user_id, COUNT(*) as cnt
      FROM clientes c
      WHERE c.user_id IS NOT NULL
      GROUP BY c.user_id
      HAVING COUNT(*) > 1
    `)
    if (dup.rows.length > 0) {
      console.error('❌ Duplicatas encontradas em clientes.user_id — corrigir antes de continuar:')
      console.error(dup.rows)
      process.exit(1)
    }

    // Backfill por email (case-insensitive)
    const result = await client.query(`
      UPDATE clientes c
      SET user_id = u.id
      FROM users u
      WHERE LOWER(TRIM(c.email)) = LOWER(TRIM(u.email))
        AND u.papel = 'cliente_parceiro'
        AND c.tenant_id = u.tenant_id
        AND c.user_id IS NULL
      RETURNING c.id, c.email, u.id AS user_id
    `)
    console.log(`✅ ${result.rows.length} clientes linkados com user_id`)
    if (result.rows.length > 0) {
      result.rows.forEach(r => console.log(`  cliente ${r.id} (${r.email}) → user ${r.user_id}`))
    }

    // Relatório de clientes sem match
    const unmatched = await client.query(`
      SELECT c.id, c.email, c.tenant_id
      FROM clientes c
      WHERE c.user_id IS NULL
        AND c.email IS NOT NULL
      LIMIT 20
    `)
    if (unmatched.rows.length > 0) {
      console.log(`\n⚠️  ${unmatched.rows.length} clientes sem user_id (sem usuário cliente_parceiro correspondente):`)
      unmatched.rows.forEach(r => console.log(`  cliente ${r.id} — ${r.email}`))
    } else {
      console.log('\n✅ Todos os clientes com e-mail têm user_id ou não possuem usuário de portal correspondente')
    }
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch(err => {
  console.error('❌ Erro no backfill:', err.message)
  process.exit(1)
})
