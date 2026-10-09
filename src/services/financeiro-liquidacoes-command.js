import { centsToExactMoney, exactMoneyToCents } from '../lib/money.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function commandError(message, statusCode, code) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw commandError(`${field} é obrigatório`, 400, 'FINANCEIRO_EVENTO_INVALIDO')
  }
  return value.trim()
}

function uuid(value, field) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw commandError(`${field} deve ser UUID válido`, 400, 'FINANCEIRO_EVENTO_INVALIDO')
  }
  return value.toLowerCase()
}

function date(value, field) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw commandError(`${field} deve estar no formato AAAA-MM-DD`, 400, 'FINANCEIRO_EVENTO_INVALIDO')
  }
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw commandError(`${field} é inválida`, 400, 'FINANCEIRO_EVENTO_INVALIDO')
  }
  return value
}

function positiveMoney(value, field = 'valor') {
  let cents
  try {
    cents = exactMoneyToCents(value)
  } catch (cause) {
    throw commandError(`${field} deve ser texto decimal exato com até duas casas`, 400, 'FINANCEIRO_VALOR_INVALIDO')
  }
  if (cents <= 0n) throw commandError(`${field} deve ser maior que zero`, 400, 'FINANCEIRO_VALOR_INVALIDO')
  return { cents, decimal: centsToExactMoney(cents) }
}

function actor(ator) {
  if (!ator || typeof ator !== 'object') {
    throw commandError('ator é obrigatório', 400, 'FINANCEIRO_EVENTO_INVALIDO')
  }
  return {
    tipo: requiredText(ator.tipo, 'ator.tipo'),
    id: requiredText(ator.id, 'ator.id'),
  }
}

function stablePayload(value) {
  if (Array.isArray(value)) return value.map(stablePayload)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stablePayload(value[key])]))
  }
  return value
}

function samePayload(left, right) {
  return JSON.stringify(stablePayload(left)) === JSON.stringify(stablePayload(right))
}

function rowToLiquidacao(row, replay = false) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    natureza: row.natureza,
    origemTipo: row.origem_tipo,
    origemId: row.origem_id,
    valor: row.valor,
    data: row.data_liquidacao,
    comandoOrigem: row.comando_origem,
    ator: { tipo: row.ator_tipo, id: row.ator_id },
    motivo: row.motivo ?? null,
    idempotenciaChave: row.idempotencia_chave,
    replay,
  }
}

function rowToEstorno(row, replay = false) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    liquidacaoId: row.liquidacao_id,
    valor: row.valor,
    data: row.data_estorno,
    comandoOrigem: row.comando_origem,
    ator: { tipo: row.ator_tipo, id: row.ator_id },
    motivo: row.motivo ?? null,
    idempotenciaChave: row.idempotencia_chave,
    replay,
  }
}

async function inOwnedTransaction(db, work) {
  if (!db || typeof db.query !== 'function') {
    throw commandError('db com query é obrigatório', 500, 'FINANCEIRO_DB_INVALIDO')
  }

  // Este serviço é o dono da transação. O chamador deve fornecer uma conexão
  // fora de transação e callbacks que usem exclusivamente o `tx` recebido.
  // PGlite expõe transaction(); pg/withTenant usa BEGIN/COMMIT na mesma conexão.
  if (typeof db.transaction === 'function') {
    return db.transaction(async (tx) => work(tx))
  }

  await db.query('BEGIN')
  try {
    const result = await work(db)
    await db.query('COMMIT')
    return result
  } catch (error) {
    try {
      await db.query('ROLLBACK')
    } catch {
      // Preserve the command failure; a broken connection is handled by its owner.
    }
    throw error
  }
}

async function existingLiquidacao(tx, tenantId, key) {
  const { rows } = await tx.query(
    `SELECT id, tenant_id, natureza, origem_tipo, origem_id, valor::text AS valor,
            to_char(data_liquidacao, 'YYYY-MM-DD') AS data_liquidacao,
            comando_origem, ator_tipo, ator_id, motivo, idempotencia_chave,
            idempotencia_payload
       FROM financeiro_liquidacoes
      WHERE tenant_id = $1::uuid AND idempotencia_chave = $2`,
    [tenantId, key],
  )
  return rows[0] ?? null
}

async function existingEstorno(tx, tenantId, key) {
  const { rows } = await tx.query(
    `SELECT id, tenant_id, liquidacao_id, valor::text AS valor,
            to_char(data_estorno, 'YYYY-MM-DD') AS data_estorno,
            comando_origem, ator_tipo, ator_id, motivo, idempotencia_chave,
            idempotencia_payload
       FROM financeiro_estornos
      WHERE tenant_id = $1::uuid AND idempotencia_chave = $2`,
    [tenantId, key],
  )
  return rows[0] ?? null
}

function replayOrConflict(row, payload, mapper) {
  if (!row) return null
  if (!samePayload(row.idempotencia_payload, payload)) {
    throw commandError(
      'Chave idempotente já usada com conteúdo diferente',
      409,
      'FINANCEIRO_IDEMPOTENCIA_CONFLITO',
    )
  }
  return mapper(row, true)
}

