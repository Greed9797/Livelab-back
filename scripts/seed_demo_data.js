import pg from 'pg'
import bcrypt from 'bcrypt'
import 'dotenv/config'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

async function createDemoData() {
  try {
    console.log('🔄 Iniciando semeadura do ambiente de demonstração...');

    // 1. Pega ou cria o Tenant
    let tenantQ = await pool.query(`SELECT id FROM tenants WHERE nome = 'Franquia Teste Paulista' LIMIT 1`);
    if (tenantQ.rowCount === 0) {
      tenantQ = await pool.query(`INSERT INTO tenants (nome) VALUES ('Franquia Teste Paulista') RETURNING id`);
    }
    const tenantId = tenantQ.rows[0].id;

    // 2. Pega ou cria o Franqueado
    const senhaHash = await bcrypt.hash('teste123', 10);
    const userFranqueadoQ = await pool.query(`
      INSERT INTO users (tenant_id, nome, email, senha_hash, papel) 
      VALUES ($1, 'Admin da Franquia', 'franqueado@liveshop.com', $2, 'franqueado')
      ON CONFLICT (email) DO UPDATE SET nome = EXCLUDED.nome
      RETURNING id
    `, [tenantId, senhaHash]);
    const userId = userFranqueadoQ.rows[0].id;

    // 3. Cria um novo Cliente Parceiro rico em dados
    const emailCliente = 'demo_cliente@liveshop.com';
    let clienteUserQ = await pool.query(`SELECT id FROM users WHERE email = $1`, [emailCliente]);
    if (clienteUserQ.rowCount === 0) {
      clienteUserQ = await pool.query(`
        INSERT INTO users (tenant_id, nome, email, senha_hash, papel) 
        VALUES ($1, 'Loja Fashion Demo', $2, $3, 'cliente_parceiro')
        RETURNING id
      `, [tenantId, emailCliente, senhaHash]);
    }
    
    // Cria a entidade Cliente associada
    let clienteEntityQ = await pool.query(`SELECT id FROM clientes WHERE email = $1`, [emailCliente]);
    if (clienteEntityQ.rowCount === 0) {
      clienteEntityQ = await pool.query(`
        INSERT INTO clientes (tenant_id, nome, email, celular, nicho, status, vende_tiktok) 
        VALUES ($1, 'Loja Fashion Demo (CNPJ)', $2, '11999999999', 'Moda Feminina', 'ativo', true)
        RETURNING id
      `, [tenantId, emailCliente]);
    }
    const clienteId = clienteEntityQ.rows[0].id;

    // 4. Criação do Contrato (Ativo e Pronto)
    let contratoQ = await pool.query(`SELECT id FROM contratos WHERE cliente_id = $1 LIMIT 1`, [clienteId]);
    if (contratoQ.rowCount === 0) {
      contratoQ = await pool.query(`
        INSERT INTO contratos (tenant_id, cliente_id, user_id, status, valor_fixo, comissao_pct, de_risco)
        VALUES ($1, $2, $3, 'ativo', 2990.00, 15.00, false)
        RETURNING id
      `, [tenantId, clienteId, userId]);
    }
    const contratoId = contratoQ.rows[0].id;

    // 5. Associar Contrato à primeira Cabine Disponível
    let cabineQ = await pool.query(`SELECT id FROM cabines WHERE tenant_id = $1 LIMIT 1`, [tenantId]);
    if (cabineQ.rowCount === 0) {
      cabineQ = await pool.query(`
        INSERT INTO cabines (tenant_id, numero, status) VALUES ($1, 1, 'disponivel') RETURNING id
      `, [tenantId]);
    }
    const cabineId = cabineQ.rows[0].id;
    
    await pool.query(`
      UPDATE cabines SET status = 'reservada', contrato_id = $2 WHERE id = $1
    `, [cabineId, contratoId]);
    console.log('✅ Cabine 1 foi reservada com o novo contrato!');

    console.log('\n--- 🎉 DEMO DATA INJETADO COM SUCESSO ---');
    console.log('Para testar a experiência do franqueado:');
    console.log('  Login: franqueado@liveshop.com / teste123');
    console.log('  -> Vá em "Vendas", você verá "Loja Fashion Demo" com contrato ativo.');
    console.log('  -> Vá em "Cabines", você verá a fila de ativação pronta e poderá Iniciar Live.');
    console.log('\nPara testar a experiência do Lojista:');
    console.log('  Login: demo_cliente@liveshop.com / teste123');
    console.log('  -> O Header mostrará "Cliente Parceiro".');
    console.log('  -> Os menus operacionais estarão ocultos.');
    console.log('  -> O sino de notificações funcionará (vazio).');

  } catch (err) {
    console.error('❌ Erro ao injetar demo data:', err);
  } finally {
    await pool.end();
  }
}

createDemoData();
