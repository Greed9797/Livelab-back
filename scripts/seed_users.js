import pg from 'pg'
import bcrypt from 'bcrypt'
import 'dotenv/config'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

async function createTestUsers() {
  try {
    // 1. Criar um Tenant de Franqueado
    const tenantQ = await pool.query(`
      INSERT INTO tenants (nome) 
      VALUES ('Franquia Teste Paulista') 
      RETURNING id
    `)
    const franqueadoId = tenantQ.rows[0].id

    const senhaHash = await bcrypt.hash('teste123', 10)

    // 2. Usuário Franqueado
    await pool.query(`
      INSERT INTO users (tenant_id, nome, email, senha_hash, papel) 
      VALUES ($1, 'Admin da Franquia', 'franqueado@liveshop.com', $2, 'franqueado')
      ON CONFLICT (email) DO NOTHING
    `, [franqueadoId, senhaHash])

    // 3. Usuário Cliente Parceiro
    await pool.query(`
      INSERT INTO users (tenant_id, nome, email, senha_hash, papel)
      VALUES ($1, 'Loja Parceira Teste', 'cliente@liveshop.com', $2, 'cliente_parceiro')
      ON CONFLICT (email) DO NOTHING
    `, [franqueadoId, senhaHash])

    // 4. Usuário Franqueador Master
    const senhaAdmin = await bcrypt.hash('admin123', 10)
    await pool.query(`
      INSERT INTO users (tenant_id, nome, email, senha_hash, papel)
      VALUES ($1, 'Admin Master', 'admin@liveshop.com', $2, 'franqueador_master')
      ON CONFLICT (email) DO NOTHING
    `, [franqueadoId, senhaAdmin])

    // 5. Usuário Apresentadora E2E (acesso restrito a /cabines + /manuais)
    await pool.query(`
      INSERT INTO users (tenant_id, nome, email, senha_hash, papel)
      VALUES ($1, 'Apresentadora E2E', 'apresentador@liveshop.com', $2, 'apresentador')
      ON CONFLICT (email) DO NOTHING
    `, [franqueadoId, senhaHash])

    console.log('--- CREDENCIAIS CRIADAS PARA TESTE ---')
    console.log('1. Franqueado (Dashboard Principal, Cabines):')
    console.log('   E-mail: franqueado@liveshop.com')
    console.log('   Senha:  teste123\n')

    console.log('2. Cliente Parceiro (Painel do Cliente):')
    console.log('   E-mail: cliente@liveshop.com')
    console.log('   Senha:  teste123\n')

    console.log('3. Franqueador Master (Painel Master, Auditoria):')
    console.log('   E-mail: admin@liveshop.com')
    console.log('   Senha:  admin123\n')

    console.log('4. Apresentadora (acesso restrito /cabines + /manuais):')
    console.log('   E-mail: apresentador@liveshop.com')
    console.log('   Senha:  teste123')

  } catch (err) {
    console.error('Erro ao criar usuários:', err)
  } finally {
    await pool.end()
  }
}

createTestUsers()