function validateOriginLock(result, requestedTenantId) {
  if (!result || typeof result !== 'object') {
    throw commandError('Origem não validada para atualização', 409, 'FINANCEIRO_ORIGEM_INVALIDA')
  }
  const validatedTenantId = uuid(result.tenantId, 'validarOrigemParaUpdate.tenantId')
  if (validatedTenantId !== requestedTenantId) {
    throw commandError('Origem pertence a outro tenant', 409, 'FINANCEIRO_ORIGEM_TENANT_CONFLITO')
  }
  if (!['receita', 'custo'].includes(result.natureza)) {
    throw commandError('Origem deve informar natureza receita ou custo', 409, 'FINANCEIRO_ORIGEM_INVALIDA')
  }
  const saldo = positiveMoney(result.saldoElegivel, 'saldoElegivel')
  return { natureza: result.natureza, saldoCents: saldo.cents, saldo: saldo.decimal }
}

/**
 * Registra uma liquidação FIN-03A e aplica sua projeção de compatibilidade.
 *
 * `validarOrigemParaUpdate(tx, contexto)` é obrigatório e deve executar o
 * SELECT ... FOR UPDATE da obrigação, devolvendo { tenantId, natureza,
 * saldoElegivel }. `aplicarProjecao(tx, evento)` também é obrigatório. Ambos
 * rodam dentro da transação criada aqui; nenhum callback deve abrir/fechar uma
 * transação própria.
 */
export async function registrarLiquidacao(db, {
  tenantId,
  origemTipo,
  origemId,
  valor,
  data,
  ator: atorInput,
  idempotenciaChave,
  validarOrigemParaUpdate,
  aplicarProjecao,
  comandoOrigem = 'fin-03a',
  motivo = null,
}) {
  const tenant = uuid(tenantId, 'tenantId')
  const origem = requiredText(origemTipo, 'origemTipo')
  const origemUuid = uuid(origemId, 'origemId')
  const money = positiveMoney(valor)
  const dataEvento = date(data, 'data')
  const atorNorm = actor(atorInput)
  const key = requiredText(idempotenciaChave, 'idempotenciaChave')
  const comando = requiredText(comandoOrigem, 'comandoOrigem')
  if (typeof validarOrigemParaUpdate !== 'function') {
    throw commandError('validarOrigemParaUpdate é obrigatório', 400, 'FINANCEIRO_VALIDACAO_ORIGEM_OBRIGATORIA')
  }
  if (typeof aplicarProjecao !== 'function') {
    throw commandError('aplicarProjecao é obrigatório', 400, 'FINANCEIRO_PROJECAO_OBRIGATORIA')
  }

  const payloadBase = {
    operacao: 'liquidacao', tenantId: tenant, origemTipo: origem, origemId: origemUuid,
    valor: money.decimal, data: dataEvento, ator: atorNorm, comandoOrigem: comando,
    motivo: motivo == null ? null : String(motivo),
  }

  return inOwnedTransaction(db, async (tx) => {
    let replay = replayOrConflict(await existingLiquidacao(tx, tenant, key), payloadBase, rowToLiquidacao)
    if (replay) return replay

    let lock
    try {
      lock = validateOriginLock(await validarOrigemParaUpdate(tx, {
        tenantId: tenant, origemTipo: origem, origemId: origemUuid,
      }), tenant)
    } catch (error) {
      // A validação também adquire o lock da origem. Se uma requisição com a
      // mesma chave terminou enquanto esta aguardava, o estado projetado pode
      // agora parecer sem saldo. O fato idempotente prevalece sobre esse erro.
      try {
        const replayDepoisDoLock = replayOrConflict(
          await existingLiquidacao(tx, tenant, key), payloadBase, rowToLiquidacao,
        )
        if (replayDepoisDoLock) return replayDepoisDoLock
      } catch (replayError) {
        // Erro SQL pode ter abortado a transação (25P02); nesse caso preserve a
        // falha original. Conflito idempotente é erro de domínio e deve vencer.
        if (replayError?.code === 'FINANCEIRO_IDEMPOTENCIA_CONFLITO') throw replayError
      }
      throw error
    }

    // A segunda leitura é necessária para concorrência: outro comando com a
    // mesma chave pode ter concluído enquanto aguardávamos o lock da origem.
    replay = replayOrConflict(await existingLiquidacao(tx, tenant, key), payloadBase, rowToLiquidacao)
    if (replay) return replay

    if (money.cents > lock.saldoCents) {
      throw commandError('Valor excede o saldo elegível da origem', 409, 'FINANCEIRO_SALDO_INSUFICIENTE')
    }

    const payload = stablePayload(payloadBase)
    const { rows } = await tx.query(
      `INSERT INTO financeiro_liquidacoes
         (tenant_id, natureza, origem_tipo, origem_id, valor, data_liquidacao,
          comando_origem, ator_tipo, ator_id, motivo, idempotencia_chave, idempotencia_payload)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5::numeric, $6::date,
               $7, $8, $9, $10, $11, $12::jsonb)
       ON CONFLICT (tenant_id, idempotencia_chave) DO NOTHING
       RETURNING id, tenant_id, natureza, origem_tipo, origem_id, valor::text AS valor,
                 to_char(data_liquidacao, 'YYYY-MM-DD') AS data_liquidacao,
                 comando_origem, ator_tipo, ator_id, motivo, idempotencia_chave,
                 idempotencia_payload`,
      [tenant, lock.natureza, origem, origemUuid, money.decimal, dataEvento,
        comando, atorNorm.tipo, atorNorm.id, payloadBase.motivo, key, JSON.stringify(payload)],
    )
    if (!rows[0]) {
      return replayOrConflict(await existingLiquidacao(tx, tenant, key), payloadBase, rowToLiquidacao)
    }
    const evento = rowToLiquidacao(rows[0])
    await aplicarProjecao(tx, { ...evento, saldoElegivelAntes: lock.saldo })
    return evento
  })
}

