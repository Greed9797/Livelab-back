/**
 * Motor de cálculo de comissões — PR 11
 *
 * Regras de negócio:
 *  - comissao_franquia     = MAX(valor_fixo_contrato, gmv * comissao_franquia_pct / 100)
 *  - comissao_franqueadora = MAX(valor_fixo_contrato, gmv * comissao_franqueadora_pct / 100)
 *  - comissao_apresentadora = gmv rateado * percentual da apresentadora
 *  - O percentual da apresentadora vem de presenter-commission.js, que centraliza
 *    faixas, fallback mínimo e override de fim de semana.
 *  - Cada chamada é idempotente — faz upsert em vendas_atribuidas
 *  - status_aprovacao inicial: 'pendente_aprovacao'
 */

import { saoPauloDateInput } from '../lib/timezone.js'
import { NIL_UUID, resolvePresenterCommissionPct } from './presenter-commission.js'
import { calcularComissaoFranquia } from './comissao.js'
import { MARCA_RESOLVE_PREDICATE } from '../lib/marca-sql.js'

/**
 * Calcula e persiste comissões para uma live encerrada.
 *
 * @param {object} db     - conexão pg já configurada com tenant RLS
 * @param {object} opts
 * @param {string} opts.liveId    - UUID da live
 * @param {string} opts.tenantId  - UUID do tenant
 * @param {number} opts.gmv       - GMV final (fat_gerado ou manual_gmv, prioridade de quem chamar)
 * @param {number} [opts.pedidos] - pedidos oficiais da live (atribuídos 100% à apresentadora principal)
 * @returns {Promise<Array>}      - array de vendas_atribuidas upsertadas (uma por apresentadora)
 */
