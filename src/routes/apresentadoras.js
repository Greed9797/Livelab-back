import { z } from 'zod'
import { READ_APRESENTADORAS, WRITE_APRESENTADORAS } from '../config/role_groups.js'
import { DEFAULT_APRESENTADORA_FIXO, MAX_APRESENTADORA_FIXO, ensureDefaultPresenterCommissionTiers, presenterFixedSql } from '../config/presenter_defaults.js'
import { moneySchema } from '../lib/money.js'
import { recalcularVendasAtribuidasApresentadora } from './vendas_atribuidas.js'
import { isPresenterRole, resolvePresenterId } from '../services/presenter-identity.js'

const imageUrlSchema = z.string().max(500000).nullable().optional()

const fixoSchema = moneySchema.refine((v) => v <= MAX_APRESENTADORA_FIXO, {
  message: `Fixo não pode ultrapassar R$ ${MAX_APRESENTADORA_FIXO.toLocaleString('pt-BR')}`,
})

const createSchema = z.object({
  nome:            z.string().min(1),
  telefone:        z.string().optional(),
  cargo:           z.string().optional(),
  email:           z.string().email().optional(),
  cpf_cnpj:        z.string().optional(),
  cidade:          z.string().optional(),
  fixo:            fixoSchema.default(DEFAULT_APRESENTADORA_FIXO),
  comissao_pct:    z.number().min(0).max(100).default(0),
  foto_url:        imageUrlSchema,
  observacoes:     z.string().optional(),
  link_contrato:   z.string().optional(),
  data_aniversario: z.string().optional(),
  data_inicio:     z.string().optional(),
  data_fim:        z.string().optional(),
})

// PATCH must not inherit defaults from createSchema: a partial Zod object can
// otherwise materialize default financial fields that the caller did not send.
const updateSchema = z.object({
  nome: z.string().min(1).optional(),
  telefone: z.string().optional(),
  cargo: z.string().optional(),
  email: z.string().email().optional(),
  cpf_cnpj: z.string().optional(),
  cidade: z.string().optional(),
  fixo: fixoSchema.optional(),
  comissao_pct: z.number().min(0).max(100).optional(),
  foto_url: imageUrlSchema,
  observacoes: z.string().optional(),
  link_contrato: z.string().optional(),
  data_aniversario: z.string().optional(),
  data_inicio: z.string().optional(),
  data_fim: z.string().optional(),
  ativo: z.boolean().optional(),
  arquivada: z.boolean().optional(),
})

const faixaSchema = z.object({
  gmv_inicio: moneySchema.default(0),
  gmv_fim: moneySchema.nullable().optional(),
  comissao_pct: z.coerce.number().min(0).max(100),
})

const faixaPatchSchema = faixaSchema.partial()

const COLS = `id, user_id, nome, telefone, cargo, email, cpf_cnpj, cidade, ativo, arquivada, ${presenterFixedSql('a')} AS fixo, comissao_pct, foto_url, observacoes, link_contrato, data_aniversario, data_inicio, data_fim, origem_dados, criado_em`
const RETURNING_COLS = `id, user_id, nome, telefone, cargo, email, cpf_cnpj, cidade, ativo, arquivada, ${presenterFixedSql('')} AS fixo, comissao_pct, foto_url, observacoes, link_contrato, data_aniversario, data_inicio, data_fim, origem_dados, criado_em`

