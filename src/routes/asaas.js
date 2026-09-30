// Rotas Asaas — SOMENTE LEITURA do gateway + conciliação local.
//   GET    /v1/asaas/saldo                         saldo atual (ao vivo)
//   GET    /v1/asaas/extrato?inicio&fim[&fonte=cache]  extrato (ao vivo por padrão; cache = gateway_transacoes)
//   POST   /v1/asaas/sincronizar {inicio?, fim?}   baixa extrato + cobranças recebidas → gateway_transacoes
//   GET    /v1/asaas/conciliacao?inicio&fim[&tipo=entrada|saida]  pendentes + sugestões de match
//   POST   /v1/asaas/conciliar {transacao_id, tipo: receita|custo|apresentadora|imposto, id}
//            id = uuid OU id virtual (calc:<marca>:<AAAA-MM>:<fixo|comissao>, rec:<uuid>:<AAAA-MM>,
//            apresentadora:<id>:<AAAA-MM>, imposto:<AAAA-MM>). Vínculo + baixa na MESMA transação.
//   DELETE /v1/asaas/conciliacao/:transacao_id     desfaz o vínculo (e a baixa, se gerada pela conciliação)
//
// Nada aqui cria/altera cobrança no Asaas (o cliente HTTP só expõe GET). A chave vem de
// tenants.gateway_api_key. Conciliação: entradas × títulos de receita (receita_titulos/cálculo
// comercial), saídas × custos. Conciliar também dá baixa no alvo (darBaixaConciliacao).
// Toda query filtra tenant_id explicitamente além do RLS.

import { z } from 'zod'
import { READ_FINANCEIRO, WRITE_FINANCEIRO } from '../config/role_groups.js'
import {
  AsaasError,
  clienteAsaasDoTenant,
  statusHttpParaErroAsaas,
} from '../services/asaas.js'
import {
  ConciliacaoError,
  candidatoDeLancamento,
  darBaixaConciliacao,
  desfazerBaixaConciliacao,
  TIPOS_ALVO,
  dataNoMes,
  normalizarTransacaoAsaas,
  resolverPeriodo,
  somarDias,
  sugerirMatches,
  validarTipoConciliacao,
} from '../services/conciliacao.js'

// Cobranças pagas antes do período podem ser creditadas dentro dele (boleto D+1/D+2):
// ampliamos a busca de /payments para trás ao enriquecer o extrato.
const FOLGA_DIAS_PAGAMENTOS = 10
// Máximo de GET /payments/:id avulsos por sincronização (paymentId fora da janela).
const MAX_PAGAMENTOS_AVULSOS = 50
const LOTE_UPSERT = 500

const hojeISO = () => new Date().toISOString().slice(0, 10)

const periodoQuery = z.object({
  inicio: z.string().optional(),
  fim: z.string().optional(),
})

// Formato genérico 8-4-4-4-12 (o Postgres aceita qualquer hex; z.uuid() do zod 4
// exige versão RFC e rejeitaria ids de seed como 00000000-…-0001).
const uuidGenerico = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

const conciliarSchema = z.object({
  transacao_id: uuidGenerico,
  tipo: z.enum(TIPOS_ALVO),
  // uuid ou id virtual (calc:/rec:/apresentadora:/imposto:) — resolvido em darBaixaConciliacao
  id: z.string().trim().min(1).max(200),
})

// Tabela/coluna do módulo financeiro (migrations 164/165, outras frentes) ainda não aplicada.
const erroSchemaAusente = (err) => err?.code === '42P01' || err?.code === '42703'
const erroModuloAusente = (err) => err?.code === 'ERR_MODULE_NOT_FOUND'

async function tabelaExiste(db, nome) {
  const r = await db.query('SELECT to_regclass($1) IS NOT NULL AS existe', [`public.${nome}`])
  return r.rows[0]?.existe === true
}

// Janela de competência −2/+1 mês em torno do período (comissão de M é recebida em M+1; atrasos).
function janelaCompetencia({ inicio, fim }) {
  const a = Number(inicio.slice(0, 4)) * 12 + Number(inicio.slice(5, 7)) - 1 - 2
  const b = Number(fim.slice(0, 4)) * 12 + Number(fim.slice(5, 7)) - 1 + 1
  const ini = `${Math.floor(a / 12)}-${String((a % 12) + 1).padStart(2, '0')}-01`
  const mesFim = `${Math.floor(b / 12)}-${String((b % 12) + 1).padStart(2, '0')}`
  return { inicio: ini, fim: dataNoMes(mesFim, 31) }
}

