// Shadow FIN-03B somente leitura: um retrato REPEATABLE READ por tenant.
// Uso: FIN_TENANT_IDS=uuid[,uuid] TEST_PG_URL=... node scripts/compare-financeiro-legacy.js
// Sem TEST_PG_URL, DATABASE_URL pode ser usada por operador autorizado.
// Exit 0 = todas as obrigações comparadas; 1 = divergência; 2 = configuração/SQL.
import 'dotenv/config'
import pg from 'pg'
import { resolveDbSslConfig } from '../src/utils/db-ssl.js'
import { compararLiquidacoesLegado } from '../src/services/financeiro-liquidacoes-legacy-comparison.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FONTES = [
  ['receita_titulo', 'receita_titulos', ''],
  ['receita_avulsa', 'receitas_avulsas', ''],
  ['custo', 'custos', "AND tipo IS DISTINCT FROM 'imposto'"],
  ['apresentadora_pagamento', 'apresentadora_pagamentos', ''],
  ['imposto', 'custos', "AND tipo = 'imposto'"],
]
const BATCH = 100

const tenantIds = String(process.env.FIN_TENANT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const connectionString = process.env.TEST_PG_URL || process.env.DATABASE_URL
if (!connectionString || !tenantIds.length || tenantIds.some((id) => !UUID.test(id))) {
  console.error('Informe TEST_PG_URL ou DATABASE_URL e FIN_TENANT_IDS com UUIDs válidos.')
  process.exit(2)
}

const db = new pg.Client({ connectionString, ssl: resolveDbSslConfig(connectionString) })
let divergencias = 0
try {
  await db.connect()
  for (const tenantId of tenantIds) {
    await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    try {
      await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId])
      const resumo = []
      for (const [origemTipo, tabela, filtro] of FONTES) {
        // O UNION preserva fatos órfãos do lado canônico para revisão.
        const { rows } = await db.query(`
          SELECT id FROM ${tabela} WHERE tenant_id = $1::uuid ${filtro}
          UNION
          SELECT origem_id AS id FROM financeiro_liquidacoes
           WHERE tenant_id = $1::uuid AND origem_tipo = $2
          ORDER BY id
        `, [tenantId, origemTipo])
        const classificados = { matching: 0, 'legacy-only': 0, 'canonical-only': 0, divergent: 0 }
        for (let offset = 0; offset < rows.length; offset += BATCH) {
          const lote = rows.slice(offset, offset + BATCH).map((row) => row.id)
          const comparados = await compararLiquidacoesLegado(db, { tenantId, origemTipo, origemIds: lote })
          for (const item of comparados) {
            classificados[item.classificacao]++
            if (item.classificacao !== 'matching') {
              divergencias++
              // IDs e valores são evidência local para investigar; nunca enviar este log para serviço externo.
              console.log(JSON.stringify({ tenantId, ...item }))
            }
          }
        }
        resumo.push({ origemTipo, registros: rows.length, ...classificados })
      }
      await db.query('COMMIT')
      console.log(JSON.stringify({ tenantId, resumo }))
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {})
      throw error
    }
  }
} catch (error) {
  console.error(`Comparação falhou: ${error.message}`)
  process.exitCode = 2
} finally {
  await db.end().catch(() => {})
}
if (!process.exitCode && divergencias) process.exitCode = 1
