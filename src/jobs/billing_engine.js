import pg from 'pg'
import 'dotenv/config'
import cron from 'node-cron'
import { buscarOuCriarCustomer, gerarIdempotencyKey, criarCobranca } from '../services/appmax.js'
import { lockTenantLiveFinance } from '../lib/live-finance-lock.js'
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

/** Totaliza parcelas por marca; cada competência aplica seu próprio tipo OU. */
export function calculateBillingAmount(marcas = []) {
  return marcas.reduce((sum, brand) => {
    const fixed = Number(brand.totalFixo || 0)
    const variable = Number(brand.totalComissao || 0)
    return sum + (brand.tipoCobranca === 'fixo_ou_comissao'
      ? Math.max(fixed, variable)
      : fixed + variable)
  }, 0)
}

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
    await lockTenantLiveFinance(db, tenantId)

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
      
      // A parcela do dia 1 começa no dia 16 para marcas fixo + comissão;
      // marcas OU entram pela janela mensal específica abaixo.
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

    // Lives e vídeos usam a condição vigente na competência do fato gerador.
    const livesQ = await db.query(`
      SELECT l.cliente_id, l.id, l.marca_id,
             CASE WHEN mc.condicao_comissao_autoritativa IS TRUE
                  THEN COALESCE(l.ads_gmv, l.manual_gmv, l.fat_gerado, 0)
                       * COALESCE(mc.comissao_franquia_pct_efetiva, 0) / 100.0
                  ELSE COALESCE(l.comissao_calculada, 0) END AS comissao,
             COALESCE(mc.tipo_cobranca_autoritativo, 'fixo_mais_comissao') AS tipo_cobranca
        FROM lives l
        JOIN marcas m ON m.id = l.marca_id AND m.tenant_id = l.tenant_id
        LEFT JOIN LATERAL (
          SELECT (c.origem <> 'legado_nao_verificado' AND c.comissao_confirmada IS TRUE AND c.fixo_confirmado IS TRUE) AS condicao_comissao_autoritativa,
                 CASE WHEN c.origem <> 'legado_nao_verificado' AND c.comissao_confirmada IS TRUE AND c.fixo_confirmado IS TRUE
                      THEN c.comissao_franquia_pct END AS comissao_franquia_pct_efetiva,
                 CASE WHEN c.origem <> 'legado_nao_verificado'
                            AND c.comissao_confirmada IS TRUE AND c.fixo_confirmado IS TRUE
                      THEN c.tipo_cobranca END AS tipo_cobranca_autoritativo
            FROM marca_condicoes_comerciais c
           WHERE c.tenant_id = l.tenant_id AND c.marca_id = l.marca_id
             AND c.inicio_vigencia <= (l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date
             AND c.cancelled_at IS NULL
           ORDER BY c.inicio_vigencia DESC LIMIT 1
        ) mc ON true
       WHERE l.tenant_id = $1
         AND l.uniao_destino_id IS NULL AND l.uniao_desfeita_em IS NULL
         AND l.status = 'encerrada' AND l.faturado_em IS NULL
         -- Dia 16 fecha a primeira quinzena apenas para cobrança aditiva (+).
         -- Dia 1 fecha todos os tipos: OU precisa voltar ao dia 1 do mês,
         -- enquanto + começa no dia 16 já passado em inicioPeriodo.
         AND ($4::int = 1 OR COALESCE(mc.tipo_cobranca_autoritativo, 'fixo_mais_comissao') <> 'fixo_ou_comissao')
         AND (l.encerrado_em AT TIME ZONE 'America/Sao_Paulo')::date >=
             ($2::date - CASE WHEN $4::int = 1
                                   AND COALESCE(mc.tipo_cobranca_autoritativo, 'fixo_mais_comissao') = 'fixo_ou_comissao'
                              THEN 15 ELSE 0 END)
         AND (l.encerrado_em AT TIME ZONE 'America/Sao_Paulo')::date <= $3::date
       ORDER BY l.id
       FOR UPDATE OF l
    `, [tenantId, inicioPeriodo, fimPeriodo, day])
    const videosQ = await db.query(`
      SELECT m.cliente_id, va.origem_id AS id, va.marca_id,
             CASE WHEN mc.condicao_comissao_autoritativa IS TRUE
                  THEN va.gmv * COALESCE(mc.comissao_franquia_pct_efetiva, 0) / 100.0
                  ELSE va.comissao_franquia END AS comissao,
             COALESCE(mc.tipo_cobranca_autoritativo, 'fixo_mais_comissao') AS tipo_cobranca
        FROM vendas_atribuidas va
        JOIN video_registros vr ON vr.tenant_id = va.tenant_id AND vr.id = va.origem_id
        JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
        LEFT JOIN LATERAL (
          SELECT (c.origem <> 'legado_nao_verificado' AND c.comissao_confirmada IS TRUE AND c.fixo_confirmado IS TRUE) AS condicao_comissao_autoritativa,
                 CASE WHEN c.origem <> 'legado_nao_verificado' AND c.comissao_confirmada IS TRUE AND c.fixo_confirmado IS TRUE
                      THEN c.comissao_franquia_pct END AS comissao_franquia_pct_efetiva,
                 CASE WHEN c.origem <> 'legado_nao_verificado'
                            AND c.comissao_confirmada IS TRUE AND c.fixo_confirmado IS TRUE
                      THEN c.tipo_cobranca END AS tipo_cobranca_autoritativo
            FROM marca_condicoes_comerciais c
           WHERE c.tenant_id = va.tenant_id AND c.marca_id = va.marca_id
             AND c.inicio_vigencia <= va.data AND c.cancelled_at IS NULL
           ORDER BY c.inicio_vigencia DESC LIMIT 1
        ) mc ON true
       WHERE va.tenant_id = $1 AND va.origem = 'video'
         AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') IN ('aprovada', 'fechada')
         -- A mesma janela vale para vídeos, sem marcador de faturamento:
         -- a competência do dia 1 começa em inicioPeriodo para + e volta
         -- quinze dias para OU.
         AND ($4::int = 1 OR COALESCE(mc.tipo_cobranca_autoritativo, 'fixo_mais_comissao') <> 'fixo_ou_comissao')
         AND va.data >= ($2::date - CASE WHEN $4::int = 1
                                              AND COALESCE(mc.tipo_cobranca_autoritativo, 'fixo_mais_comissao') = 'fixo_ou_comissao'
                                         THEN 15 ELSE 0 END)
         AND va.data <= $3::date
       ORDER BY va.origem_id, va.id
       FOR UPDATE OF va
    `, [tenantId, inicioPeriodo, fimPeriodo, day])

    const livesPorCliente = {}
    const ensureClientBrand = (clienteId, marcaId, tipoCobranca) => {
      if (!livesPorCliente[clienteId]) {
        livesPorCliente[clienteId] = { lives: [], contrato_id: null, marcas: {} }
      }
      const key = marcaId ?? `legacy:${clienteId}`
      if (!livesPorCliente[clienteId].marcas[key]) {
        livesPorCliente[clienteId].marcas[key] = {
          totalComissao: 0, totalFixo: 0,
          tipoCobranca: tipoCobranca ?? 'fixo_mais_comissao',
        }
      }
      return livesPorCliente[clienteId].marcas[key]
    }
    for (const row of livesQ.rows) {
      const brand = ensureClientBrand(row.cliente_id, row.marca_id, row.tipo_cobranca)
      brand.totalComissao += Number(row.comissao ?? row.comissao_calculada ?? 0)
      if (row.id) livesPorCliente[row.cliente_id].lives.push(row.id)
    }
    for (const row of videosQ.rows) {
      const brand = ensureClientBrand(row.cliente_id, row.marca_id, row.tipo_cobranca)
      brand.totalComissao += Number(row.comissao ?? row.comissao_calculada ?? 0)
    }

    // O fixo da fatura do dia 1 pertence à competência anterior.
    if (day === 1) {
      const contratosQ = await db.query(`
        SELECT m.cliente_id, m.id AS marca_id,
               COALESCE(mc.fixo_mensal_efetivo, 0) AS valor_fixo,
               COALESCE(mc.tipo_cobranca_autoritativo, 'fixo_mais_comissao') AS tipo_cobranca,
               NULL::uuid AS contrato_id
          FROM marcas m
          LEFT JOIN LATERAL (
            SELECT (c.origem <> 'legado_nao_verificado' AND c.fixo_confirmado IS TRUE AND c.comissao_confirmada IS TRUE) AS condicao_fixo_autoritativa,
                   CASE WHEN c.origem <> 'legado_nao_verificado' AND c.fixo_confirmado IS TRUE AND c.comissao_confirmada IS TRUE
                        THEN c.fixo_mensal END AS fixo_mensal_efetivo,
                   CASE WHEN c.origem <> 'legado_nao_verificado'
                              AND c.comissao_confirmada IS TRUE AND c.fixo_confirmado IS TRUE
                        THEN c.tipo_cobranca END AS tipo_cobranca_autoritativo
              FROM marca_condicoes_comerciais c
             WHERE c.tenant_id = m.tenant_id AND c.marca_id = m.id
               AND c.inicio_vigencia <= date_trunc('month', $2::date)::date
               AND c.cancelled_at IS NULL
             ORDER BY c.inicio_vigencia DESC LIMIT 1
          ) mc ON true
         WHERE m.tenant_id = $1 AND m.status = 'ativa' AND m.cliente_id IS NOT NULL
           AND mc.condicao_fixo_autoritativa IS TRUE
        UNION ALL
        SELECT c.cliente_id, NULL::uuid, c.valor_fixo, 'fixo_mais_comissao', c.id AS contrato_id
          FROM contratos c
         WHERE c.tenant_id = $1 AND c.status = 'ativo'
           AND NOT EXISTS (
             SELECT 1 FROM marcas m
             LEFT JOIN LATERAL (
               SELECT 1 AS authoritative
                 FROM marca_condicoes_comerciais mc
                WHERE mc.tenant_id = m.tenant_id AND mc.marca_id = m.id
                  AND mc.inicio_vigencia <= date_trunc('month', $2::date)::date
                  AND mc.cancelled_at IS NULL AND mc.origem <> 'legado_nao_verificado'
                  AND mc.fixo_confirmado IS TRUE AND mc.comissao_confirmada IS TRUE
                ORDER BY mc.inicio_vigencia DESC LIMIT 1
             ) condition ON true
             WHERE m.tenant_id = c.tenant_id AND m.cliente_id = c.cliente_id
               AND condition.authoritative IS TRUE
           )
      `, [tenantId, inicioPeriodo])
      for (const row of contratosQ.rows) {
        const brand = ensureClientBrand(row.cliente_id, row.marca_id, row.tipo_cobranca)
        brand.totalFixo += Number(row.valor_fixo || 0)
        if (row.contrato_id) livesPorCliente[row.cliente_id].contrato_id = row.contrato_id
      }
    }

    // Gerar faturas por cliente
    for (const [clienteId, data] of Object.entries(livesPorCliente)) {
      const valorTotal = calculateBillingAmount(Object.values(data.marcas))

      if (valorTotal <= 0) continue // Ignora faturas zeradas (Zero-Boleto Bug)

      // Registra o boleto no nosso banco
      const idempotencyKey = gerarIdempotencyKey(tenantId, clienteId, tituloFatura)
      const competencia = `${inicioPeriodo.getFullYear()}-${String(inicioPeriodo.getMonth() + 1).padStart(2, '0')}-01`
      
      // SAVEPOINT por cliente: se o gateway falhar, desfazemos o boleto deste
      // cliente (sem marcar a live como faturada) para reprocessar no próximo
      // ciclo — em vez de comitar boleto órfão sem URL e travar a receita.
      await db.query('SAVEPOINT cliente_fatura')

      const boletoQ = await db.query(
        `INSERT INTO boletos (tenant_id, cliente_id, contrato_id, tipo, valor, status, vencimento, competencia, gerado_automaticamente, idempotency_key)
         VALUES ($1, $2, $3, 'royalties', $4, 'pendente', $5, $6::date, true, $7)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [tenantId, clienteId, data.contrato_id, valorTotal, vencimentoStr, competencia, idempotencyKey]
      )

      let boleto = boletoQ.rows[0]
      if (!boleto) {
        const existingQ = await db.query(
          `SELECT id, gateway_id FROM boletos WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE`,
          [tenantId, idempotencyKey],
        )
        boleto = existingQ.rows[0]
      }
      if (!boleto) {
        await db.query('RELEASE SAVEPOINT cliente_fatura')
        continue // A linha conflitante foi removida antes desta tentativa.
      }

      const boletoId = boleto.id
      let gatewayConfirmed = Boolean(boleto.gateway_id)

      // O boleto já foi inserido (ou encontrado) e precisa sobreviver se uma
      // atualização local falhar depois que o gateway confirmar. Este segundo
      // savepoint é deliberadamente posterior ao INSERT: o savepoint anterior
      // continua reservado para desfazer o boleto quando o gateway falha.
      await db.query('SAVEPOINT boleto_preservado')

      // Comunicação com o gateway PRIMEIRO. A live só é marcada como faturada
      // e os dados do boleto só são gravados APÓS o gateway confirmar a
      // cobrança — assim uma falha do gateway não trava a receita.
      let payment = null
      try {
        if (!gatewayConfirmed) {
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
          gatewayConfirmed = true
        }
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
      try {
        if (payment) {
          await db.query(
            `UPDATE boletos SET gateway_id = $1, gateway_url = $2, gateway_pix_copia_cola = $3, gateway_provider = 'appmax' WHERE id = $4`,
            [payment.id, payment.invoiceUrl, payment.pixCopiaECola ?? null, boletoId]
          )
        }
        if (data.lives.length > 0) {
          await db.query(
            `UPDATE lives SET faturado_em = NOW(), boleto_id = $1 WHERE id = ANY($2::uuid[])`,
            [boletoId, data.lives]
          )
        }
        await db.query('RELEASE SAVEPOINT cliente_fatura')
      } catch (err) {
        // O gateway já confirmou. A falha SQL deixou a transação em 25P02;
        // primeiro voltamos ao savepoint posterior ao INSERT, depois
        // regravamos a confirmação externa e repetimos as marcações locais.
        // Assim o COMMIT é válido e a próxima execução encontra a mesma chave
        // sem chamar o gateway novamente. Se a própria regravação falhar,
        // não há garantia local possível sem uma transação independente: o
        // erro fica explícito para retry/alerta operacional.
        try {
          await db.query('ROLLBACK TO SAVEPOINT boleto_preservado')
          if (payment) {
            await db.query(
              `UPDATE boletos SET gateway_id = $1, gateway_url = $2, gateway_pix_copia_cola = $3, gateway_provider = 'appmax' WHERE id = $4`,
              [payment.id, payment.invoiceUrl, payment.pixCopiaECola ?? null, boletoId]
            )
          }
          if (data.lives.length > 0) {
            await db.query(
              `UPDATE lives SET faturado_em = NOW(), boleto_id = $1 WHERE id = ANY($2::uuid[])`,
              [boletoId, data.lives]
            )
          }
          await db.query('RELEASE SAVEPOINT boleto_preservado')
          await db.query('COMMIT')
        } catch (recoveryErr) {
          await db.query('ROLLBACK').catch(() => {})
          console.error(`Falha ao preservar confirmação local do boleto ${boletoId}:`, recoveryErr.message)
        }
        return
      }
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