export async function apresentadorasRoutes(app) {
  const readAccess = [app.authenticate, app.requirePapel(READ_APRESENTADORAS)]
  const writeAccess = [app.authenticate, app.requirePapel(WRITE_APRESENTADORAS)]

  // GET /v1/apresentadoras
  // Inclui array `faixas` da escada de comissão por GMV — usado por
  // ApresentadorasPanel + SettingsUsuariosPanel pra exibir a faixa atual
  // de cada apresentadora sem precisar de chamada extra.
  app.get('/v1/apresentadoras', { preHandler: readAccess }, async (request) => {
    const { tenant_id } = request.user
    // Default: exclui ativo=false (soft-delete) e arquivada=true.
    // ?include_inactive=true → mostra inativas; ?include_archived=true → mostra arquivadas.
    const includeInactive = String(request.query?.include_inactive ?? '').toLowerCase() === 'true'
    const includeArchived = String(request.query?.include_archived ?? '').toLowerCase() === 'true'
    const activeFilter = [
      includeInactive ? '' : 'AND a.ativo IS NOT FALSE',
      includeArchived ? '' : 'AND a.arquivada IS NOT TRUE',
    ].join(' ')
    return app.withTenant(tenant_id, async (db) => {
      const result = await db.query(
        `SELECT ${COLS},
                COALESCE((
                  SELECT json_agg(json_build_object(
                    'id', f.id,
                    'gmv_inicio', f.gmv_inicio,
                    'gmv_fim', f.gmv_fim,
                    'comissao_pct', f.comissao_pct,
                    'ativo', f.ativo
                  ) ORDER BY f.gmv_inicio ASC)
                  FROM apresentadora_comissao_faixas f
                  WHERE f.apresentadora_id = a.id
                    AND f.tenant_id = a.tenant_id
                    AND f.ativo IS NOT FALSE
                ), '[]'::json) AS faixas
         FROM apresentadoras a
         WHERE a.tenant_id = $1::uuid
           ${activeFilter}
         ORDER BY a.ativo DESC, a.nome ASC`,
        [tenant_id]
      )
      return result.rows
    })
  })

  // GET /v1/apresentadoras/:id/faixas-comissao
  app.get('/v1/apresentadoras/:id/faixas-comissao', { preHandler: app.authenticate }, async (request, reply) => {
    const { tenant_id, papel, sub: userId } = request.user
    return app.withTenant(tenant_id, async (db) => {
      // Resolve id real da apresentadora (aceita user_id de usuário apresentador).
      const apresentadoraId = await resolvePresenterId(db, tenant_id, request.params.id)
      if (!apresentadoraId) return [] // sem perfil ainda → sem faixas

      if (!READ_APRESENTADORAS.includes(papel)) {
        const own = await db.query(
          `SELECT id FROM apresentadoras
           WHERE id = $1 AND tenant_id = $2::uuid AND user_id = $3`,
          [apresentadoraId, tenant_id, userId],
        )
        if (!own.rows[0]) return reply.code(403).send({ error: 'Acesso negado' })
      }

      const result = await db.query(
        `SELECT id, apresentadora_id, gmv_inicio, gmv_fim, comissao_pct, ativo, criado_em, atualizado_em
         FROM apresentadora_comissao_faixas
         WHERE tenant_id = $1::uuid AND apresentadora_id = $2
         ORDER BY ativo DESC, gmv_inicio ASC`,
        [tenant_id, apresentadoraId],
      )
      return result.rows
    })
  })

  // POST /v1/apresentadoras/:id/faixas-comissao
  app.post('/v1/apresentadoras/:id/faixas-comissao', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = faixaSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    const { tenant_id } = request.user
    const d = parsed.data
    const created = await app.withTenant(tenant_id, async (db) => {
      const apresentadoraId = await resolvePresenterId(db, tenant_id, request.params.id)
      if (!apresentadoraId) return null
      const result = await db.query(
        `INSERT INTO apresentadora_comissao_faixas (
           tenant_id, apresentadora_id, gmv_inicio, gmv_fim, comissao_pct, ativo
         )
         VALUES ($1,$2,$3,$4,$5,true)
         RETURNING id, apresentadora_id, gmv_inicio, gmv_fim, comissao_pct, ativo, criado_em, atualizado_em`,
        [tenant_id, apresentadoraId, d.gmv_inicio, d.gmv_fim ?? null, d.comissao_pct],
      )
      return { apresentadoraId, row: result.rows[0] }
    })
    if (!created) return reply.code(404).send({ error: 'Apresentadora não encontrada' })

    // Recálculo fire-and-forget FORA do withTenant da resposta — síncrono estourava
    // o timeout do request quando a apresentadora tinha muitas vendas.
    app.withTenant(tenant_id, (db2) => recalcularVendasAtribuidasApresentadora(db2, { tenantId: tenant_id, apresentadoraId: created.apresentadoraId }))
      .catch(err => app.log.warn({ err, apresentadoraId: created.apresentadoraId }, 'recalculo pos-faixa (create) falhou (soft)'))

    app.audit?.log?.(request, {
      action: 'presenter.faixas.create',
      entity_type: 'apresentadora_comissao_faixa',
      entity_id: created.row.id,
      metadata: { apresentadora_id: created.apresentadoraId, gmv_inicio: d.gmv_inicio, gmv_fim: d.gmv_fim ?? null, comissao_pct: d.comissao_pct },
    })?.catch?.(err => app.log.error({ err }, 'audit log presenter.faixas.create failed'))
    return reply.code(201).send(created.row)
  })

  // PATCH /v1/apresentadoras/:id/faixas-comissao/:faixaId
  app.patch('/v1/apresentadoras/:id/faixas-comissao/:faixaId', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = faixaPatchSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const updates = parsed.data
    const fields = Object.keys(updates)
    if (!fields.length) return reply.code(400).send({ error: 'Nenhum campo para atualizar' })

    const { tenant_id } = request.user
    const updated = await app.withTenant(tenant_id, async (db) => {
      const apresentadoraId = await resolvePresenterId(db, tenant_id, request.params.id)
      if (!apresentadoraId) return { error: 'Apresentadora não encontrada' }

      const set = fields.map((field, index) => `${field} = $${index + 4}`).concat('atualizado_em = NOW()').join(', ')
      const values = [apresentadoraId, request.params.faixaId, tenant_id, ...fields.map((field) => updates[field])]
      const result = await db.query(
        `UPDATE apresentadora_comissao_faixas
         SET ${set}
         WHERE apresentadora_id = $1 AND id = $2 AND tenant_id = $3::uuid
         RETURNING id, apresentadora_id, gmv_inicio, gmv_fim, comissao_pct, ativo, criado_em, atualizado_em`,
        values,
      )
      if (!result.rows[0]) return { error: 'Faixa não encontrada' }
      return { apresentadoraId, row: result.rows[0] }
    })
    if (updated.error) return reply.code(404).send({ error: updated.error })

    // Recálculo fire-and-forget FORA do withTenant da resposta — síncrono estourava
    // o timeout do request quando a apresentadora tinha muitas vendas.
    app.withTenant(tenant_id, (db2) => recalcularVendasAtribuidasApresentadora(db2, { tenantId: tenant_id, apresentadoraId: updated.apresentadoraId }))
      .catch(err => app.log.warn({ err, apresentadoraId: updated.apresentadoraId }, 'recalculo pos-faixa (update) falhou (soft)'))

    app.audit?.log?.(request, {
      action: 'presenter.faixas.update',
      entity_type: 'apresentadora_comissao_faixa',
      entity_id: request.params.faixaId,
      metadata: { apresentadora_id: updated.apresentadoraId, changed_fields: fields, after: updated.row },
    })?.catch?.(err => app.log.error({ err }, 'audit log presenter.faixas.update failed'))
    return updated.row
  })

  // DELETE /v1/apresentadoras/:id/faixas-comissao/:faixaId — DELETE físico
  // (linha presente = vale; soft-delete via ativo=false foi aposentado).
  app.delete('/v1/apresentadoras/:id/faixas-comissao/:faixaId', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    const deleted = await app.withTenant(tenant_id, async (db) => {
      const apresentadoraId = await resolvePresenterId(db, tenant_id, request.params.id)
      if (!apresentadoraId) return { error: 'Apresentadora não encontrada' }

      const result = await db.query(
        `DELETE FROM apresentadora_comissao_faixas
         WHERE apresentadora_id = $1 AND id = $2 AND tenant_id = $3::uuid
         RETURNING id`,
        [apresentadoraId, request.params.faixaId, tenant_id],
      )
      if (!result.rows[0]) return { error: 'Faixa não encontrada' }
      return { apresentadoraId }
    })
    if (deleted.error) return reply.code(404).send({ error: deleted.error })

    // Recálculo fire-and-forget FORA do withTenant da resposta — síncrono estourava
    // o timeout do request quando a apresentadora tinha muitas vendas.
    app.withTenant(tenant_id, (db2) => recalcularVendasAtribuidasApresentadora(db2, { tenantId: tenant_id, apresentadoraId: deleted.apresentadoraId }))
      .catch(err => app.log.warn({ err, apresentadoraId: deleted.apresentadoraId }, 'recalculo pos-faixa (delete) falhou (soft)'))

    app.audit?.log?.(request, {
      action: 'presenter.faixas.delete',
      entity_type: 'apresentadora_comissao_faixa',
      entity_id: request.params.faixaId,
      metadata: { apresentadora_id: deleted.apresentadoraId, hard_delete: true },
    })?.catch?.(err => app.log.error({ err }, 'audit log presenter.faixas.delete failed'))
    return reply.code(204).send()
  })

  // GET /v1/apresentadoras/:id
  app.get('/v1/apresentadoras/:id', { preHandler: readAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      const apresentadoraId = await resolvePresenterId(db, tenant_id, request.params.id)
      if (!apresentadoraId) return reply.code(404).send({ error: 'Apresentadora não encontrada' })

      const result = await db.query(
        `SELECT ${COLS} FROM apresentadoras WHERE id = $1 AND tenant_id = $2::uuid`,
        [apresentadoraId, tenant_id]
      )
      if (!result.rows[0]) return reply.code(404).send({ error: 'Apresentadora não encontrada' })
      return result.rows[0]
    })
  })

  // POST /v1/apresentadoras
  // SPEC_DEVIATION: a chave de API não cria apresentadora (spec bot-tag-e-cli BOT-02).
  // Reason: o cadastro direto está desativado (410) para todo mundo — apresentadora
  // nasce do convite de usuário em Configurações, que a chave não alcança por desenho.
  // A coluna origem_dados existe e é devolvida; só não há caminho de escrita por bot.
  app.post('/v1/apresentadoras', { preHandler: writeAccess }, async (request, reply) => {
    return reply.code(410).send({
      error: 'Cadastro direto de apresentadora foi desativado. Crie ou vincule apresentadoras em Configurações > Usuários.',
      flow: 'usuarios.convidar',
    })
  })

  // PATCH /v1/apresentadoras/:id
  app.patch('/v1/apresentadoras/:id', { preHandler: writeAccess }, async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })

    const { tenant_id } = request.user
    const updates = parsed.data
    const fields = Object.keys(updates)
    const userAdmin = ['franqueado', 'franqueador_master'].includes(request.user.papel)
    if (fields.length === 0) return reply.code(400).send({ error: 'Nenhum campo para atualizar' })

    return app.withTenant(tenant_id, async (db) => {
      await db.query('BEGIN')
      try {
        const apresentadoraId = await resolvePresenterId(db, tenant_id, request.params.id)
        if (!apresentadoraId) { await db.query('ROLLBACK'); return reply.code(404).send({ error: 'Apresentadora não encontrada' }) }
        // Lock order is always users → apresentadoras. User routes already lock
        // in that order; doing the reverse here deadlocks concurrent edits.
        const profileRefQ = await db.query(
          `SELECT id, user_id FROM apresentadoras WHERE id=$1 AND tenant_id=$2::uuid`,
          [apresentadoraId, tenant_id],
        )
        const profileRef = profileRefQ.rows[0]
        if (!profileRef) { await db.query('ROLLBACK'); return reply.code(404).send({ error: 'Apresentadora não encontrada' }) }

        let linkedUser = null
        if (profileRef.user_id) {
          const linked = await db.query(
            `SELECT id, papel, ativo, email FROM users WHERE id=$1::uuid AND tenant_id=$2::uuid FOR UPDATE`,
            [profileRef.user_id, tenant_id],
          )
          linkedUser = linked.rows[0] ?? null
          if (!linkedUser || !isPresenterRole(linkedUser.papel)) {
            await db.query('ROLLBACK')
            return reply.code(409).send({ error: 'Perfil vinculado a usuário que não é apresentador. Corrija o vínculo em Usuários.' })
          }
          if (Object.hasOwn(updates, 'arquivada')) {
            await db.query('ROLLBACK')
            return reply.code(409).send({ error: 'Perfil vinculado não pode ser arquivado por esta rota. Desative a conta em Usuários.' })
          }
          const profileQ = await db.query(
            `SELECT id, user_id, ativo, arquivada FROM apresentadoras
              WHERE id=$1 AND tenant_id=$2::uuid FOR UPDATE`,
            [apresentadoraId, tenant_id],
          )
          const profile = profileQ.rows[0]
          if (!profile || profile.user_id !== linkedUser.id) {
            await db.query('ROLLBACK')
            return reply.code(409).send({ error: 'O vínculo de apresentadora foi alterado. Tente novamente.' })
          }
          if (updates.ativo === true && !userAdmin && profile.ativo === false) {
            await db.query('ROLLBACK')
            return reply.code(403).send({ error: 'A reativação de perfil vinculado deve ser feita por um administrador em Usuários.' })
          }
          if (updates.ativo === true && (linkedUser.ativo === false || profile.arquivada === true)) {
            await db.query('ROLLBACK')
            return reply.code(409).send({ error: 'Não é possível reativar o perfil por esta rota. Reative o usuário apresentador em Usuários.' })
          }
          if (Object.hasOwn(updates, 'nome') || Object.hasOwn(updates, 'email')) {
            const emailChanged = Object.hasOwn(updates, 'email') && updates.email !== linkedUser.email
            if (emailChanged && !userAdmin) {
              await db.query('ROLLBACK')
              return reply.code(403).send({ error: 'A alteração do e-mail de acesso deve ser feita em Usuários por um administrador.' })
            }
            if (emailChanged) {
              const collision = await db.query(
                `SELECT id FROM users WHERE tenant_id=$1::uuid AND LOWER(email)=LOWER($2) AND ativo IS NOT FALSE AND id <> $3::uuid LIMIT 1`,
                [tenant_id, updates.email, linkedUser.id],
              )
              if (collision.rows[0]) { await db.query('ROLLBACK'); return reply.code(409).send({ error: 'E-mail já cadastrado e ativo neste tenant.' }) }
            }
          }
        } else {
          const profileQ = await db.query(
            `SELECT id, user_id FROM apresentadoras WHERE id=$1 AND tenant_id=$2::uuid FOR UPDATE`,
            [apresentadoraId, tenant_id],
          )
          if (!profileQ.rows[0]) { await db.query('ROLLBACK'); return reply.code(404).send({ error: 'Apresentadora não encontrada' }) }
          if (profileQ.rows[0].user_id) { await db.query('ROLLBACK'); return reply.code(409).send({ error: 'O vínculo de apresentadora foi alterado. Tente novamente.' }) }
        }

        const setClauses = fields.map((f, i) => `${f} = $${i + 3}`).join(', ')
        const values = [apresentadoraId, tenant_id, ...fields.map((f) => updates[f])]
        const result = await db.query(
          `UPDATE apresentadoras SET ${setClauses}
           WHERE id = $1 AND tenant_id = $2::uuid
           RETURNING ${RETURNING_COLS}`,
          values,
        )
        if (!result.rows[0]) { await db.query('ROLLBACK'); return reply.code(404).send({ error: 'Apresentadora não encontrada' }) }

        const deactivatesLinkedLogin = linkedUser && updates.ativo === false
        const emailChanged = linkedUser && Object.hasOwn(updates, 'email') && updates.email !== linkedUser.email
        if (linkedUser && (deactivatesLinkedLogin || Object.hasOwn(updates, 'nome') || Object.hasOwn(updates, 'email'))) {
          const assignments = []
          const userValues = []
          if (deactivatesLinkedLogin) assignments.push('ativo=false', 'token_version=token_version+1')
          if (Object.hasOwn(updates, 'nome')) { assignments.push(`nome=$${userValues.length + 1}`); userValues.push(updates.nome) }
          if (Object.hasOwn(updates, 'email')) { assignments.push(`email=$${userValues.length + 1}`); userValues.push(updates.email) }
          if (emailChanged && !deactivatesLinkedLogin) assignments.push('token_version=token_version+1')
          userValues.push(linkedUser.id, tenant_id)
          await db.query(`UPDATE users SET ${assignments.join(', ')} WHERE id=$${userValues.length - 1}::uuid AND tenant_id=$${userValues.length}::uuid`, userValues)
          if (deactivatesLinkedLogin || emailChanged) await db.query('DELETE FROM refresh_tokens WHERE user_id=$1::uuid', [linkedUser.id])
        }
        if (fields.includes('comissao_pct')) await recalcularVendasAtribuidasApresentadora(db, { tenantId: tenant_id, apresentadoraId })
        await db.query('COMMIT')
        if (linkedUser && (deactivatesLinkedLogin || emailChanged)) app.invalidateTokenVersionCache?.(linkedUser.id)
        app.audit?.log?.(request, { action: 'apresentadora.update', entity_type: 'apresentadora', entity_id: apresentadoraId, metadata: { changed_fields: fields } })?.catch(err => app.log.error({ err }, 'audit log failed'))
        return result.rows[0]
      } catch (error) {
        await db.query('ROLLBACK').catch(() => {})
        throw error
      }
    })
  })

  // DELETE /v1/apresentadoras/:id — desativa (soft delete)
  app.delete('/v1/apresentadoras/:id', { preHandler: writeAccess }, async (request, reply) => {
    const { tenant_id } = request.user
    return app.withTenant(tenant_id, async (db) => {
      await db.query('BEGIN')
      try {
        const apresentadoraId = await resolvePresenterId(db, tenant_id, request.params.id)
        if (!apresentadoraId) { await db.query('ROLLBACK'); return reply.code(404).send({ error: 'Apresentadora não encontrada' }) }
        const profileRef = await db.query(`SELECT user_id FROM apresentadoras WHERE id=$1::uuid AND tenant_id=$2::uuid`, [apresentadoraId, tenant_id])
        const userId = profileRef.rows[0]?.user_id
        let lockedUser = null
        if (userId) {
          const user = await db.query(`SELECT id, papel FROM users WHERE id=$1::uuid AND tenant_id=$2::uuid FOR UPDATE`, [userId, tenant_id])
          lockedUser = user.rows[0] ?? null
          if (!lockedUser || !isPresenterRole(lockedUser.papel)) {
            await db.query('ROLLBACK')
            return reply.code(409).send({ error: 'Perfil vinculado a usuário inválido. Corrija o vínculo em Usuários.' })
          }
        }
        const profile = await db.query(`SELECT user_id FROM apresentadoras WHERE id=$1::uuid AND tenant_id=$2::uuid FOR UPDATE`, [apresentadoraId, tenant_id])
        if (!profile.rows[0] || (profile.rows[0].user_id ?? null) !== (lockedUser?.id ?? null)) {
          await db.query('ROLLBACK')
          return reply.code(409).send({ error: 'O vínculo de apresentadora foi alterado. Tente novamente.' })
        }
        const result = await db.query(`UPDATE apresentadoras SET ativo=false WHERE id=$1::uuid AND tenant_id=$2::uuid RETURNING id`, [apresentadoraId, tenant_id])
        if (!result.rows[0]) { await db.query('ROLLBACK'); return reply.code(404).send({ error: 'Apresentadora não encontrada' }) }
        const lockedUserId = lockedUser?.id ?? null
        if (lockedUserId) {
          await db.query(`UPDATE users SET ativo=false, token_version=token_version+1 WHERE id=$1::uuid AND tenant_id=$2::uuid`, [lockedUserId, tenant_id])
          await db.query('DELETE FROM refresh_tokens WHERE user_id=$1::uuid', [lockedUserId])
        }
        await db.query('COMMIT')
        if (lockedUserId) app.invalidateTokenVersionCache?.(lockedUserId)
        app.audit?.log?.(request, { action: 'apresentadora.delete', entity_type: 'apresentadora', entity_id: apresentadoraId, metadata: { soft_delete: true } })?.catch(err => app.log.error({ err }, 'audit log failed'))
        return reply.code(204).send()
      } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error }
    })
  })
}
