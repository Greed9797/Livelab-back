// src/routes/relatorios.js
// F2 — Exportação de relatórios CSV (financeiro, boletos) e PDF (cliente).
// Rate limit: 10 req/min por rota; cliente_parceiro só vê o próprio cliente.

import {
  READ_FINANCEIRO,
  READ_CLIENTES,
  READ_BOLETOS,
} from '../config/role_groups.js'
import {
  buildFinanceiroCSV,
  buildBoletosCSV,
  buildClientePDFHtml,
} from '../services/reports.js'
import { liveGmvSql } from '../lib/metric-sql.js'

const RATE = { rateLimit: { max: 10, timeWindow: '1 minute' } }

// Aceita "YYYY-MM"; default: mês corrente em America/Sao_Paulo
function parsePeriodo(periodoRaw) {
  const re = /^(\d{4})-(\d{2})$/
  let ano, mes
  if (typeof periodoRaw === 'string' && re.test(periodoRaw)) {
    const m = periodoRaw.match(re)
    ano = Number(m[1])
    mes = Number(m[2])
  } else {
    const now = new Date()
    ano = now.getUTCFullYear()
    mes = now.getUTCMonth() + 1
  }
  if (mes < 1 || mes > 12 || ano < 2000 || ano > 2100) {
    return null
  }
  const startDate = `${ano}-${String(mes).padStart(2, '0')}-01`
  const lastDay = new Date(Date.UTC(ano, mes, 0)).getUTCDate()
  const endDate = `${ano}-${String(mes).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  const periodo = `${ano}-${String(mes).padStart(2, '0')}`
  return { ano, mes, startDate, endDate, periodo }
}

export async function relatoriosRoutes(app) {
  // ─── GET /v1/relatorios/financeiro/csv ───────────────────
  app.get(
    '/v1/relatorios/financeiro/csv',
    {
      preHandler: app.requirePapel(READ_FINANCEIRO),
      config: RATE,
    },
    async (request, reply) => {
      const { tenant_id } = request.user
      const range = parsePeriodo(request.query?.periodo)
      if (!range) return reply.code(400).send({ error: 'Período inválido (use YYYY-MM)' })

      const rows = await app.withTenant(tenant_id, async (db) => {
        const { rows } = await db.query(
          `SELECT
             COALESCE(l.encerrada_em, l.iniciada_em, l.data_inicio)         AS data,
             cl.nome                                                         AS cliente,
             ap.nome                                                         AS apresentador,
             cab.nome                                                        AS cabine,
             ${liveGmvSql('l')}                                               AS gmv,
             COALESCE(l.comissao_calculada, 0)                               AS comissao,
             CASE
               WHEN l.iniciada_em IS NOT NULL AND l.encerrada_em IS NOT NULL
               THEN EXTRACT(EPOCH FROM (l.encerrada_em - l.iniciada_em)) / 60
               ELSE 0
             END                                                              AS duracao_min
           FROM lives l
           LEFT JOIN clientes cl       ON cl.id = l.cliente_id        AND cl.tenant_id  = $1::uuid
           LEFT JOIN apresentadoras ap ON ap.id = l.apresentadora_id  AND ap.tenant_id  = $1::uuid
           LEFT JOIN cabines cab       ON cab.id = l.cabine_id        AND cab.tenant_id = $1::uuid
           WHERE l.tenant_id = $1::uuid
             AND l.status   = 'encerrada'
             AND COALESCE(l.encerrada_em, l.iniciada_em, l.data_inicio)::date BETWEEN $2::date AND $3::date
           ORDER BY data ASC`,
          [tenant_id, range.startDate, range.endDate]
        )
        return rows
      })

      const csv = buildFinanceiroCSV(rows)
      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="financeiro-${range.periodo}.csv"`
        )
      return reply.send(csv)
    }
  )

  // ─── GET /v1/relatorios/boletos/csv ──────────────────────
  app.get(
    '/v1/relatorios/boletos/csv',
    {
      preHandler: app.requirePapel(READ_BOLETOS),
      config: RATE,
    },
    async (request, reply) => {
      const { tenant_id } = request.user
      const statusRaw = String(request.query?.status ?? '').toLowerCase()
      const allowedStatus = new Set(['pendente', 'pago', 'vencido'])
      const status = allowedStatus.has(statusRaw) ? statusRaw : null

      const range = parsePeriodo(request.query?.periodo)
      if (!range) return reply.code(400).send({ error: 'Período inválido (use YYYY-MM)' })

      const rows = await app.withTenant(tenant_id, async (db) => {
        const params = [tenant_id, range.startDate, range.endDate]
        let statusFilter = ''
        if (status === 'vencido') {
          // Vencido = pendente com vencimento < hoje
          statusFilter = `AND b.status = 'pendente' AND b.vencimento < CURRENT_DATE`
        } else if (status) {
          params.push(status)
          statusFilter = `AND b.status = $${params.length}`
        }
        const { rows } = await db.query(
          `SELECT b.id,
                  cl.nome             AS cliente,
                  COALESCE(b.valor, 0) AS valor,
                  b.vencimento,
                  b.status,
                  b.pago_em
           FROM boletos b
           LEFT JOIN clientes cl ON cl.id = b.cliente_id AND cl.tenant_id = $1::uuid
           WHERE b.tenant_id = $1::uuid
             AND b.vencimento::date BETWEEN $2::date AND $3::date
             ${statusFilter}
           ORDER BY b.vencimento ASC`,
          params
        )
        return rows
      })

      const csv = buildBoletosCSV(rows)
      const tag = status ?? 'todos'
      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="boletos-${tag}-${range.periodo}.csv"`
        )
      return reply.send(csv)
    }
  )

  // ─── GET /v1/relatorios/cliente/:clienteId/pdf ───────────
  app.get(
    '/v1/relatorios/cliente/:clienteId/pdf',
    {
      preHandler: app.requirePapel([...READ_CLIENTES, 'cliente_parceiro']),
      config: RATE,
    },
    async (request, reply) => {
      const { tenant_id, papel, sub: userId } = request.user
      const { clienteId } = request.params
      const range = parsePeriodo(request.query?.periodo)
      if (!range) return reply.code(400).send({ error: 'Período inválido (use YYYY-MM)' })

      const result = await app.withTenant(tenant_id, async (db) => {
        // Busca cliente. Para cliente_parceiro, filtra também por user_id.
        const { rows: cliRows } = await db.query(
          `SELECT id, nome, nicho, user_id
           FROM clientes
           WHERE id = $1 AND tenant_id = $2::uuid
           LIMIT 1`,
          [clienteId, tenant_id]
        )
        const cliente = cliRows[0]
        if (!cliente) return { notFound: true }

        if (papel === 'cliente_parceiro' && cliente.user_id !== userId) {
          return { forbidden: true }
        }

        // Resumo + lista de lives no período
        const { rows: liveRows } = await db.query(
          `SELECT
             COALESCE(l.encerrada_em, l.iniciada_em, l.data_inicio)  AS data,
             ap.nome                                                  AS apresentador,
             ${liveGmvSql('l')}                                        AS gmv,
             CASE
               WHEN l.iniciada_em IS NOT NULL AND l.encerrada_em IS NOT NULL
               THEN EXTRACT(EPOCH FROM (l.encerrada_em - l.iniciada_em)) / 60
               ELSE 0
             END                                                       AS duracao_min
           FROM lives l
           LEFT JOIN apresentadoras ap ON ap.id = l.apresentadora_id AND ap.tenant_id = $1::uuid
           WHERE l.tenant_id = $1::uuid
             AND l.cliente_id = $2
             AND l.status = 'encerrada'
             AND COALESCE(l.encerrada_em, l.iniciada_em, l.data_inicio)::date BETWEEN $3::date AND $4::date
           ORDER BY data ASC`,
          [tenant_id, clienteId, range.startDate, range.endDate]
        )

        const livesRealizadas = liveRows.length
        const gmvTotal = liveRows.reduce((acc, r) => acc + Number(r.gmv ?? 0), 0)
        const gmvMedio = livesRealizadas > 0 ? gmvTotal / livesRealizadas : 0
        const horasRealizadas = liveRows.reduce(
          (acc, r) => acc + Number(r.duracao_min ?? 0) / 60,
          0
        )

        // Contrato ativo p/ horas contratadas
        const { rows: contRows } = await db.query(
          `SELECT COALESCE(horas_contratadas, 0) AS horas_contratadas
           FROM contratos
           WHERE cliente_id = $1 AND tenant_id = $2::uuid AND status = 'ativo'
           ORDER BY ativado_em DESC NULLS LAST
           LIMIT 1`,
          [clienteId, tenant_id]
        )
        const horasContratadas = Number(contRows[0]?.horas_contratadas ?? 0)

        // Próximas lives (a partir de hoje, próximas 10)
        // Schema correto: tabela live_requests (renomeada de solicitacoes), coluna data_solicitada
        const { rows: proxRows } = await db.query(
          `SELECT s.data_solicitada AS data_inicio, s.hora_inicio, ap.nome AS apresentador
           FROM live_requests s
           LEFT JOIN apresentadoras ap ON ap.id = s.apresentadora_id AND ap.tenant_id = $1::uuid
           WHERE s.tenant_id = $1::uuid
             AND s.cliente_id = $2
             AND s.data_solicitada >= CURRENT_DATE
             AND s.status = 'aprovada'
           ORDER BY s.data_solicitada ASC, s.hora_inicio ASC
           LIMIT 10`,
          [tenant_id, clienteId]
        ).catch(() => ({ rows: [] }))

        return {
          cliente: { nome: cliente.nome, nicho: cliente.nicho },
          periodo: range.periodo,
          kpis: {
            lives_realizadas: livesRealizadas,
            gmv_total: gmvTotal,
            gmv_medio: gmvMedio,
            horas_realizadas: horasRealizadas,
            horas_contratadas: horasContratadas,
          },
          lives: liveRows,
          proximas_lives: proxRows,
        }
      })

      if (result?.notFound) {
        return reply.code(404).send({ error: 'Cliente não encontrado' })
      }
      if (result?.forbidden) {
        return reply.code(403).send({ error: 'Acesso negado a este cliente' })
      }

      const pdf = await buildClientePDFHtml(result)
      reply
        .header('Content-Type', 'application/pdf')
        .header(
          'Content-Disposition',
          `attachment; filename="cliente-${clienteId}-${range.periodo}.pdf"`
        )
      return reply.send(pdf)
    }
  )
}
