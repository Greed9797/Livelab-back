import bcrypt from 'bcrypt'

export async function findActiveAccount(db, email) {
  const result = await db.query(`SELECT u.*, t.nome as tenant_nome
       FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE LOWER(u.email) = LOWER($1) AND u.ativo = true
       LIMIT 1`, [email])
  return result.rows[0]
}

export async function authenticateAccount(db, email, senha) {
  const user = await findActiveAccount(db, email)
  if (!user || !await bcrypt.compare(senha, user.senha_hash)) return null
  return user
}
