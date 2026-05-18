/**
 * Motor de comissões — v2
 *
 * Regras:
 *  - comissao_franquia     = MAX(marca.valor_fixo_minimo, gmv × marca.comissao_franquia_pct / 100)
 *    Fonte única de verdade: marcas. contratos.valor_fixo é EXCLUSIVAMENTE mensalidade (billing_engine).
 *  - comissao_franqueadora = MAX(marca.valor_fixo_minimo, gmv × marca.comissao_franqueadora_pct / 100)
 *  - comissao_apresentadora = gmv_live × faixa_pct / 100
 *    onde faixa_pct é determinada pelo GMV acumulado da apresentadora no mês
 *    (busca em apresentadora_faixas_comissao)
 *  - Se não há faixa cadastrada: comissao_apresentadora = 0
 *  - Idempotente via upsert em vendas_atribuidas
 */

const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/**
 * Busca o pct de comissão da apresentadora baseado no GMV acumulado do mês.
 */
async function buscarFaixaComissao(db, { tenantId, apresentadoraId, gmvAcumuladoMes }) {
  if (!apresentadoraId) return 0
  const result = await db.query(
    `SELECT pct_comissao FROM apresentadora_faixas_comissao
     WHERE tenant_id = $1::uuid
       AND apresentadora_id = $2::uuid
       AND gmv_min <= $3
       AND (gmv_max IS NULL OR gmv_max >= $3)
       AND vigente_desde <= CURRENT_DATE
     ORDER BY gmv_min DESC
     LIMIT 1`,
    [tenantId, apresentadoraId, gmvAcumuladoMes],
  )
  return Number(result.rows[0]?.pct_comissao ?? 0)
}

/**
 * Busca GMV acumulado da apresentadora no mês corrente (excluindo a live atual).
 */
async function gmvAcumuladoMes(db, { tenantId, apresentadoraId, mesInicio, mesFim, liveIdAtual }) {
  if (!apresentadoraId) return 0
  const result = await db.query(
    `SELECT COALESCE(SUM(gmv), 0) AS total
     FROM vendas_atribuidas
     WHERE tenant_id = $1::uuid
       AND apresentadora_id = $2::uuid
       AND data >= $3::date
       AND data <= $4::date
       AND origem_id != $5::uuid`,
    [tenantId, apresentadoraId, mesInicio, mesFim, liveIdAtual],
  )
  return Number(result.rows[0]?.total ?? 0)
}

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
  const dataLive = live.iniciado_em
    ? new Date(live.iniciado_em).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10)

  const [ano, mes] = dataLive.split('-')
  const mesInicio = `${ano}-${mes}-01`
  const mesFim = new Date(Date.UTC(Number(ano), Number(mes), 0)).toISOString().slice(0, 10)

  // 2. Comissão franquia = MAX(marca.valor_fixo_minimo, gmv * pct)
  // Fonte única de verdade: marcas.comissao_franquia_pct e marcas.valor_fixo_minimo.
  // contratos.valor_fixo é usado exclusivamente pelo billing_engine para mensalidade fixa.
  const franquiaPct   = Number(live.comissao_franquia_pct ?? 0)
  const valorFixoMarca = Number(live.valor_fixo_minimo ?? 0)
  const comissao_franquia = Math.max(valorFixoMarca, gmvNum * (franquiaPct / 100))

  // 3. Comissão franqueadora = MAX(marca.valor_fixo_minimo, gmv * pct)
  const franqueadoraPct = Number(live.comissao_franqueadora_pct ?? 0)
  const comissao_franqueadora = Math.max(valorFixoMarca, gmvNum * (franqueadoraPct / 100))

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
    : [{ apresentadora_id: null }]

  const resultados = []

  for (const ap of linhas) {
    const apresentadoraId = ap.apresentadora_id ?? null

    // 5. Faixa progressiva: busca GMV acumulado do mês + pct da faixa
    let comissao_apresentadora = 0
    if (apresentadoraId) {
      const acumulado = await gmvAcumuladoMes(db, { tenantId, apresentadoraId, mesInicio, mesFim, liveIdAtual: liveId })
      const gmvTotalComEstaLive = acumulado + gmvNum
      const faixaPct = await buscarFaixaComissao(db, { tenantId, apresentadoraId, gmvAcumuladoMes: gmvTotalComEstaLive })
      comissao_apresentadora = gmvNum * (faixaPct / 100)
    }

    // 6. Upsert atômico em vendas_atribuidas — evita race condition entre processos paralelos.
    //    ON CONFLICT usa idx_vendas_atribuidas_origem_unique (tenant_id, origem, origem_id,
    //    COALESCE(apresentadora_id, NIL_UUID)). Registros já aprovados não são recalculados.
    const upsert = await db.query(
      `INSERT INTO vendas_atribuidas
         (tenant_id, origem, origem_id, marca_id, apresentadora_id, data,
          gmv, pedidos, comissao_apresentadora, comissao_franquia, comissao_franqueadora,
          status_aprovacao)
       VALUES ($1,'live',$2,$3,$4,$5,$6,$7,$8,$9,$10,'pendente_aprovacao')
       ON CONFLICT ON CONSTRAINT idx_vendas_atribuidas_origem_unique
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
        tenantId, liveId, live.marca_id, apresentadoraId, dataLive,
        gmvNum, 0, comissao_apresentadora, comissao_franquia, comissao_franqueadora,
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