// Carrega lançamentos abertos via serviços das frentes A (receitas) e B (custos).
// Import dinâmico + to_regclass: se a frente ainda não existe, degrada com aviso (nunca 500).
async function carregarCandidatos(db, tenantId, tipo, periodo, avisos, log) {
  const janela = janelaCompetencia(periodo)
  const base = { tenantId, inicio: janela.inicio, fim: janela.fim, hoje: hojeISO() }
  try {
    let itens
    if (tipo === 'entrada') {
      if (!(await tabelaExiste(db, 'receita_titulos'))) {
        avisos.push('Receitas ainda não migradas (receita_titulos) — sugestões indisponíveis')
        return []
      }
      const mod = await import('../services/receitas-comercial.js')
      itens = await mod.listarTitulosReceita(db, base)
    } else {
      const mod = await import('../services/custos-plano.js')
      itens = await mod.listarCustos(db, base)
      try {
        const ap = await import('../services/apresentadoras-pagamentos.js')
        itens = [...itens, ...(await ap.listarPagamentosApresentadoras(db, base))]
      } catch (err) {
        if (!erroSchemaAusente(err) && !erroModuloAusente(err)) throw err
        avisos.push('Pagamentos de apresentadoras indisponíveis — sugestões não geradas')
      }
    }
    const abertos = (itens ?? []).filter((l) => l?.id && l.status !== 'pago')
    const clienteIds = [...new Set(abertos.map((l) => l.cliente_id).filter(Boolean))]
    const customers = new Map()
    if (clienteIds.length) {
      const r = await db.query(
        `SELECT id, gateway_customer_id FROM clientes
          WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[]) AND gateway_customer_id IS NOT NULL`,
        [tenantId, clienteIds],
      )
      for (const c of r.rows) customers.set(c.id, c.gateway_customer_id)
    }
    return abertos.map((l) => candidatoDeLancamento(l, customers)).filter(Boolean)
  } catch (err) {
    if (!erroSchemaAusente(err) && !erroModuloAusente(err)) throw err
    log.warn({ code: err.code }, '[asaas] módulo financeiro indisponível — sem sugestões')
    avisos.push(tipo === 'entrada'
      ? 'Módulo de receitas indisponível — sugestões não geradas'
      : 'Módulo de custos indisponível — sugestões não geradas')
    return []
  }
}

function responderErroAsaas(request, reply, err) {
  if (!(err instanceof AsaasError)) throw err
  const status = statusHttpParaErroAsaas(err)
  request.log.warn({ codigo: err.codigo, status_asaas: err.status }, `[asaas] ${err.message}`)
  return reply.code(status).send({ error: err.message, codigo: err.codigo })
}

async function lerPeriodo(request, reply, fonte) {
  const parsed = periodoQuery.safeParse(fonte ?? {})
  if (!parsed.success) {
    reply.code(400).send({ error: 'Parâmetros inválidos' })
    return null
  }
  const p = resolverPeriodo(parsed.data, hojeISO())
  if (p.erro) {
    reply.code(400).send({ error: p.erro })
    return null
  }
  return p
}

