import pg from 'pg'
import 'dotenv/config'
import cron from 'node-cron'
import { buscarOuCriarCustomer, gerarIdempotencyKey, criarCobranca } from '../services/appmax.js'
import { withAdvisoryLock } from './advisory_lock.js'

// Para evitar problemas com timezone ao consultar as lives do banco
// No Node, usaremos a data atual no timezone de SP
function getSPDate() {
  const d = new Date()
  return new Date(d.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
}

// Cria um pool com a pool principal
let dbPool = null

// Advisory lock key — número arbitrário único pro billing engine.
// Usado pra prevenir múltiplas instâncias Railway rodando billing simultaneamente.
const BILLING_ADVISORY_LOCK_KEY = 7421900119911234n

async function processTenantBilling(tenantId, day, spDate) {
  const db = await dbPool.connect()
  try {
    // 1. Obter tenant config (query system-level, sem RLS — tabela tenants
    // não tem tenant_id como filtro RLS; busca por id direto).
    const tenantQ = await db.query(`SELECT gateway_api_key FROM tenants WHERE id = $1`, [tenantId])
    if (!tenantQ.rows[0]?.gateway_api_key) return // Tenant sem gateway de pagamento configurado

    // Ativa RLS para o tenant atual nesta connection. Necessário quando a role
    // do app for NOBYPASSRLS — todas as queries seguintes (lives, contratos,
    // boletos, clientes) ficam confinadas ao tenant_id correto via policy.
    await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId])

    await db.query('BEGIN')

    let inicioPeriodo, fimPeriodo, vencimentoStr, tituloFatura

    const year = spDate.getFullYear()
    const month = spDate.getMonth()

    if (day === 16) {
      // Dia 16: Cobra lives do dia 01 ao 15 (Mês atual)
      inicioPeriodo = new Date(year, month, 1)
      fimPeriodo = new Date(year, month, 15, 23, 59, 59, 999)
      
      // Vencimento dia 20
      const v = new Date(year, month, 20)
      vencimentoStr = v.toISOString().split('T')[0]
      tituloFatura = `Fechamento (1ª Quinzena) - ${month + 1}/${year}`

    } else if (day === 1) {
      // Dia 01: Cobra lives do dia 16 ao último dia do mês anterior, E a mensalidade fixa
      // Como rodou dia 1 de manhã cedo, o mês anterior é month - 1
      const prevMonth = month === 0 ? 11 : month - 1
      const prevYear = month === 0 ? year - 1 : year
      
      inicioPeriodo = new Date(prevYear, prevMonth, 16)
      const lastDay = new Date(year, month, 0) // último dia do mês passado
      fimPeriodo = new Date(prevYear, prevMonth, lastDay.getDate(), 23, 59, 59, 999)
      
      // Vencimento dia 05 do mês atual
      const v = new Date(year, month, 5)
      vencimentoStr = v.toISOString().split('T')[0]
      tituloFatura = `Fechamento (2ª Quinzena + Fixo) - ${prevMonth + 1}/${prevYear}`
    } else {
      await db.query('ROLLBACK')
      return // Não é dia de faturamento
    }

    // Busca lives não faturadas no período (Timezone São Paulo)
    const livesQ = await db.query(`
      SELECT cliente_id, id, comissao_calculada
      FROM lives 
      WHERE tenant_id = $1 
        AND status = 'encerrada' 
        AND faturado_em IS NULL
        AND (encerrado_em AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo') BETWEEN $2 AND $3
    `, [tenantId, inicioPeriodo, fimPeriodo])

    const livesPorCliente = {}
    for (const l of livesQ.rows) {
      if (!livesPorCliente[l.cliente_id]) {
        livesPorCliente[l.cliente_id] = { lives: [], totalComissao: 0, contrato_id: null, totalFixo: 0 }
      }
      livesPorCliente[l.cliente_id].lives.push(l.id)
      livesPorCliente[l.cliente_id].totalComissao += Number(l.comissao_calculada || 0)
    }

    // Se for dia 01, busca os contratos ativos para incluir o valor fixo
    if (day === 1) {
      const contratosQ = await db.query(`
        SELECT cliente_id, id, valor_fixo 
        FROM contratos 
        WHERE tenant_id = $1 AND status = 'ativo'
      `, [tenantId])

      for (const c of contratosQ.rows) {
        if (!livesPorCliente[c.cliente_id]) {
          livesPorCliente[c.cliente_id] = { lives: [], totalComissao: 0, contrato_id: c.id, totalFixo: 0 }
        }
        livesPorCliente[c.cliente_id].contrato_id = c.id
        livesPorCliente[c.cliente_id].totalFixo += Number(c.valor_fixo || 0)
      }
    }

    // Gerar faturas por cliente
    for (const [clienteId, data] of Object.entries(livesPorCliente)) {
      const valorTotal = data.totalComissao + data.totalFixo

      if (valorTotal <= 0) continue // Ignora faturas zeradas (Zero-Boleto Bug)

      // Registra o boleto no nosso banco
      const idempotencyKey = gerarIdempotencyKey(tenantId, clienteId, tituloFatura)
      
      // SAVEPOINT por cliente: se o gateway falhar, desfazemos o boleto deste
      // cliente (sem marcar a live como faturada) para reprocessar no próximo
      // ciclo — em vez de comitar boleto órfão sem URL e travar a receita.
      await db.query('SAVEPOINT cliente_fatura')

      const boletoQ = await db.query(
        `INSERT INTO boletos (tenant_id, cliente_id, contrato_id, tipo, valor, status, vencimento, competencia, gerado_automaticamente, idempotency_key)
         VALUES ($1, $2, $3, 'royalties', $4, 'pendente', $5, CURRENT_DATE, true, $6)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [tenantId, clienteId, data.contrato_id, valorTotal, vencimentoStr, idempotencyKey]
      )

      if (boletoQ.rowCount === 0) {
        await db.query('RELEASE SAVEPOINT cliente_fatura')
        continue // Já existia para essa chave
      }

      const boletoId = boletoQ.rows[0].id

      // Comunicação com o gateway PRIMEIRO. A live só é marcada como faturada
      // e os dados do boleto só são gravados APÓS o gateway confirmar a
      // cobrança — assim uma falha do gateway não trava a receita.
      let payment
      try {
        const clienteQ = await db.query(`SELECT nome, cpf, cnpj, email, celular, gateway_customer_id FROM clientes WHERE id = $1`, [clienteId])
        const cliente = clienteQ.rows[0]
        if (!cliente) {
          // Sem cliente não há como cobrar: desfaz o boleto e segue.
          await db.query('ROLLBACK TO SAVEPOINT cliente_fatura')
          await db.query('RELEASE SAVEPOINT cliente_fatura')
          continue
        }

        let gatewayCustomerId = cliente.gateway_customer_id
        if (!gatewayCustomerId) {
          gatewayCustomerId = await buscarOuCriarCustomer({
            nome: cliente.nome,
            cpfCnpj: cliente.cpf || cliente.cnpj,
            email: cliente.email,
            celular: cliente.celular,
          })
          await db.query(`UPDATE clientes SET gateway_customer_id = $1 WHERE id = $2`, [gatewayCustomerId, clienteId])
        }

        payment = await criarCobranca({
          asaasCustomerId: gatewayCustomerId, // signature legada — primeiro arg é customer id no gateway
          valor: valorTotal,
          vencimento: vencimentoStr,
          descricao: `${tituloFatura} - LiveShop`,
          externalReference: boletoId,
          billingType: 'BOLETO',
          idempotencyKey,
        })
      } catch (err) {
        // Falha ANTES/DURANTE a criação da cobrança: nenhuma cobrança foi
        // concluída, então desfazemos o boleto deste cliente para reprocessar
        // no próximo ciclo (evita boleto sem URL + live travada como faturada).
        await db.query('ROLLBACK TO SAVEPOINT cliente_fatura').catch(() => {})
        await db.query('RELEASE SAVEPOINT cliente_fatura').catch(() => {})
        console.error(`Falha no gateway de pagamento (cliente ${clienteId}):`, err.message)
        continue
      }

      // Gateway confirmou: a cobrança JÁ existe no provedor. A partir daqui
      // NUNCA fazemos rollback (evitaria cobrança órfã/dupla — ver idempotência).
      await db.query(
        `UPDATE boletos SET gateway_id = $1, gateway_url = $2, gateway_pix_copia_cola = $3, gateway_provider = 'appmax' WHERE id = $4`,
        [payment.id, payment.invoiceUrl, payment.pixCopiaECola ?? null, boletoId]
      )
      if (data.lives.length > 0) {
        await db.query(
          `UPDATE lives SET faturado_em = NOW(), boleto_id = $1 WHERE id = ANY($2::uuid[])`,
          [boletoId, data.lives]
        )
      }
      await db.query('RELEASE SAVEPOINT cliente_fatura')
    }

    await db.query('COMMIT')

  } catch (err) {
    // .catch aqui porque o erro que nos trouxe ao catch costuma ser a própria queda da
    // conexão — e aí o ROLLBACK também rejeita. Sem isso, a rejeição do ROLLBACK
    // substitui o erro original, escapa do catch e mata o loop de tenants.
    await db.query('ROLLBACK').catch(() => {})
    console.error(`Erro ao faturar tenant ${tenantId}:`, err)
    throw err // quem chama decide: hoje o loop pula este tenant e segue para o próximo
  } finally {
    db.release()
  }
}

let _billingRunning = false

/**
 * Uma rodada de faturamento. Exportada para poder ser testada sem esperar as 02:00.
 *
 * Um tenant que falha NÃO derruba os seguintes: cada um tem conexão e transação
 * próprias, então pular o que quebrou e seguir é seguro. E é "pular", não "tentar de
 * novo" — repetir faturamento é repetir cobrança. A `UNIQUE` em
 * `boletos.idempotency_key` só protege depois que a linha comitou; logo após um
 * ROLLBACK ela não protege nada, e a chamada ao gateway pode já ter saído.
 *
 * @returns {{rodou: boolean, total: number, falhas: number}}
 */
export async function runBillingTick(pool, { hoje } = {}) {
  const resultado = await withAdvisoryLock(
    pool, BILLING_ADVISORY_LOCK_KEY, '[Billing Engine]', console,
    async () => {
      console.log('[Billing Engine] Iniciando rotina de faturamento...')
      const spDate = hoje ?? getSPDate()
      const day = spDate.getDate()

      // O faturamento só roda se for dia 1 ou 16
      if (day !== 1 && day !== 16) {
        console.log('[Billing Engine] Hoje não é dia de faturamento. Encerrando.')
        return { rodou: false, total: 0, falhas: 0 }
      }

      // Query cross-tenant — não precisa de RLS.
      const res = await pool.query('SELECT id FROM tenants')
      let falhas = 0
      for (const row of res.rows) {
        try {
          await processTenantBilling(row.id, day, spDate)
        } catch {
          // Já logado com o id do tenant dentro de processTenantBilling.
          falhas += 1
        }
      }
      if (falhas > 0) {
        console.error(`[Billing Engine] ${falhas}/${res.rows.length} tenants NÃO faturados — verificar antes do próximo ciclo`)
      } else {
        console.log('[Billing Engine] Rotina finalizada com sucesso.')
      }
      return { rodou: true, total: res.rows.length, falhas }
    },
  )
  // undefined = outra instância segurava o lock.
  return resultado ?? { rodou: false, total: 0, falhas: 0 }
}

export async function startBillingEngine(db) {
  dbPool = db
  console.log('[Billing Engine] Cron configurado para 02:00 AM (SP)')

  cron.schedule('0 2 * * *', async () => {
    if (_billingRunning) {
      console.log('[Billing Engine] Já em execução, pulando.')
      return
    }
    _billingRunning = true
    try {
      await runBillingTick(dbPool)
    } catch (err) {
      // withAdvisoryLock RE-LANÇA o erro de fn (é contrato dele, e o teste depende
      // disso). Sem este catch a rejeição sairia solta do callback do cron e o log
      // contextualizado sumiria.
      console.error('[Billing Engine] Erro geral na rotina:', err)
    } finally {
      // Este finally é o mais externo e só faz atribuição — de propósito. Qualquer
      // chamada capaz de lançar aqui dentro pularia o reset da flag, e _billingRunning
      // preso em true significa faturamento parado em silêncio até o próximo deploy.
      _billingRunning = false
    }
  }, {
    timezone: "America/Sao_Paulo"
  })
}
