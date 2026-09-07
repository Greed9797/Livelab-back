import assert from 'node:assert/strict'
import Fastify from 'fastify'

// Descartável: valida a sincronização de identidade contra SQL real, sem dados
// de produção. Execute com PGLITE_MODULE apontando para a instalação isolada.
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')
const { apresentadorasRoutes } = await import('../src/routes/apresentadoras.js')

const tenantId = '00000000-0000-0000-0000-000000000001'
const presenterId = '00000000-0000-0000-0000-000000000011'
const userId = '00000000-0000-0000-0000-000000000021'
const db = new PGlite()

await db.exec(`
  CREATE TABLE users (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, nome text NOT NULL, email text NOT NULL,
    papel text NOT NULL, ativo boolean NOT NULL DEFAULT true, token_version integer NOT NULL DEFAULT 1
  );
  CREATE TABLE apresentadoras (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid UNIQUE, nome text NOT NULL,
    telefone text, cargo text, email text, cpf_cnpj text, cidade text, ativo boolean NOT NULL DEFAULT true,
    arquivada boolean NOT NULL DEFAULT false, fixo numeric NOT NULL DEFAULT 2700, comissao_pct numeric NOT NULL DEFAULT 0,
    foto_url text, observacoes text, link_contrato text, data_aniversario text, data_inicio text, data_fim text,
    origem_dados text, criado_em timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE refresh_tokens (user_id uuid NOT NULL, token text NOT NULL);
  INSERT INTO users (id, tenant_id, nome, email, papel) VALUES
    ('${userId}', '${tenantId}', 'Ana antiga', 'ana@old.test', 'apresentadora');
  INSERT INTO apresentadoras (id, tenant_id, user_id, nome, email, fixo) VALUES
    ('${presenterId}', '${tenantId}', '${userId}', 'Ana antiga', 'ana@old.test', 3100);
  INSERT INTO refresh_tokens (user_id, token) VALUES ('${userId}', 'session-before-change');
`)

const app = Fastify()
app.decorate('authenticate', async (request) => {
  request.user = { tenant_id: tenantId, sub: '00000000-0000-0000-0000-000000000099', papel: 'franqueado' }
})
app.decorate('requirePapel', () => async () => {})
app.decorate('withTenant', async (_tenant, fn) => fn({ query: (...args) => db.query(...args) }))
const invalidated = []
app.decorate('invalidateTokenVersionCache', (id) => invalidated.push(id))
await app.register(apresentadorasRoutes)

const changed = await app.inject({
  method: 'PATCH', url: `/v1/apresentadoras/${presenterId}`,
  payload: { nome: 'Ana atualizada', email: 'ana@new.test', ativo: false },
})
assert.equal(changed.statusCode, 200, changed.body)
const user = await db.query('SELECT nome, email, ativo, token_version FROM users WHERE id=$1', [userId])
assert.deepEqual(user.rows, [{ nome: 'Ana atualizada', email: 'ana@new.test', ativo: false, token_version: 2 }])
const profile = await db.query('SELECT nome, email, ativo, fixo FROM apresentadoras WHERE id=$1', [presenterId])
assert.deepEqual(profile.rows, [{ nome: 'Ana atualizada', email: 'ana@new.test', ativo: false, fixo: '3100' }])
assert.equal((await db.query('SELECT * FROM refresh_tokens WHERE user_id=$1', [userId])).rows.length, 0)
assert.deepEqual(invalidated, [userId])

const deleted = await app.inject({ method: 'DELETE', url: `/v1/apresentadoras/${presenterId}` })
assert.equal(deleted.statusCode, 204)
const states = await db.query(`SELECT u.ativo AS user_ativo, u.token_version, a.ativo AS profile_ativo
  FROM users u JOIN apresentadoras a ON a.user_id=u.id WHERE u.id=$1`, [userId])
assert.deepEqual(states.rows, [{ user_ativo: false, token_version: 3, profile_ativo: false }])

console.log(JSON.stringify({ verified: true, scenarios: ['combined-email-and-deactivation-syncs-and-revokes', 'profile-deactivation-revokes-login'] }))
await app.close()
await db.close()