export async function asaasRoutes(app) {
  // ─── Saldo ──────────────────────────────────────────────────────────
  app.get('/v1/asaas/saldo', {
    preHandler: [app.authenticate, app.requirePapel(READ_FINANCEIRO)],
  }, async (request, reply) => {
    const { tenant_id } = request.user
    try {
      const cliente = await app.withTenant(tenant_id, (db) => clienteAsaasDoTenant(db, tenant_id))
      const { saldo } = await cliente.saldo()
      return { saldo, consultado_em: new Date().toISOString() }
    } catch (err) {
      return responderErroAsaas(request, reply, err)
    }
  })

  // ─── Extrato ────────────────────────────────────────────────────────
  app.get('/v1/asaas/extrato', {
    preHandler: [app.authenticate, app.requirePapel(READ_FINANCEIRO)],
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const periodo = await lerPeriodo(request, reply, request.query)
    if (!periodo) return reply

    if (request.query?.fonte === 'cache') {
      return app.withTenant(tenant_id, async (db) => {
        const r = await db.query(
          `SELECT id, asaas_id, tipo, tipo_asaas, valor::float AS valor, valor_bruto::float AS valor_bruto,
                  to_char(data, 'YYYY-MM-DD') AS data, descricao, customer_id, payment_id, cliente_id,
                  conciliado_com_tipo, conciliado_com_id, conciliado_em
             FROM gateway_transacoes
            WHERE tenant_id = $1::uuid AND data BETWEEN $2::date AND $3::date
            ORDER BY data, criado_em`,
          [tenant_id, periodo.inicio, periodo.fim],
        )
        return { ...periodo, fonte: 'cache', ...totalizar(r.rows), itens: r.rows }
      })
    }

    try {
      const cliente = await app.withTenant(tenant_id, (db) => clienteAsaasDoTenant(db, tenant_id))
      const brutos = await cliente.extrato(periodo)
      const itens = brutos
        .map((ft) => normalizarTransacaoAsaas(ft))
        .filter(Boolean)
        .map(({ raw, ...resto }) => ({ ...resto, saldo_apos: raw.transacao.balance ?? null }))
      return { ...periodo, fonte: 'asaas', ...totalizar(itens), itens }
    } catch (err) {
      return responderErroAsaas(request, reply, err)
    }
  })

  // ─── Sincronização (Asaas → gateway_transacoes) ────────────────────
  app.post('/v1/asaas/sincronizar', {
    preHandler: [app.authenticate, app.requirePapel(WRITE_FINANCEIRO)],
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const periodo = await lerPeriodo(request, reply, request.body)
    if (!periodo) return reply

    // 1) Rede primeiro (fora de transação de banco)
    let transacoes
    let pagamentosPorId
    try {
      const cliente = await app.withTenant(tenant_id, (db) => clienteAsaasDoTenant(db, tenant_id))
      const [fts, pagamentos] = await Promise.all([
        cliente.extrato(periodo),
        cliente.pagamentosRecebidos({ inicio: somarDias(periodo.inicio, -FOLGA_DIAS_PAGAMENTOS), fim: periodo.fim }),
      ])
      pagamentosPorId = new Map(pagamentos.map((p) => [p.id, p]))

      // paymentId que não veio na janela → busca avulsa (limitada)
      const faltantes = [...new Set(fts.map((f) => f.paymentId).filter((id) => id && !pagamentosPorId.has(id)))]
      for (const id of faltantes.slice(0, MAX_PAGAMENTOS_AVULSOS)) {
        try {
          const p = await cliente.pagamento(id)
          if (p?.id) pagamentosPorId.set(p.id, p)
        } catch (err) {
          if (!(err instanceof AsaasError) || err.codigo === 'CHAVE_INVALIDA') throw err
          request.log.warn({ payment_id: id, codigo: err.codigo }, '[asaas] payment avulso não encontrado')
        }
      }
      transacoes = fts
        .map((ft) => normalizarTransacaoAsaas(ft, ft.paymentId ? pagamentosPorId.get(ft.paymentId) : null))
        .filter(Boolean)
    } catch (err) {
      return responderErroAsaas(request, reply, err)
    }

    // 2) Upsert em lote. Campos de conciliação NUNCA são sobrescritos pela sync.
    const resultado = await app.withTenant(tenant_id, async (db) => {
      await db.query('BEGIN')
      try {
        let inseridas = 0
        let atualizadas = 0
        for (let i = 0; i < transacoes.length; i += LOTE_UPSERT) {
          const lote = transacoes.slice(i, i + LOTE_UPSERT)
          const r = await db.query(
            `INSERT INTO gateway_transacoes
               (tenant_id, provider, asaas_id, tipo, tipo_asaas, valor, valor_bruto, data,
                descricao, customer_id, payment_id, cliente_id, raw, sincronizado_em)
             SELECT $1::uuid, 'asaas', x.asaas_id, x.tipo, x.tipo_asaas, x.valor, x.valor_bruto, x.data,
                    x.descricao, x.customer_id, x.payment_id, cl.id, x.raw, NOW()
               FROM jsonb_to_recordset($2::jsonb) AS x(
                      asaas_id text, tipo text, tipo_asaas text, valor numeric, valor_bruto numeric,
                      data date, descricao text, customer_id text, payment_id text, raw jsonb)
               LEFT JOIN LATERAL (
                 SELECT c.id FROM clientes c
                  WHERE c.tenant_id = $1::uuid
                    AND x.customer_id IS NOT NULL
                    AND c.gateway_customer_id = x.customer_id
                  ORDER BY c.deleted_at NULLS FIRST
                  LIMIT 1
               ) cl ON true
             ON CONFLICT (tenant_id, asaas_id) DO UPDATE SET
               tipo            = EXCLUDED.tipo,
               tipo_asaas      = EXCLUDED.tipo_asaas,
               valor           = EXCLUDED.valor,
               valor_bruto     = EXCLUDED.valor_bruto,
               data            = EXCLUDED.data,
               descricao       = EXCLUDED.descricao,
               customer_id     = COALESCE(EXCLUDED.customer_id, gateway_transacoes.customer_id),
               payment_id      = COALESCE(EXCLUDED.payment_id, gateway_transacoes.payment_id),
               cliente_id      = COALESCE(EXCLUDED.cliente_id, gateway_transacoes.cliente_id),
               raw             = EXCLUDED.raw,
               sincronizado_em = NOW()
             WHERE gateway_transacoes.tenant_id = $1::uuid
             RETURNING (xmax = 0) AS inserida`,
            [tenant_id, JSON.stringify(lote)],
          )
          for (const row of r.rows) row.inserida ? inseridas++ : atualizadas++
        }
        await db.query('COMMIT')
        return { inseridas, atualizadas }
      } catch (err) {
        await db.query('ROLLBACK').catch(() => {})
        throw err
      }
    })

    await app.audit?.log(request, {
      action: 'asaas.sincronizar',
      entity_type: 'gateway_transacoes',
      metadata: { ...periodo, total: transacoes.length, ...resultado },
    })

    return { ...periodo, total: transacoes.length, ...resultado }
  })

  // ─── Conciliação: pendentes + sugestões ─────────────────────────────
  app.get('/v1/asaas/conciliacao', {
    preHandler: [app.authenticate, app.requirePapel(READ_FINANCEIRO)],
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const periodo = await lerPeriodo(request, reply, request.query)
    if (!periodo) return reply
    const tipo = request.query?.tipo ?? 'entrada'
    if (tipo !== 'entrada' && tipo !== 'saida') {
      return reply.code(400).send({ error: 'tipo deve ser entrada ou saida' })
    }

    return app.withTenant(tenant_id, async (db) => {
      const tr = await db.query(
        `SELECT g.id, g.asaas_id, g.tipo, g.tipo_asaas, g.valor::float AS valor,
                g.valor_bruto::float AS valor_bruto, to_char(g.data, 'YYYY-MM-DD') AS data,
                g.descricao, g.customer_id, g.payment_id, g.cliente_id, cl.nome AS cliente_nome
           FROM gateway_transacoes g
           LEFT JOIN clientes cl ON cl.id = g.cliente_id AND cl.tenant_id = $1::uuid
          WHERE g.tenant_id = $1::uuid
            AND g.tipo = $4
            AND g.conciliado_com_id IS NULL
            AND g.data BETWEEN $2::date AND $3::date
          ORDER BY g.data, g.criado_em`,
        [tenant_id, periodo.inicio, periodo.fim, tipo],
      )

      const avisos = []
      const candidatos = await carregarCandidatos(db, tenant_id, tipo, periodo, avisos, request.log)

      const sugestoes = new Map(
        sugerirMatches(tr.rows, candidatos).map((s) => [s.transacao_id, s]),
      )
      const itens = tr.rows.map((t) => ({
        ...t,
        sugestoes: sugestoes.get(t.id)?.sugestoes ?? [],
        ambiguo: sugestoes.get(t.id)?.ambiguo ?? false,
      }))
      return { ...periodo, tipo, total: itens.length, avisos, itens }
    })
  })

  // ─── Conciliar (vincula transação → receita|custo) ──────────────────
  app.post('/v1/asaas/conciliar', {
    preHandler: [app.authenticate, app.requirePapel(WRITE_FINANCEIRO)],
  }, async (request, reply) => {
    const parsed = conciliarSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Dados inválidos', detalhes: parsed.error.issues })
    }
    const { transacao_id, tipo, id } = parsed.data
    const { tenant_id, sub: userId } = request.user

    const out = await app.withTenant(tenant_id, async (db) => {
      await db.query('BEGIN')
      try {
        const t = await db.query(
          `SELECT id, tipo, valor::float AS valor, to_char(data, 'YYYY-MM-DD') AS data, conciliado_com_id
             FROM gateway_transacoes
            WHERE id = $1::uuid AND tenant_id = $2::uuid FOR UPDATE`,
          [transacao_id, tenant_id],
        )
        const tx = t.rows[0]
        if (!tx) return fim(db, 404, { error: 'Transação não encontrada' })
        if (tx.conciliado_com_id) return fim(db, 409, { error: 'Transação já conciliada — desfaça antes de reconciliar' })
        const erroTipo = validarTipoConciliacao(tx.tipo, tipo)
        if (erroTipo) return fim(db, 400, { error: erroTipo })

        // Baixa ANTES do vínculo (precisa do UUID real do alvo, materializado se virtual) — mesma transação.
        let baixa
        try {
          baixa = await darBaixaConciliacao(db, {
            tenantId: tenant_id, transacao: tx, tipo, alvoId: id, userId: userId ?? null,
          })
        } catch (err) {
          if (err instanceof ConciliacaoError) return fim(db, err.status, { error: err.message, codigo: err.codigo })
          if (!erroSchemaAusente(err)) throw err
          return fim(db, 409, { error: 'Módulo financeiro ainda não migrado' })
        }

        const u = await db.query(
          `UPDATE gateway_transacoes
              SET conciliado_com_tipo = $3, conciliado_com_id = $4::uuid,
                  conciliado_em = NOW(), conciliado_por = $5::uuid, conciliado_baixa = $6::boolean
            WHERE id = $1::uuid AND tenant_id = $2::uuid
            RETURNING id, conciliado_com_tipo, conciliado_com_id, conciliado_em, conciliado_baixa`,
          [transacao_id, tenant_id, tipo, baixa.alvo_id, userId ?? null, baixa.aplicada === true],
        )
        await db.query('COMMIT')
        return { status: 200, body: { ...u.rows[0], baixa } }
      } catch (err) {
        await db.query('ROLLBACK').catch(() => {})
        throw err
      }
    })

    if (out.status === 200) {
      await app.audit?.log(request, {
        action: 'asaas.conciliar',
        entity_type: 'gateway_transacoes',
        entity_id: transacao_id,
        metadata: { tipo, alvo_ref: id, alvo_id: out.body.conciliado_com_id, baixa_aplicada: out.body.baixa?.aplicada === true },
      })
    }
    return reply.code(out.status).send(out.body)
  })

  // ─── Desfazer conciliação ───────────────────────────────────────────
  app.delete('/v1/asaas/conciliacao/:transacao_id', {
    preHandler: [app.authenticate, app.requirePapel(WRITE_FINANCEIRO)],
  }, async (request, reply) => {
    const { transacao_id } = request.params
    if (!uuidGenerico.safeParse(transacao_id).success) {
      return reply.code(400).send({ error: 'transacao_id inválido' })
    }
    const { tenant_id } = request.user
    const out = await app.withTenant(tenant_id, async (db) => {
      await db.query('BEGIN')
      try {
        const t = await db.query(
          `SELECT id, conciliado_com_tipo, conciliado_com_id, conciliado_baixa
             FROM gateway_transacoes
            WHERE id = $1::uuid AND tenant_id = $2::uuid FOR UPDATE`,
          [transacao_id, tenant_id],
        )
        const tx = t.rows[0]
        if (!tx) return fim(db, 404, { error: 'Transação não encontrada' })
        // Só desfaz a baixa se foi gerada pela conciliação (nunca uma baixa manual).
        let baixa = { desfeita: false, motivo: 'baixa_nao_gerada_pela_conciliacao' }
        if (tx.conciliado_com_id && tx.conciliado_baixa) {
          baixa = await desfazerBaixaConciliacao(db, {
            tenantId: tenant_id, tipo: tx.conciliado_com_tipo, alvoId: tx.conciliado_com_id,
          })
        }
        await db.query(
          `UPDATE gateway_transacoes
              SET conciliado_com_tipo = NULL, conciliado_com_id = NULL, conciliado_em = NULL,
                  conciliado_por = NULL, conciliado_baixa = FALSE
            WHERE id = $1::uuid AND tenant_id = $2::uuid`,
          [transacao_id, tenant_id],
        )
        await db.query('COMMIT')
        return { status: 200, body: { ok: true, baixa_desfeita: baixa.desfeita === true } }
      } catch (err) {
        await db.query('ROLLBACK').catch(() => {})
        throw err
      }
    })
    if (out.status !== 200) return reply.code(out.status).send(out.body)
    await app.audit?.log(request, {
      action: 'asaas.desconciliar',
      entity_type: 'gateway_transacoes',
      entity_id: transacao_id,
    })
    return out.body
  })
}

// Encerra a transação com ROLLBACK e devolve resposta de erro.
async function fim(db, status, body) {
  await db.query('ROLLBACK')
  return { status, body }
}

function totalizar(itens) {
  let entradas = 0
  let saidas = 0
  for (const i of itens) {
    const c = Math.round(Number(i.valor) * 100)
    if (i.tipo === 'entrada') entradas += c
    else saidas += c
  }
  return { total_entradas: entradas / 100, total_saidas: saidas / 100, liquido: (entradas - saidas) / 100 }
}
