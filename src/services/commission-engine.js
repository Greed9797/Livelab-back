/**
 * Motor de cálculo de comissões — PR 11
 *
 * Regras de negócio:
 *  - comissao_franquia     = MAX(valor_fixo_contrato, gmv * comissao_franquia_pct / 100)
 *  - comissao_franqueadora = MAX(valor_fixo_contrato, gmv * comissao_franqueadora_pct / 100)
 *  - comissao_apresentadora = gmv * comissao_live_pct / 100 (por apresentadora vinculada à marca)
 *  - Cada chamada é idempotente — faz upsert em vendas_atribuidas
 *  - status_aprovacao inicial: 'pendente_aprovacao'
 */

const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/**
 * Calcula e persiste comissões para uma live encerrada.
 *
 * @param {object} db     - conexão pg já configurada com tenant RLS
 * @param {object} opts
 * @param {string} opts.liveId    - UUID da live
 * @param {string} opts.tenantId  - UUID do tenant
 * @param {number} opts.gmv       - GMV final (fat_gerado ou manual_gmv, prioridade de quem chamar)
 * @returns {Promise<Array>}      - array de vendas_atribuidas upsertadas (uma por apresentadora)
 */
export async function calcularComissoesDaLive(db, { liveId, tenantId, gmv }) {
  // 1. Busca dados da live + contrato + marca
  const liveQ = await db.query(
    `SELECT
       l.id,
       l.cliente_id,
       l.apresentador_id,
       l.iniciado_em,
       c.id          AS contrato_id,
       c.comissao_pct,
       c.valor_fixo_comissao,
       m.id          AS marca_id,
       m.comissao_franquia_pct,
       m.comissao_franqueadora_pct
     FROM lives l
     LEFT JOIN cabines cab ON cab.id = l.cabine_id
     LEFT JOIN contratos c  ON c.id = cab.contrato_id AND c.status = 'ativo'
     LEFT JOIN marcas m     ON m.tenant_id = $1::uuid
                            AND m.cliente_id = l.cliente_id
                            AND m.status = 'ativa'
     WHERE l.id = $2 AND l.tenant_id = $1::uuid
     ORDER BY m.criado_em ASC
     LIMIT 1`,
    [tenantId, liveId],
  )
  const live = liveQ.rows[0]
  if (!live || !live.marca_id) return []

  const gmvNum = Number(gmv ?? 0)
  const data = live.iniciado_em
    ? new Date(live.iniciado_em).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10)

  // 2. Comissão franquia = MAX(valor_fixo, gmv * pct)
  const franquiaPct      = Number(live.comissao_franquia_pct ?? 0)
  const franqueadoraPct  = Number(live.comissao_franqueadora_pct ?? 0)
  const valorFixo        = Number(live.valor_fixo_comissao ?? 0)

  const comissao_franquia    = Math.max(valorFixo, gmvNum * (franquiaPct / 100))
  const comissao_franqueadora = Math.max(valorFixo, gmvNum * (franqueadoraPct / 100))

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

  const resultados = []

  for (const ap of linhas) {
    const apPct       = Number(ap.comissao_live_pct ?? 0)
    const rateio      = ap.percentual_rateio !== null ? Number(ap.percentual_rateio) / 100 : 1
    const gmvRateado  = gmvNum * rateio
    const comissao_apresentadora = gmvRateado * (apPct / 100)

    // 5. Upsert em vendas_atribuidas com status pendente_aprovacao
    const apresentadoraId = ap.apresentadora_id ?? null
    const existing = await db.query(
      `SELECT id, status_aprovacao
       FROM vendas_atribuidas
       WHERE tenant_id = $1::uuid
         AND origem = 'live'
         AND origem_id = $2::uuid
         AND COALESCE(apresentadora_id, $3::uuid) = COALESCE($4::uuid, $3::uuid)
       LIMIT 1`,
      [tenantId, liveId, NIL_UUID, apresentadoraId],
    )

    let row
    if (existing.rows[0]) {
      // Não recalcula comissões já aprovadas — apenas atualiza valores pendentes/reprovados
      const jaAprovada = existing.rows[0].status_aprovacao === 'aprovada'
      if (jaAprovada) {
        resultados.push(existing.rows[0])
        continue
      }

      const upd = await db.query(
        `UPDATE vendas_atribuidas
         SET marca_id              = $1,
             apresentadora_id      = $2,
             data                  = $3,
             gmv                   = $4,
             comissao_apresentadora = $5,
             comissao_franquia     = $6,
             comissao_franqueadora = $7,
             status_aprovacao      = 'pendente_aprovacao',
             status_motivo         = NULL,
             atualizado_em         = NOW()
         WHERE id = $8 AND tenant_id = $9::uuid
         RETURNING *`,
        [
          live.marca_id, apresentadoraId, data,
          gmvNum, comissao_apresentadora, comissao_franquia, comissao_franqueadora,
          existing.rows[0].id, tenantId,
        ],
      )
      row = upd.rows[0]
    } else {
      const ins = await db.query(
        `INSERT INTO vendas_atribuidas
           (tenant_id, origem, origem_id, marca_id, apresentadora_id, data,
            gmv, pedidos, comissao_apresentadora, comissao_franquia, comissao_franqueadora,
            status_aprovacao)
         VALUES ($1,'live',$2,$3,$4,$5,$6,$7,$8,$9,$10,'pendente_aprovacao')
         RETURNING *`,
        [
          tenantId, liveId, live.marca_id, apresentadoraId, data,
          gmvNum, 0, comissao_apresentadora, comissao_franquia, comissao_franqueadora,
        ],
      )
      row = ins.rows[0]
    }

    resultados.push(row)
  }

  return resultados
}
