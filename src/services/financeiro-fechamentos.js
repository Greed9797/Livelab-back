import { calcularDreMes, hojeSaoPaulo } from './financeiro-agregador.js'

const erro = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode })

export async function consultarFechamento(db, { tenantId, mes }) {
  const { rows } = await db.query(`
    SELECT id, to_char(competencia, 'YYYY-MM') AS mes, versao, evento,
           snapshot, motivo, ator_id, criado_em
      FROM financeiro_fechamentos
     WHERE tenant_id = $1::uuid AND competencia = $2::date
     ORDER BY versao ASC, CASE evento WHEN 'fechamento' THEN 0 ELSE 1 END
  `, [tenantId, `${mes}-01`])
  const ultimo = rows.at(-1) ?? null
  return {
    mes,
    estado: !ultimo ? 'aberto' : ultimo.evento === 'fechamento' ? 'fechado' : 'reaberto',
    versao_atual: ultimo?.versao ?? 0,
    versoes: rows.filter((r) => r.evento === 'fechamento'),
    eventos: rows,
  }
}

export async function mudarFechamento(db, {
  tenantId, mes, actorUserId, evento, motivo = null, hoje = hojeSaoPaulo(),
  calcular = calcularDreMes,
}) {
  if (!actorUserId) throw erro('Usuário autenticado obrigatório', 401)
  if (!['fechamento', 'reabertura'].includes(evento)) throw erro('Evento inválido', 400)
  if (evento === 'reabertura' && !String(motivo ?? '').trim()) throw erro('Motivo obrigatório', 400)
  // O DRE consulta várias tabelas: todas devem refletir o mesmo instante.
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
  try {
    // A row lock serializes every close/reopen of this tenant, including first close.
    const lock = await db.query('SELECT id FROM tenants WHERE id = $1::uuid FOR UPDATE', [tenantId])
    if (lock.rows.length !== 1) throw erro('Tenant não encontrado', 404)
    const atual = await consultarFechamento(db, { tenantId, mes })
    if (evento === 'fechamento' && atual.estado === 'fechado') throw erro('Competência já fechada')
    if (evento === 'reabertura' && atual.estado !== 'fechado') throw erro('Competência não está fechada')
    const versao = evento === 'fechamento' ? atual.versao_atual + 1 : atual.versao_atual
    const snapshot = evento === 'fechamento'
      ? await calcular(db, { tenantId, mes, hoje })
      : null
    const { rows: [registro] } = await db.query(`
      INSERT INTO financeiro_fechamentos
        (tenant_id, competencia, versao, evento, snapshot, motivo, ator_id)
      VALUES ($1::uuid, $2::date, $3, $4, $5::jsonb, $6, $7::uuid)
      RETURNING id
    `, [tenantId, `${mes}-01`, versao, evento, snapshot && JSON.stringify(snapshot), motivo, actorUserId])
    await db.query(`
      INSERT INTO audit_log (tenant_id, user_id, action, entity_type, entity_id, metadata)
      VALUES ($1::uuid, $2::uuid, $3, 'financeiro_fechamento', $4::uuid, $5::jsonb)
    `, [tenantId, actorUserId, `financeiro.${evento}`, registro.id,
      JSON.stringify({ mes, versao, ...(motivo ? { motivo } : {}) })])
    const resultado = await consultarFechamento(db, { tenantId, mes })
    await db.query('COMMIT')
    return resultado
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  }
}
