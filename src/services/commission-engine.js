/**
 * Motor de comissões — v2
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

/**
 * Calcula e persiste comissões para uma live encerrada.
 */
export async function calcularComissoesDaLive(db, { liveId, tenantId, gmv }) {
  // 1. Busca dados da live + contrato + marca
  const liveQ = await db.query(
    `SELECT
       l.id,
       l.cliente_id,
       l.apresentador_id,
       l.iniciado_em,
       c.id                    AS contrato_id,
       m.id                    AS marca_id,
       m.tipo                  AS marca_tipo,
       m.comissao_franquia_pct,
       m.comissao_franqueadora_pct,
       m.valor_fixo_minimo
     FROM lives l
     LEFT JOIN cabines cab ON cab.id = l.cabine_id
     LEFT JOIN contratos c  ON c.id = cab.contrato_id AND c.status = 'ativo'
     LEFT JOIN LATERAL (
       SELECT m2.id, m2.comissao_franquia_pct, m2.comissao_franqueadora_pct
       FROM marcas m2
       WHERE m2.tenant_id = $1::uuid
         AND m2.status = 'ativa'
         AND (
           m2.id = l.marca_id
           OR (l.marca_id IS NULL AND m2.cliente_id = l.cliente_id)
         )
       ORDER BY (m2.id = l.marca_id) DESC, m2.criado_em ASC
       LIMIT 1
     ) m ON true
     WHERE l.id = $2 AND l.tenant_id = $1::uuid
     LIMIT 1`,
    [tenantId, liveId],
  )
  const live = liveQ.rows[0]
  if (!live || !live.marca_id) return []

  const gmvNum = Number(gmv ?? 0)
  const data = saoPauloDateInput(live.iniciado_em ?? new Date())

  const [ano, mes] = data.split('-')
  const mesInicio = `${ano}-${mes}-01`
  const mesFim = new Date(Date.UTC(Number(ano), Number(mes), 0)).toISOString().slice(0, 10)

  // 2. Comissão franquia = MAX(marca.valor_fixo_minimo, gmv * pct)
  // Fonte única de verdade: marcas.comissao_franquia_pct e marcas.valor_fixo_minimo.
  // contratos.valor_fixo é usado exclusivamente pelo billing_engine para mensalidade fixa.
  const franquiaPct    = Number(live.comissao_franquia_pct ?? 0)
  const franqueadoraPct = Number(live.comissao_franqueadora_pct ?? 0)
  const valorFixo       = Number(live.valor_fixo_minimo ?? 0)
  const comissaoFranquiaTotal    = Math.max(valorFixo, gmvNum * (franquiaPct / 100))
  const comissaoFranqueadoraTotal = Math.max(valorFixo, gmvNum * (franqueadoraPct / 100))

  // 4. Resolve apresentadoras da live
  const apresentadorasQ = await db.query(
    `SELECT DISTINCT ap.id AS apresentadora_id
     FROM (
       SELECT ap2.id FROM apresentadoras ap2
       WHERE ap2.user_id = $2 AND ap2.tenant_id = $1::uuid
       UNION
       SELECT ap3.id FROM live_apresentadores la2
       JOIN apresentadoras ap3 ON ap3.user_id = la2.apresentador_id AND ap3.tenant_id = $1::uuid
       WHERE la2.live_id = $3 AND la2.tenant_id = $1::uuid
       UNION
       SELECT lav.apresentadora_id FROM live_apresentadoras_v2 lav
       WHERE lav.live_id = $3 AND lav.tenant_id = $1::uuid
     ) ap`,
    [tenantId, live.apresentador_id ?? NIL_UUID, liveId],
  )

  const apresentadoras = apresentadorasQ.rows.filter(r => r.apresentadora_id)
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

  for (const ap of linhas) {
    const apresentadoraId = ap.apresentadora_id ?? null
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

    // 6. Upsert atômico em vendas_atribuidas — evita race condition entre processos paralelos.
    //    ON CONFLICT usa idx_vendas_atribuidas_origem_unique (tenant_id, origem, origem_id,
    //    COALESCE(apresentadora_id, NIL_UUID)). Registros já aprovados não são recalculados.
    const upsert = await db.query(
      `INSERT INTO vendas_atribuidas
         (tenant_id, origem, origem_id, marca_id, apresentadora_id, data,
          gmv, pedidos, comissao_apresentadora, comissao_franquia, comissao_franqueadora,
          status_aprovacao)
       VALUES ($1,'live',$2,$3,$4,$5,$6,$7,$8,$9,$10,'pendente_aprovacao')
       ON CONFLICT (
         tenant_id,
         origem,
         origem_id,
         COALESCE(apresentadora_id, '00000000-0000-0000-0000-000000000000'::uuid)
       )
       DO UPDATE SET
           marca_id               = EXCLUDED.marca_id,
           data                   = EXCLUDED.data,
           gmv                    = EXCLUDED.gmv,
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
        gmvRateado, 0, comissao_apresentadora, comissao_franquia, comissao_franqueadora,
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

  return resultados
}
