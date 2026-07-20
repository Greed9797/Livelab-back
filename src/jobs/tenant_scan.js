// Varredura cross-tenant segura sob RLS.
//
// Problema: os crons descobrem trabalho varrendo tabelas com RLS
// (agenda_eventos, vendas_atribuidas, lives) via `app.db.query`, sem tenant no
// contexto. As policies são `tenant_id = current_setting('app.tenant_id', true)::uuid`
// — com a GUC ausente o lado direito é NULL, a comparação é NULL, e a varredura
// devolve ZERO linhas. No dia em que a RLS for aplicada esses jobs param de
// funcionar EM SILÊNCIO (nenhum erro, só nada acontecendo).
//
// Solução: iterar tenant a tenant, cada varredura dentro de uma transação com
// seu próprio `set_config(..., true)` (local — reverte no COMMIT).
//
// Alternativa descartada: policy com escape de sistema, tipo
//   USING (tenant_id = current_setting('app.tenant_id', true)::uuid
//          OR current_setting('app.is_system_job', true) = 'on')
// A GUC é setável por qualquer conexão do próprio role da aplicação, inclusive
// de dentro de uma rota. Um único ponto de injeção de SQL, ou um `set_config`
// esquecido numa conexão devolvida ao pool, vira bypass TOTAL de tenant em todas
// as tabelas de uma vez — exatamente o modo de falha que a RLS existe pra
// impedir. A varredura por tenant não tem esse buraco e o custo (N round-trips)
// cai num job de background, não no caminho de request.
//
// `tenants` não tem coluna tenant_id nem RLS, então a listagem roda no pool de
// sistema normalmente.
//
// Nota: LIMIT na query passada passa a valer POR TENANT, não global.

/**
 * Roda `sql` uma vez por tenant, com contexto RLS setado, e concatena as linhas.
 * Falha de um tenant não derruba os demais (loga warn e segue).
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {string} sql
 * @param {Array} [params]
 * @param {string} [label] prefixo de log
 * @returns {Promise<Array<Object>>}
 */
export async function scanPorTenant(app, sql, params = [], label = '[scan por tenant]') {
  const tenantsQ = await app.db.query('SELECT id FROM tenants ORDER BY id')
  const linhas = []

  for (const { id: tenantId } of tenantsQ.rows) {
    const client = await app.db.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.tenant_id', $1::text, true)`, [tenantId])
      const r = await client.query(sql, params)
      await client.query('COMMIT')
      for (const row of r.rows) linhas.push(row)
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      app.log?.warn?.({ err, tenant_id: tenantId }, `${label} varredura falhou neste tenant`)
    } finally {
      client.release()
    }
  }

  return linhas
}
