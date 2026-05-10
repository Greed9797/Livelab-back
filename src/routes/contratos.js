import { z } from 'zod'
import { READ_CONTRATOS, WRITE_CONTRATOS } from '../config/role_groups.js'

const createSchema = z.object({
  cliente_id:   z.string().uuid(),
  valor_fixo:   z.number().min(0),
  comissao_pct: z.number().min(0).max(100),
  pacote_id:    z.string().uuid().optional(),
})

export async function contratosRoutes(app) {
  // POST /v1/contratos/quick — cria contrato rascunho com defaults (sem valor_fixo obrigatório)
  app.post('/v1/contratos/quick', { preHandler: app.requirePapel(WRITE_CONTRATOS) }, async (request, reply) => {
    const { cliente_id, pacote_id } = request.body ?? {}
    if (!cliente_id || typeof cliente_id !== 'string') {
      return reply.code(400).send({ error: 'cliente_id é obrigatório' })
    }

    const { tenant_id, sub } = request.user
    return app.withTenant(tenant_id, async (db) => {
      let valor_fixo = 0
      let comissao_pct = 0

      if (pacote_id) {
        const pacoteQ = await db.query(
          `SELECT valor_fixo, comissao_pct FROM pacotes WHERE id = $1 AND tenant_id = $2`,
          [pacote_id, tenant_id]
        )
        if (!pacoteQ.rows[0]) return reply.code(400).send({ error: 'Pacote não encontrado' })
        valor_fixo = Number(pacoteQ.rows[0].valor_fixo)
        comissao_pct = Number(pacoteQ.rows[0].comissao_pct)
      }

      const result = await db.query(
        `INSERT INTO contratos (tenant_id, cliente_id, user_id, valor_fixo, comissao_pct, pacote_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, cliente_id, status`,
        [tenant_id, cliente_id, sub, valor_fixo, comissao_pct, pacote_id ?? null]
      )
      return reply.code(201).send(result.rows[0])
    })
  })

  // POST /v1/contratos
  app.post('/v1/contratos', { preHandler: app.requirePapel(WRITE_CONTRATOS) }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id, sub } = request.user
    const { cliente_id, valor_fixo, comissao_pct, pacote_id } = parsed.data

    return app.withTenant(tenant_id, async (db) => {
      let horasContratadas = 0
      if (pacote_id) {
        const pacoteQ = await db.query(
          `SELECT horas_incluidas FROM pacotes WHERE id = $1 AND tenant_id = $2`,
          [pacote_id, tenant_id]
        )
        if (!pacoteQ.rows[0]) return reply.code(400).send({ error: 'Pacote não encontrado' })
        horasContratadas = Number(pacoteQ.rows[0].horas_incluidas)
      }

      const result = await db.query(
        `INSERT INTO contratos (tenant_id, cliente_id, user_id, valor_fixo, comissao_pct, pacote_id, horas_contratadas)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, status, criado_em, pacote_id, horas_contratadas, horas_consumidas,
                   (horas_contratadas - horas_consumidas) AS horas_restantes`,
        [tenant_id, cliente_id, sub, valor_fixo, comissao_pct, pacote_id ?? null, horasContratadas]
      )
      return reply.code(201).send(result.rows[0])
    })
  })

  // GET /v1/contratos — lista todos os contratos do tenant
  app.get('/v1/contratos', { preHandler: app.requirePapel(READ_CONTRATOS) }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(`
        SELECT c.id, c.status, c.valor_fixo, c.comissao_pct,
               c.de_risco, c.assinado_em, c.ativado_em, c.cancelado_em,
               c.criado_em, c.pacote_id, c.horas_contratadas, c.horas_consumidas,
               (c.horas_contratadas - c.horas_consumidas) AS horas_restantes,
               cl.nome AS cliente_nome, cl.cnpj AS cliente_cnpj,
               cl.nicho AS cliente_nicho
        FROM contratos c
        JOIN clientes cl ON cl.id = c.cliente_id AND cl.tenant_id = c.tenant_id
        WHERE c.tenant_id = current_setting('app.tenant_id', true)::uuid
        ORDER BY c.criado_em DESC
      `)
      return result.rows
    })
  })

  // GET /v1/contratos/:id — detalhe de um contrato
  app.get('/v1/contratos/:id', { preHandler: app.requirePapel(READ_CONTRATOS) }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(`
        SELECT c.*,
               (c.horas_contratadas - c.horas_consumidas) AS horas_restantes,
               cl.nome AS cliente_nome, cl.cnpj AS cliente_cnpj,
               cl.fat_anual AS cliente_fat_anual, cl.nicho AS cliente_nicho,
               cl.score AS cliente_score, cl.email AS cliente_email,
               cl.celular AS cliente_celular
        FROM contratos c
        JOIN clientes cl ON cl.id = c.cliente_id AND cl.tenant_id = c.tenant_id
        WHERE c.id = $1
          AND c.tenant_id = current_setting('app.tenant_id', true)::uuid
      `, [request.params.id])
      if (!result.rows[0]) return reply.code(404).send({ error: 'Contrato não encontrado' })
      return result.rows[0]
    })
  })

  // PATCH /v1/contratos/:id — edita pacote/valores de um contrato em rascunho
  app.patch('/v1/contratos/:id', { preHandler: app.requirePapel(WRITE_CONTRATOS) }, async (request, reply) => {
    const { tenant_id } = request.user
    const { pacote_id, valor_fixo, comissao_pct } = request.body ?? {}

    return app.withTenant(tenant_id, async (db) => {
      let horasContratadas = null
      if (pacote_id !== undefined) {
        if (pacote_id === null) {
          horasContratadas = 0
        } else {
          const pacoteQ = await db.query(
            `SELECT horas_incluidas FROM pacotes WHERE id = $1 AND tenant_id = $2`,
            [pacote_id, tenant_id]
          )
          if (!pacoteQ.rows[0]) return reply.code(400).send({ error: 'Pacote não encontrado' })
          horasContratadas = Number(pacoteQ.rows[0].horas_incluidas)
        }
      }

      const sets = []
      const vals = []
      let idx = 1

      if (pacote_id !== undefined) { sets.push(`pacote_id = $${idx++}`); vals.push(pacote_id) }
      if (horasContratadas !== null) { sets.push(`horas_contratadas = $${idx++}`); vals.push(horasContratadas) }
      if (valor_fixo !== undefined) { sets.push(`valor_fixo = $${idx++}`); vals.push(valor_fixo) }
      if (comissao_pct !== undefined) { sets.push(`comissao_pct = $${idx++}`); vals.push(comissao_pct) }

      if (sets.length === 0) return reply.code(400).send({ error: 'Nenhum campo para atualizar' })

      vals.push(request.params.id)
      vals.push(tenant_id)
      const result = await db.query(
        `UPDATE contratos SET ${sets.join(', ')}
         WHERE id = $${idx}
           AND tenant_id = $${idx + 1}::uuid
           AND status = 'rascunho'
         RETURNING id, status, pacote_id, valor_fixo, comissao_pct,
                   horas_contratadas, horas_consumidas,
                   (horas_contratadas - horas_consumidas) AS horas_restantes`,
        vals
      )
      if (!result.rows[0]) return reply.code(400).send({ error: 'Contrato não encontrado ou não está em rascunho' })
      return result.rows[0]
    })
  })

  // POST /v1/contratos/:id/assinar → em_analise
  app.post('/v1/contratos/:id/assinar', { preHandler: app.requirePapel(WRITE_CONTRATOS) }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE contratos
         SET status = 'em_analise', assinado_em = NOW()
         WHERE id = $1
           AND tenant_id = $2::uuid
           AND status = 'rascunho'
         RETURNING id, status, assinado_em`,
        [request.params.id, tenant_id]
      )
      if (!result.rows[0]) return reply.code(400).send({ error: 'Contrato não encontrado ou já assinado' })
      return result.rows[0]
    })
  })

  // POST /v1/contratos/:id/assinar-digital
  app.post('/v1/contratos/:id/assinar-digital', { preHandler: app.requirePapel(WRITE_CONTRATOS) }, async (request, reply) => {
    const { tenant_id } = request.user
    const { signatureImageBase64, acceptedTerms } = request.body ?? {}

    if (!acceptedTerms) {
      return reply.code(400).send({ error: 'É necessário aceitar os termos para assinar' })
    }
    if (!signatureImageBase64) {
      return reply.code(400).send({ error: 'Imagem da assinatura é obrigatória' })
    }
    if (signatureImageBase64.length > 500_000) {
      return reply.code(400).send({ error: 'Imagem da assinatura excede o tamanho máximo permitido' })
    }

    return app.withTenant(tenant_id, async (db) => {
      const q = await db.query(
        `SELECT c.id, c.status, c.cliente_id,
                cl.fat_anual, cl.cnpj, cl.score as cliente_score, cl.nicho
         FROM contratos c JOIN clientes cl ON cl.id = c.cliente_id AND cl.tenant_id = c.tenant_id
         WHERE c.id = $1
           AND c.tenant_id = $2::uuid
           AND c.status = 'rascunho'`,
        [request.params.id, tenant_id]
      )
      const contrato = q.rows[0]
      if (!contrato) {
        return reply.code(400).send({ error: 'Contrato não encontrado ou não está em rascunho' })
      }

      const { score, risco, aprovado } = _calcularScoreCredito(contrato)
      const novoStatus = aprovado ? 'ativo' : 'em_analise'
      const signatureUrl = `data:image/png;base64,${signatureImageBase64}`
      const clientIp = request.headers['x-forwarded-for']?.split(',')[0]?.trim()
                    || request.socket?.remoteAddress
                    || 'unknown'

      await db.query('BEGIN')
      try {
        await db.query(
          `UPDATE contratos
           SET status = $1,
               signature_type = 'pad',
               signature_image_url = $2,
               signed_ip = $3,
               accepted_terms_at = NOW(),
               assinado_em = NOW(),
               ativado_em = $4
           WHERE id = $5 AND tenant_id = $6::uuid`,
          [novoStatus, signatureUrl, clientIp, aprovado ? new Date() : null, request.params.id, tenant_id]
        )

        if (aprovado) {
          await db.query(
            `UPDATE clientes SET status = 'ativo' WHERE id = $1 AND tenant_id = $2::uuid`,
            [contrato.cliente_id, tenant_id]
          )
        }
        await db.query('COMMIT')
      } catch (txErr) {
        await db.query('ROLLBACK')
        throw txErr
      }

      return { aprovado, score, risco, status: novoStatus, requer_backoffice: !aprovado }
    })
  })

  // POST /v1/contratos/:id/analisar → score automático → ativo ou cancelado
  app.post('/v1/contratos/:id/analisar', { preHandler: app.requirePapel(WRITE_CONTRATOS) }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      // Busca contrato + cliente
      const q = await db.query(
        `SELECT c.*, cl.fat_anual, cl.cnpj, cl.score as cliente_score, cl.nicho
         FROM contratos c JOIN clientes cl ON cl.id = c.cliente_id AND cl.tenant_id = c.tenant_id
         WHERE c.id = $1
           AND c.tenant_id = $2::uuid
           AND c.status = 'em_analise'`,
        [request.params.id, tenant_id]
      )
      const contrato = q.rows[0]
      if (!contrato) return reply.code(400).send({ error: 'Contrato não em análise' })

      const { score, risco, aprovado } = _calcularScoreCredito(contrato)
      const novoStatus = aprovado ? 'ativo' : 'cancelado'

      await db.query(
        `UPDATE contratos SET status = $1, ativado_em = $2, cancelado_em = $3
         WHERE id = $4 AND tenant_id = $5::uuid`,
        [novoStatus,
         aprovado ? new Date() : null,
         aprovado ? null : new Date(),
         request.params.id,
         tenant_id]
      )

      return { aprovado, score, risco, status: novoStatus }
    })
  })

  // PATCH /v1/contratos/:id/assumir-risco → ativo forçado
  app.patch('/v1/contratos/:id/assumir-risco', {
    preHandler: app.requirePapel(WRITE_CONTRATOS),
  }, async (request, reply) => {
    const { confirmacao, senha } = request.body ?? {}
    if (!confirmacao || confirmacao.toUpperCase() !== 'CONCORDO') {
      return reply.code(400).send({ error: 'Confirmação inválida' })
    }
    if (!senha) {
      return reply.code(400).send({ error: 'Senha é obrigatória' })
    }

    const { tenant_id, sub } = request.user

    // Valida senha do usuário
    const userQ = await app.db.query(
      `SELECT senha_hash FROM users WHERE id = $1`, [sub]
    )
    if (!userQ.rows[0]) {
      return reply.code(400).send({ error: 'Usuário não encontrado' })
    }

    const { default: bcrypt } = await import('bcrypt')
    const senhaOk = await bcrypt.compare(senha, userQ.rows[0].senha_hash)
    if (!senhaOk) {
      return reply.code(400).send({ error: 'Senha inválida' })
    }

    return app.withTenant(tenant_id, async (db) => {
      await db.query('BEGIN')
      try {
        const result = await db.query(
          `UPDATE contratos SET de_risco = true, is_risco_franqueado = true,
                  status = 'ativo', ativado_em = NOW(), risco_assumido_em = NOW()
           WHERE id = $1
             AND tenant_id = $2::uuid
             AND status IN ('em_analise', 'cancelado')
           RETURNING id, cliente_id, status, de_risco`,
          [request.params.id, tenant_id]
        )
        if (!result.rows[0]) {
          await db.query('ROLLBACK')
          return reply.code(400).send({ error: 'Contrato não encontrado ou não está em análise' })
        }

        await db.query(
          `UPDATE clientes SET status = 'ativo' WHERE id = $1 AND tenant_id = $2::uuid`,
          [result.rows[0].cliente_id, tenant_id]
        )
        await db.query('COMMIT')
      } catch (txErr) {
        await db.query('ROLLBACK')
        throw txErr
      }
      return { ok: true, status: 'ativo', de_risco: true }
    })
  })

  // PATCH /v1/contratos/:id/tiktok-username — define o @username do apresentador TikTok
  app.patch('/v1/contratos/:id/tiktok-username', {
    preHandler: app.requirePapel(WRITE_CONTRATOS),
  }, async (request, reply) => {
    const { tiktok_username } = request.body ?? {}
    const username = typeof tiktok_username === 'string'
      ? tiktok_username.replace(/^@/, '').trim() || null
      : null

    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const { rows } = await db.query(
        `UPDATE contratos SET tiktok_username = $1 WHERE id = $2 AND tenant_id = $3
         RETURNING id, tiktok_username`,
        [username, request.params.id, tenant_id]
      )
      if (!rows.length) return reply.code(404).send({ error: 'Contrato não encontrado' })
      return reply.send(rows[0])
    })
  })

  // PATCH /v1/contratos/:id/cancelar
  app.patch('/v1/contratos/:id/cancelar', { preHandler: app.requirePapel(WRITE_CONTRATOS) }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE contratos SET status = 'cancelado', cancelado_em = NOW()
         WHERE id = $1 AND status IN ('em_analise', 'ativo') RETURNING id, status`,
        [request.params.id]
      )
      if (!result.rows[0]) return reply.code(400).send({ error: 'Contrato não encontrado ou não pode ser cancelado neste estado' })
      return result.rows[0]
    })
  })

  // GET /v1/analise-credito
  app.get('/v1/analise-credito', { preHandler: app.requirePapel(READ_CONTRATOS) }, async (request) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT c.id, c.status, c.valor_fixo, c.comissao_pct,
                c.is_risco_franqueado, c.risco_assumido_em,
                c.arquivado_em, c.arquivado_motivo, c.assinado_em,
                cl.nome, cl.cnpj, cl.fat_anual, cl.nicho, cl.score,
                cl.razao_social
         FROM contratos c
         JOIN clientes cl ON cl.id = c.cliente_id
         WHERE c.tenant_id = $1
           AND c.status IN ('em_analise', 'ativo', 'arquivado')
         ORDER BY c.assinado_em DESC NULLS LAST`,
        [tenant_id]
      )
      return result.rows
    })
  })

  // PATCH /v1/contratos/:id/aprovar
  app.patch('/v1/contratos/:id/aprovar', {
    preHandler: app.requirePapel(['franqueador_master']),
  }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      await db.query('BEGIN')
      try {
        const q = await db.query(
          `UPDATE contratos
           SET status = 'ativo', ativado_em = NOW()
           WHERE id = $1 AND status = 'em_analise'
           RETURNING id, cliente_id`,
          [request.params.id]
        )
        if (!q.rows[0]) {
          await db.query('ROLLBACK')
          return reply.code(400).send({ error: 'Contrato não está em análise' })
        }

        await db.query(
          `UPDATE clientes SET status = 'ativo' WHERE id = $1`,
          [q.rows[0].cliente_id]
        )
        await db.query('COMMIT')
      } catch (txErr) {
        await db.query('ROLLBACK')
        throw txErr
      }
      return { ok: true, status: 'ativo' }
    })
  })

  // PATCH /v1/contratos/:id/arquivar
  app.patch('/v1/contratos/:id/arquivar', {
    preHandler: app.requirePapel(['franqueador_master']),
  }, async (request, reply) => {
    const { tenant_id } = request.user
    const motivo = (request.body ?? {}).motivo ?? null
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE contratos
         SET status = 'arquivado', arquivado_em = NOW(), arquivado_motivo = $2
         WHERE id = $1 AND status IN ('em_analise','rascunho')
         RETURNING id, status`,
        [request.params.id, motivo]
      )
      if (!result.rows[0]) return reply.code(400).send({ error: 'Contrato não pode ser arquivado' })
      return result.rows[0]
    })
  })

  // PATCH /v1/contratos/:id/pendencia
  app.patch('/v1/contratos/:id/pendencia', {
    preHandler: app.requirePapel(['franqueador_master']),
  }, async (request, reply) => {
    const motivo = request.body?.motivo
    if (!motivo || motivo.length < 8) {
      return reply.code(400).send({ error: 'Motivo deve ter pelo menos 8 caracteres' })
    }
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE contratos SET pendencia_motivo = $2, reviewed_at = NOW()
         WHERE id = $1 AND status = 'em_analise' RETURNING id, status`,
        [request.params.id, motivo]
      )
      if (!result.rows[0]) return reply.code(400).send({ error: 'Contrato não está em análise' })
      return result.rows[0]
    })
  })

  // PATCH /v1/contratos/:id/reprovar
  app.patch('/v1/contratos/:id/reprovar', {
    preHandler: app.requirePapel(['franqueador_master']),
  }, async (request, reply) => {
    const motivo = request.body?.motivo
    if (!motivo || motivo.trim().length < 8) {
      return reply.code(400).send({ error: 'Motivo deve ter pelo menos 8 caracteres' })
    }
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `UPDATE contratos SET status = 'cancelado', reprovacao_motivo = $2,
         cancelado_em = NOW(), reviewed_at = NOW()
         WHERE id = $1 AND status = 'em_analise' RETURNING id, status`,
        [request.params.id, motivo]
      )
      if (!result.rows[0]) return reply.code(400).send({ error: 'Contrato não está em análise' })
      return result.rows[0]
    })
  })

  // PATCH /v1/contratos/:id/sinalizar-risco
  app.patch('/v1/contratos/:id/sinalizar-risco', {
    preHandler: app.requirePapel(['franqueador_master']),
  }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      await db.query('BEGIN')
      try {
        const q = await db.query(
          `UPDATE contratos
           SET status = 'ativo',
               is_risco_franqueado = true,
               risco_assumido_em = NOW(),
               ativado_em = NOW()
           WHERE id = $1 AND status = 'em_analise'
           RETURNING id, cliente_id`,
          [request.params.id]
        )
        if (!q.rows[0]) {
          await db.query('ROLLBACK')
          return reply.code(400).send({ error: 'Contrato não está em análise' })
        }

        await db.query(
          `UPDATE clientes SET status = 'ativo' WHERE id = $1`,
          [q.rows[0].cliente_id]
        )
        await db.query('COMMIT')
      } catch (txErr) {
        await db.query('ROLLBACK')
        throw txErr
      }
      return { ok: true, status: 'ativo', is_risco_franqueado: true }
    })
  })
}

/**
 * Calcula o score de crédito e classifica o risco.
 * Escala 0-100:
 *   - fat_anual (até 40 pts): porte da operação
 *   - cnpj (até 20 pts): PJ formalizada tem menos risco que PF
 *   - cliente_score (até 30 pts): score externo (Serasa/interno)
 *   - nicho (até 10 pts): nichos recorrentes/estáveis
 *
 * Classificação:
 *   - score >= 75 → baixo risco (aprova auto)
 *   - score >= 45 → médio risco (requer análise)
 *   - score <  45 → alto risco (recomenda recusa)
 *
 * Aprovação automática: score >= 60
 */
function _calcularScoreCredito({ fat_anual, cnpj, cliente_score, nicho } = {}) {
  let score = 0
  const fat = Number(fat_anual) || 0

  // Porte de faturamento — max 40
  if (fat >= 200_000) score += 40
  else if (fat >= 50_000) score += 25
  else if (fat >= 10_000) score += 15
  else if (fat >= 1_000) score += 5

  // CNPJ formalizado — max 20
  if (cnpj && String(cnpj).replace(/\D/g, '').length >= 14) score += 20

  // Score externo (Serasa/interno normalizado 0-1000) — max 30
  const cs = Number(cliente_score) || 0
  if (cs >= 800) score += 30
  else if (cs >= 600) score += 20
  else if (cs >= 400) score += 10

  // Nicho recorrente — max 10
  const nichosEstaveis = ['beleza', 'moda', 'alimentacao', 'alimentação', 'saude', 'saúde', 'pet', 'fitness']
  if (nicho && nichosEstaveis.includes(String(nicho).toLowerCase().trim())) score += 10

  score = Math.min(100, score)

  let risco
  if (score >= 75) risco = 'baixo'
  else if (score >= 45) risco = 'medio'
  else risco = 'alto'

  return { score, risco, aprovado: score >= 60 }
}