export async function calcularComissoesDaLive(db, { liveId, tenantId, gmv, pedidos }) {
  // 1. Busca dados da live + contrato + marca.
  //    EXTRA-6: resolve a marca por l.marca_id (afiliada/teste tem marca direta e
  //    cliente_id NULL); só cai para cliente_id quando a live não tem marca_id.
  const liveQ = await db.query(
    `SELECT
       l.id,
       l.cliente_id,
       l.marca_id    AS live_marca_id,
       l.apresentador_id,
       l.iniciado_em,
       c.id          AS contrato_id,
       c.comissao_pct,
       m.id          AS marca_id,
       m.comissao_franquia_pct,
       m.comissao_franqueadora_pct,
       m.valor_fixo_minimo
     FROM lives l
     LEFT JOIN cabines cab ON cab.id = l.cabine_id
     LEFT JOIN contratos c  ON c.id = cab.contrato_id AND c.status = 'ativo'
     LEFT JOIN marcas m     ON m.tenant_id = $1::uuid
                            AND ${MARCA_RESOLVE_PREDICATE}
     WHERE l.id = $2 AND l.tenant_id = $1::uuid
     ORDER BY m.criado_em ASC
     LIMIT 1`,
    [tenantId, liveId],
  )
  const live = liveQ.rows[0]
  if (!live) return []
  if (!live.marca_id) {
    // Invariante pós-117: toda live tem marca. Se chegou aqui sem marca, é erro real
    // (não zerar em silêncio) — vira erro observável no log/limite.
    throw new Error(`comissao: live ${liveId} sem marca resolvível (tenant ${tenantId})`)
  }

  const gmvNum = Number(gmv ?? 0)
  const data = saoPauloDateInput(live.iniciado_em ?? new Date())

  // 2. Comissão franquia/franqueadora POR LIVE = gmv * pct (parte variável).
  //    O fixo mensal (marcas.valor_fixo_minimo) NÃO entra aqui: é somado uma vez por
  //    marca/mês ativo na agregação (performance-rollups e financeiro). Fonte ÚNICA via
  //    calcularComissaoFranquia (comissao.js) — mesma regra de lives.comissao_calculada.
  const franquiaPct      = Number(live.comissao_franquia_pct ?? 0)
  const franqueadoraPct  = Number(live.comissao_franqueadora_pct ?? 0)

  const comissaoFranquiaTotal     = calcularComissaoFranquia({ gmv: gmvNum, pct: franquiaPct })
  const comissaoFranqueadoraTotal = calcularComissaoFranquia({ gmv: gmvNum, pct: franqueadoraPct })

  // 3. Resolve apresentadoras da live (principal + live_apresentadoras)
  const apresentadorasQ = await db.query(
    `SELECT DISTINCT ap.id AS apresentadora_id, am.comissao_live_pct, la.percentual_rateio
     FROM (
       -- apresentadora principal (lives.apresentador_id → apresentadoras.user_id)
       SELECT ap2.id, ap2.user_id
       FROM apresentadoras ap2
       WHERE ap2.user_id = $2 AND ap2.tenant_id = $1::uuid
       UNION
       -- apresentadoras secundárias (live_apresentadores legado)
       SELECT ap3.id, ap3.user_id
       FROM live_apresentadores la2
       JOIN apresentadoras ap3 ON ap3.user_id = la2.apresentador_id AND ap3.tenant_id = $1::uuid
       WHERE la2.live_id = $3 AND la2.tenant_id = $1::uuid
       UNION
       -- apresentadoras v2 (live_apresentadoras_v2)
       SELECT lav.apresentadora_id AS id, ap4.user_id
       FROM live_apresentadoras_v2 lav
       JOIN apresentadoras ap4 ON ap4.id = lav.apresentadora_id AND ap4.tenant_id = $1::uuid
       WHERE lav.live_id = $3 AND lav.tenant_id = $1::uuid
     ) ap
     LEFT JOIN apresentadora_marcas am
       ON am.apresentadora_id = ap.id
      AND am.marca_id = $4::uuid
      AND am.tenant_id = $1::uuid
      AND am.ativo = true
     LEFT JOIN live_apresentadoras_v2 la
       ON la.apresentadora_id = ap.id
      AND la.live_id = $3
      AND la.tenant_id = $1::uuid`,
    [tenantId, live.apresentador_id ?? NIL_UUID, liveId, live.marca_id],
  )

  const apresentadoras = apresentadorasQ.rows.filter(r => r.apresentadora_id)

  // 4. Se não há apresentadoras vinculadas, cria um registro "sem apresentadora"
  const linhas = apresentadoras.length > 0
    ? apresentadoras
    : [{ apresentadora_id: null, comissao_live_pct: 0, percentual_rateio: null }]
  const rateiosExplicitados = linhas
    .map((ap) => ap.percentual_rateio)
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map((value) => Number(value) / 100)
    .filter(Number.isFinite)
  const rateioExplicitoTotal = rateiosExplicitados.reduce((sum, value) => sum + value, 0)
  const semRateioExplicito = linhas.filter((ap) => ap.percentual_rateio === null || ap.percentual_rateio === undefined || ap.percentual_rateio === '')
  const rateioPadrao = rateiosExplicitados.length === 0
    ? 1 / Math.max(linhas.length, 1)
    : Math.max(0, 1 - rateioExplicitoTotal) / Math.max(semRateioExplicito.length, 1)

  const resultados = []

  for (const [index, ap] of linhas.entries()) {
    const apresentadoraId = ap.apresentadora_id ?? null
    // P1-1: pedidos reais (antes era literal 0). Atribuídos 100% à apresentadora
    // principal (primeira linha) — evita rateio com arredondamento que não soma o total.
    const pedidosLinha = index === 0 ? Math.round(Number(pedidos ?? 0)) : 0
    const rateio      = ap.percentual_rateio !== null && ap.percentual_rateio !== undefined && ap.percentual_rateio !== ''
      ? Number(ap.percentual_rateio) / 100
      : rateioPadrao
    const gmvRateado  = gmvNum * (Number.isFinite(rateio) ? rateio : 0)
    const apPct       = await resolvePresenterCommissionPct(db, {
      tenantId,
      marcaId: live.marca_id,
      apresentadoraId,
      origem: 'live',
      origemId: liveId,
      data: live.iniciado_em ?? data,
      gmv: gmvRateado,
      fallbackLivePct: ap.comissao_live_pct,
    })
    const comissao_apresentadora = gmvRateado * (apPct / 100)
    const comissao_franquia = comissaoFranquiaTotal * (Number.isFinite(rateio) ? rateio : 0)
    const comissao_franqueadora = comissaoFranqueadoraTotal * (Number.isFinite(rateio) ? rateio : 0)

    // 5. Upsert atômico em vendas_atribuidas — evita race condition entre processos paralelos.
    //    ON CONFLICT usa idx_vendas_atribuidas_origem_unique (tenant_id, origem, origem_id,
    //    COALESCE(apresentadora_id, NIL_UUID)). Registros já aprovados não são recalculados.
    const upsert = await db.query(
      `INSERT INTO vendas_atribuidas
         (tenant_id, origem, origem_id, marca_id, apresentadora_id, data,
          gmv, pedidos, comissao_apresentadora, comissao_franquia, comissao_franqueadora,
          status_aprovacao)
       VALUES ($1,'live',$2,$3,$4,$5,$6,$7,$8,$9,$10,'pendente_aprovacao')
       ON CONFLICT (tenant_id, origem, origem_id, COALESCE(apresentadora_id, '00000000-0000-0000-0000-000000000000'::uuid))
       DO UPDATE SET
           marca_id               = EXCLUDED.marca_id,
           data                   = EXCLUDED.data,
           gmv                    = EXCLUDED.gmv,
           pedidos                = EXCLUDED.pedidos,
           comissao_apresentadora = EXCLUDED.comissao_apresentadora,
           comissao_franquia      = EXCLUDED.comissao_franquia,
           comissao_franqueadora  = EXCLUDED.comissao_franqueadora,
           status_aprovacao       = 'pendente_aprovacao',
           status_motivo          = NULL,
           atualizado_em          = NOW()
       WHERE vendas_atribuidas.status_aprovacao != 'aprovada'
       RETURNING *`,
      [
        tenantId, liveId, live.marca_id, apresentadoraId, data,
        gmvRateado, pedidosLinha, comissao_apresentadora, comissao_franquia, comissao_franqueadora,
      ],
    )

    // Se o UPDATE foi suprimido (registro já aprovado), a query retorna 0 linhas.
    // Nesse caso buscamos o registro existente para retornar ao chamador.
    let row
    if (upsert.rows[0]) {
      row = upsert.rows[0]
    } else {
      const existingQ = await db.query(
        `SELECT * FROM vendas_atribuidas
         WHERE tenant_id = $1::uuid
           AND origem = 'live'
           AND origem_id = $2::uuid
           AND COALESCE(apresentadora_id, $3::uuid) = COALESCE($4::uuid, $3::uuid)
         LIMIT 1`,
        [tenantId, liveId, NIL_UUID, apresentadoraId],
      )
      row = existingQ.rows[0]
    }

    resultados.push(row)
  }

  // S5: comissao_calculada = soma EXATA das linhas persistidas em vendas_atribuidas
  // (comissao_franquia). Garante o invariante lives.comissao_calculada ==
  // SUM(vendas_atribuidas.comissao_franquia) → Financeiro (lê comissao_calculada) ==
  // aba Comissões (lê vendas_atribuidas), independente de rateio/arredondamento.
  const comissaoFranquiaPersistida = resultados.reduce((s, r) => s + Number(r?.comissao_franquia ?? 0), 0)
  await db.query(
    `UPDATE lives SET comissao_calculada = $1 WHERE id = $2 AND tenant_id = $3::uuid`,
    [comissaoFranquiaPersistida, liveId, tenantId],
  )

  return resultados
}
