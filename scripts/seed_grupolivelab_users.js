// One-off seed: cria 3 users de produção (master, franqueado, cliente)
// Uso: set -a; source .env; set +a && node scripts/seed_grupolivelab_users.js
//
// Idempotente: se usuário já existe (mesmo email + tenant), salta.
// Imprime credenciais ao final — copiar e enviar pelo canal seguro.

import pg from 'pg'
import bcrypt from 'bcrypt'
import crypto from 'node:crypto'
import 'dotenv/config'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

function genPassword() {
  // 14 chars: minúsculas + maiúsculas + dígitos + 1 símbolo seguro pra URL
  const alpha = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let pwd = ''
  for (let i = 0; i < 13; i++) {
    pwd += alpha[crypto.randomInt(0, alpha.length)]
  }
  return pwd + '!'
}

async function ensureTenant(name) {
  const found = await pool.query('SELECT id FROM tenants WHERE nome = $1 LIMIT 1', [name])
  if (found.rows.length > 0) return found.rows[0].id
  const created = await pool.query(
    `INSERT INTO tenants (nome, ativo, plano)
     VALUES ($1, true, 'Master')
     RETURNING id`,
    [name]
  )
  return created.rows[0].id
}

async function ensureUser({ tenantId, nome, email, papel, plain }) {
  const exists = await pool.query(
    'SELECT id FROM users WHERE lower(email) = lower($1) AND tenant_id = $2',
    [email, tenantId]
  )
  if (exists.rows.length > 0) {
    return { ...exists.rows[0], created: false, password: null }
  }
  const senhaHash = await bcrypt.hash(plain, 10)
  const inserted = await pool.query(
    `INSERT INTO users (tenant_id, nome, email, senha_hash, papel, ativo, onboarding_completed)
     VALUES ($1, $2, $3, $4, $5, true, true)
     RETURNING id`,
    [tenantId, nome, email, senhaHash, papel]
  )
  return { id: inserted.rows[0].id, created: true, password: plain }
}

async function main() {
  try {
    const masterTenantId = await ensureTenant('Grupo Livelab — Master')
    const franqueadoTenantId = await ensureTenant('Grupo Livelab — Franquia Teste')

    const masterPwd = genPassword()
    const franqueadoPwd = genPassword()
    const clientePwd = genPassword()

    const master = await ensureUser({
      tenantId: masterTenantId,
      nome: 'Grupo Livelab',
      email: 'contato@grupolivelab.com.br',
      papel: 'franqueador_master',
      plain: masterPwd,
    })

    const franqueado = await ensureUser({
      tenantId: franqueadoTenantId,
      nome: 'Franqueado Teste',
      email: 'franqueado.teste@grupolivelab.com.br',
      papel: 'franqueado',
      plain: franqueadoPwd,
    })

    const cliente = await ensureUser({
      tenantId: franqueadoTenantId,
      nome: 'Cliente Teste',
      email: 'cliente.teste@grupolivelab.com.br',
      papel: 'cliente_parceiro',
      plain: clientePwd,
    })

    console.log('\n=== USUÁRIOS GRUPO LIVELAB ===\n')
    console.log('1. Franqueador Master')
    console.log('   Tenant:', masterTenantId)
    console.log('   Email:  contato@grupolivelab.com.br')
    console.log('   Senha: ', master.created ? master.password : '(já existia, senha não alterada)')
    console.log('')
    console.log('2. Franqueado')
    console.log('   Tenant:', franqueadoTenantId)
    console.log('   Email:  franqueado.teste@grupolivelab.com.br')
    console.log('   Senha: ', franqueado.created ? franqueado.password : '(já existia, senha não alterada)')
    console.log('')
    console.log('3. Cliente Parceiro')
    console.log('   Tenant:', franqueadoTenantId)
    console.log('   Email:  cliente.teste@grupolivelab.com.br')
    console.log('   Senha: ', cliente.created ? cliente.password : '(já existia, senha não alterada)')
    console.log('')
  } finally {
    await pool.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