/**
 * Registra estorno contra uma liquidação existente. A liquidação original é
 * travada com FOR UPDATE antes de somar estornos já persistidos, serializando
 * estornos concorrentes para impedir que o total ultrapasse o fato original.
 */
export async function registrarEstorno(db, {
  tenantId,
  liquidacaoId,
  valor,
  data,
  ator: atorInput,
  idempotenciaChave,
  aplicarProjecao,
  comandoOrigem = 'fin-03a',
  motivo = null,
}) {
  const tenant = uuid(tenantId, 'tenantId')
  const liquidacaoUuid = uuid(liquidacaoId, 'liquidacaoId')
  const money = positiveMoney(valor)
  const dataEvento = date(data, 'data')
  const atorNorm = actor(atorInput)
  const key = requiredText(idempotenciaChave, 'idempotenciaChave')
  const comando = requiredText(comandoOrigem, 'comandoOrigem')
  if (typeof aplicarProjecao !== 'function') {
    throw commandError('aplicarProjecao é obrigatório', 400, 'FINANCEIRO_PROJECAO_OBRIGATORIA')
  }

  const payload = stablePayload({
    operacao: 'estorno', tenantId: tenant, liquidacaoId: liquidacaoUuid,
    valor: money.decimal, data: dataEvento, ator: atorNorm, comandoOrigem: comando,
    motivo: motivo == null ? null : String(motivo),
  })

  return inOwnedTransaction(db, async (tx) => {
    let replay = replayOrConflict(await existingEstorno(tx, tenant, key), payload, rowToEstorno)
    if (replay) return replay

    const { rows: originalRows } = await tx.query(
      `SELECT id, tenant_id, natureza, origem_tipo, origem_id, valor::text AS valor
         FROM financeiro_liquidacoes
        WHERE tenant_id = $1::uuid AND id = $2::uuid
        FOR UPDATE`,
      [tenant, liquidacaoUuid],
    )
    const original = originalRows[0]
    if (!original) {
      throw commandError('Liquidação original não encontrada no tenant', 404, 'FINANCEIRO_LIQUIDACAO_NAO_ENCONTRADA')
    }

    replay = replayOrConflict(await existingEstorno(tx, tenant, key), payload, rowToEstorno)
    if (replay) return replay

    const { rows: totalRows } = await tx.query(
      `SELECT COALESCE(SUM(valor), 0)::text AS total
         FROM financeiro_estornos
        WHERE tenant_id = $1::uuid AND liquidacao_id = $2::uuid`,
      [tenant, liquidacaoUuid],
    )
    const originalCents = exactMoneyToCents(original.valor)
    const estornadoCents = exactMoneyToCents(totalRows[0]?.total ?? '0')
    if (estornadoCents + money.cents > originalCents) {
      throw commandError('Soma dos estornos excede a liquidação original', 409, 'FINANCEIRO_ESTORNO_EXCEDENTE')
    }

    const { rows } = await tx.query(
      `INSERT INTO financeiro_estornos
         (tenant_id, liquidacao_id, valor, data_estorno, comando_origem,
          ator_tipo, ator_id, motivo, idempotencia_chave, idempotencia_payload)
       VALUES ($1::uuid, $2::uuid, $3::numeric, $4::date, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (tenant_id, idempotencia_chave) DO NOTHING
       RETURNING id, tenant_id, liquidacao_id, valor::text AS valor,
                 to_char(data_estorno, 'YYYY-MM-DD') AS data_estorno,
                 comando_origem, ator_tipo, ator_id, motivo, idempotencia_chave,
                 idempotencia_payload`,
      [tenant, liquidacaoUuid, money.decimal, dataEvento, comando,
        atorNorm.tipo, atorNorm.id, payload.motivo, key, JSON.stringify(payload)],
    )
    if (!rows[0]) {
      return replayOrConflict(await existingEstorno(tx, tenant, key), payload, rowToEstorno)
    }
    const evento = rowToEstorno(rows[0])
    await aplicarProjecao(tx, {
      ...evento,
      natureza: original.natureza,
      origemTipo: original.origem_tipo,
      origemId: original.origem_id,
      valorLiquidacao: original.valor,
      totalEstornadoAntes: centsToExactMoney(estornadoCents),
    })
    return evento
  })
}
