import bcrypt from 'bcrypt'

export async function insertContratoEvento(db, data) {
  const {
    tenantId,
    contratoId,
    tipoEvento,
    actorUserId = null,
    actorPapel = null,
    ip = null,
    payload = {},
  } = data

  await db.query(
    `INSERT INTO contrato_eventos (
       tenant_id,
       contrato_id,
       tipo_evento,
       actor_user_id,
       actor_papel,
       ip,
       payload_json
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      tenantId,
      contratoId,
      tipoEvento,
      actorUserId,
      actorPapel,
      ip,
      JSON.stringify(payload),
    ]
  )
}

export async function updateClienteStatusFromContrato(db, clienteId, status) {
  await db.query(
    `UPDATE clientes
     SET status = $2,
         atualizado_em = NOW()
     WHERE id = $1`,
    [clienteId, status]
  )
}

export async function validarAssuncaoRisco({ db, userId, senha, confirmacao }) {
  if (confirmacao !== 'CONCORDO') {
    const error = new Error('Confirmação inválida')
    error.statusCode = 422
    throw error
  }

  if (!senha) {
    const error = new Error('Senha é obrigatória para assumir risco')
    error.statusCode = 422
    throw error
  }

  const result = await db.query(
    `SELECT id, senha_hash FROM users WHERE id = $1`,
    [userId]
  )

  const user = result.rows[0]
  if (!user?.senha_hash) {
    const error = new Error('Usuário sem credenciais válidas para esta operação')
    error.statusCode = 403
    throw error
  }

  const ok = await bcrypt.compare(senha, user.senha_hash)
  if (!ok) {
    const error = new Error('Senha inválida')
    error.statusCode = 401
    throw error
  }
}

export async function executarAcaoAuditoria({
  db,
  contratoId,
  tenantId,
  actorUserId,
  actorPapel,
  ip,
  acao,
  motivo = null,
  confirmacao = null,
}) {
  const allowedActions = ['aprovar', 'pendencia', 'reprovar', 'arquivar', 'assumir_risco']
  if (!allowedActions.includes(acao)) {
    const error = new Error('Ação de auditoria inválida')
    error.statusCode = 400
    throw error
  }

  await db.query('BEGIN')

  try {
    const currentResult = await db.query(
      `SELECT c.id, c.status, c.cliente_id, c.valor_fixo, c.comissao_pct, c.tenant_id
       FROM contratos c
       WHERE c.id = $1 AND c.tenant_id = $2
       FOR UPDATE`,
      [contratoId, tenantId]
    )

    const contrato = currentResult.rows[0]
    if (!contrato) {
      const error = new Error('Contrato não encontrado')
      error.statusCode = 404
      throw error
    }

    let clienteStatus = contrato.status
    let evento = null
    let payload = {}

    switch (acao) {
      case 'aprovar': {
        if (!['em_analise', 'pendencia_comercial', 'reprovado'].includes(contrato.status)) {
          const error = new Error('Contrato não pode ser aprovado no status atual')
          error.statusCode = 400
          throw error
        }

        await db.query(
          `UPDATE contratos
           SET status = 'ativo',
               approved_by = $2,
               approved_at = NOW(),
               approved_ip = $3,
               reviewed_by = $2,
               reviewed_at = NOW(),
               review_ip = $3,
               pendencia_motivo = NULL,
               reprovacao_motivo = NULL,
               ativado_em = NOW()
           WHERE id = $1`,
          [contratoId, actorUserId, ip]
        )
        clienteStatus = 'ativo'
        evento = 'contrato_aprovado'
        payload = { from_status: contrato.status }
        break
      }

      case 'pendencia': {
        if (!motivo) {
          const error = new Error('Motivo da pendência é obrigatório')
          error.statusCode = 422
          throw error
        }
        if (!['em_analise', 'reprovado'].includes(contrato.status)) {
          const error = new Error('Contrato não pode entrar em pendência no status atual')
          error.statusCode = 400
          throw error
        }

        await db.query(
          `UPDATE contratos
           SET status = 'pendencia_comercial',
               pendencia_motivo = $2,
               reviewed_by = $3,
               reviewed_at = NOW(),
               review_ip = $4
           WHERE id = $1`,
          [contratoId, motivo, actorUserId, ip]
        )
        clienteStatus = 'pendencia_comercial'
        evento = 'contrato_pendencia_comercial'
        payload = { motivo }
        break
      }

      case 'reprovar': {
        if (!motivo) {
          const error = new Error('Motivo da reprovação é obrigatório')
          error.statusCode = 422
          throw error
        }
        if (!['em_analise', 'pendencia_comercial'].includes(contrato.status)) {
          const error = new Error('Contrato não pode ser reprovado no status atual')
          error.statusCode = 400
          throw error
        }

        await db.query(
          `UPDATE contratos
           SET status = 'reprovado',
               reprovacao_motivo = $2,
               reviewed_by = $3,
               reviewed_at = NOW(),
               review_ip = $4,
               prazo_decisao_ate = NOW() + INTERVAL '5 days'
           WHERE id = $1`,
          [contratoId, motivo, actorUserId, ip]
        )
        clienteStatus = 'reprovado'
        evento = 'contrato_reprovado'
        payload = { motivo }
        break
      }

      case 'arquivar': {
        await db.query(
          `UPDATE contratos
           SET status = 'arquivado',
               arquivado_em = NOW(),
               arquivado_motivo = $2,
               reviewed_by = $3,
               reviewed_at = NOW(),
               review_ip = $4
           WHERE id = $1`,
          [contratoId, motivo, actorUserId, ip]
        )
        clienteStatus = 'arquivado'
        evento = 'contrato_arquivado'
        payload = motivo ? { motivo } : {}
        break
      }

      case 'assumir_risco': {
        await db.query(
          `UPDATE contratos
           SET status = 'ativo',
               is_risco_franqueado = true,
               franqueado_aceite_risco_em = NOW(),
               franqueado_aceite_risco_ip = $2,
               franqueado_aceite_risco_texto = $3,
               risco_assumido_em = NOW(),
               ativado_em = NOW(),
               reprovacao_motivo = NULL
           WHERE id = $1`,
          [contratoId, ip, confirmacao]
        )
        clienteStatus = 'ativo'
        evento = 'contrato_risco_assumido'
        payload = { from_status: contrato.status, confirmacao }
        break
      }
    }

    await updateClienteStatusFromContrato(db, contrato.cliente_id, clienteStatus)

    await insertContratoEvento(db, {
      tenantId,
      contratoId,
      tipoEvento: evento,
      actorUserId,
      actorPapel,
      ip,
      payload,
    })

    await db.query('COMMIT')
    return { ok: true, status: clienteStatus, action: acao }
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  }
}
