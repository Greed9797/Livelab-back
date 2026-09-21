import bcrypt from 'bcrypt'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authPlugin } from '../src/plugins/auth.js'
import { authRoutes } from '../src/routes/auth.js'
import { usuariosRoutes } from '../src/routes/usuarios.js'
const tenant='11111111-1111-4111-8111-111111111111'
const actor='22222222-2222-4222-8222-222222222222'
const target='33333333-3333-4333-8333-333333333333'
const apps=[]
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));vi.unstubAllEnvs()})
async function authenticated(query){
 vi.stubEnv('JWT_SECRET','synthetic-local-session-state-test-key-2026')
 const app=Fastify();apps.push(app);app.decorate('db',{query});await authPlugin(app)
 app.get('/protected',{preHandler:[app.authenticate,app.requirePapel(['gerente'])]},async()=>({allowed:true}))
 const token=app.jwt.sign({sub:actor,tenant_id:tenant,papel:'gerente',token_version:1})
 return {app,headers:{authorization:`Bearer ${token}`}}
}
const current={token_version:1,ativo:true,papel:'gerente',tenant_id:tenant}
describe('current session authorization',()=>{
 it.each([
  ['missing',null],['inactive',{...current,ativo:false}],['demoted',{...current,papel:'operacional'}],
  ['different tenant',{...current,tenant_id:target}],['revoked',{...current,token_version:2}],
 ])('rejects %s even with a valid signed JWT',async(_label,state)=>{
  const {app,headers}=await authenticated(async()=>({rows:state?[state]:[]}))
  expect((await app.inject({url:'/protected',headers})).statusCode).toBe(401)
 })
 it('fails closed with a retryable error when database authorization fails',async()=>{
  const {app,headers}=await authenticated(async()=>{throw new Error('synthetic failure')})
  expect((await app.inject({url:'/protected',headers})).statusCode).toBe(503)
 })
 it('keeps active authorized sessions and invalidates cached state explicitly',async()=>{
  let state={...current};const query=vi.fn(async()=>({rows:[state]}))
  const {app,headers}=await authenticated(query)
  expect((await app.inject({url:'/protected',headers})).statusCode).toBe(200)
  state={...current,token_version:2};app.invalidateTokenVersionCache(actor)
  expect((await app.inject({url:'/protected',headers})).statusCode).toBe(401)
  expect(query).toHaveBeenCalledTimes(2)
 })
})
async function usersApp(query){
 const app=Fastify();apps.push(app)
 app.decorate('authenticate',async req=>{req.user={sub:actor,tenant_id:tenant,papel:'franqueador_master'}})
 app.decorate('requirePapel',()=>app.authenticate)
 app.decorate('withTenant',async(_tenant,fn)=>fn({query}))
 app.decorate('invalidateTokenVersionCache',vi.fn())
 await app.register(usuariosRoutes);return app
}
describe('user deactivation session boundary',()=>{
 it.each([{ativo:false},{papel:'operacional'}])('revokes existing access and refresh sessions for permission changes %j',async(payload)=>{
  const calls=[]
  const app=await usersApp(async(sql,params)=>{
   calls.push([sql,params])
   if(sql.includes('SELECT id, nome, email, papel, ativo'))return {rows:[{id:target,nome:'Fixture',email:'fixture@example.test',papel:'gerente',ativo:true}]}
   if(sql.includes('UPDATE users SET'))return {rows:[{id:target,papel:payload.papel??'gerente',ativo:payload.ativo??true}]}
   return {rows:[]}
  })
  const response=await app.inject({method:'PATCH',url:`/v1/usuarios/${target}`,payload})
  expect(response.statusCode).toBe(200)
  expect(calls.find(([sql])=>sql.includes('UPDATE users SET'))[0]).toMatch(/token_version = token_version \+ 1/)
  expect(calls.some(([sql])=>sql.includes('DELETE FROM refresh_tokens'))).toBe(true)
  expect(calls.at(-1)[0]).toBe('COMMIT')
  expect(app.invalidateTokenVersionCache).toHaveBeenCalledWith(target)
 })
 it('does not revoke another unit refresh tokens when the target is absent',async()=>{
  const query=vi.fn(async()=>({rows:[]}));const app=await usersApp(query)
  expect((await app.inject({method:'DELETE',url:`/v1/usuarios/${target}`})).statusCode).toBe(404)
  expect(query.mock.calls.some(([sql])=>sql.includes('refresh_tokens'))).toBe(false)
  expect(query.mock.calls.at(-1)[0]).toBe('ROLLBACK')
 })
 it('commits deactivation and refresh revocation before clearing the cache',async()=>{
  const calls=[];const app=await usersApp(async(sql)=>{calls.push(sql);return {rows:sql.includes('UPDATE users')?[{id:target}]:[]}})
  expect((await app.inject({method:'DELETE',url:`/v1/usuarios/${target}`})).statusCode).toBe(204)
  expect(calls[1]).toMatch(/token_version = token_version \+ 1/)
  expect(calls.some(sql=>/DELETE FROM refresh_tokens/.test(sql))).toBe(true)
  expect(calls.at(-1)).toBe('COMMIT')
  expect(app.invalidateTokenVersionCache).toHaveBeenCalledWith(target)
 })
 it('rolls back when session revocation fails',async()=>{
  const calls=[];const app=await usersApp(async(sql)=>{calls.push(sql);if(sql.includes('refresh_tokens'))throw new Error('synthetic failure');return {rows:sql.includes('UPDATE users')?[{id:target}]:[]}})
  expect((await app.inject({method:'DELETE',url:`/v1/usuarios/${target}`})).statusCode).toBe(500)
  expect(calls.at(-1)).toBe('ROLLBACK')
  expect(app.invalidateTokenVersionCache).not.toHaveBeenCalled()
 })
 it('reset password invalidates access and refresh sessions in one transaction',async()=>{
  const calls=[];const app=await usersApp(async(sql)=>{calls.push(sql);return {rows:sql.includes('UPDATE users SET senha_hash')?[{id:target,token_version:2}]:[]}})
  const response=await app.inject({method:'POST',url:`/v1/usuarios/${target}/reset-senha`})
  expect(response.statusCode).toBe(200)
  expect(calls[0]).toBe('BEGIN')
  expect(calls[1]).toMatch(/token_version\s*=\s*token_version\s*\+\s*1/)
  expect(calls[2]).toMatch(/DELETE FROM refresh_tokens/)
  expect(calls.at(-1)).toBe('COMMIT')
  expect(app.invalidateTokenVersionCache).toHaveBeenCalledWith(target)
  expect(response.headers['cache-control']).toBe('no-store')
 })
})

describe('self-service password change', () => {
 it('logs in case-insensitively and kills the access token used to change the password', async () => {
  vi.stubEnv('JWT_SECRET', 'synthetic-local-session-state-test-key-2026')
  vi.stubEnv('NODE_ENV', 'test')
  const email = 'Ada@example.test'
  const senhaAtual = 'Senha1234'
  const novaSenha = 'NovaSenha9'
  const user = {
   id: actor, tenant_id: tenant, papel: 'gerente', nome: 'Ada', email, ativo: true,
   senha_hash: await bcrypt.hash(senhaAtual, 4), token_version: 1, onboarding_completed: false,
  }
  const refresh = []
  const sqls = []
  const query = async (sql, params = []) => {
   sqls.push(sql)
   if (sql.includes('FROM users u JOIN tenants')) {
    const informado = String(params[0] ?? '')
    const casa = /LOWER\(u\.email\)\s*=\s*LOWER\(\$1\)/.test(sql) && /ativo\s*=\s*true/.test(sql)
     ? user.email.toLowerCase() === informado.toLowerCase()
     : user.email === informado
    return { rows: user.ativo && casa ? [{ ...user, tenant_nome: 'Unidade' }] : [] }
   }
   if (sql.includes('INSERT INTO refresh_tokens')) {
    refresh.push({ user_id: params[0], token_hash: params[1], revogado: false })
    return { rows: [], rowCount: 1 }
   }
   if (sql.includes('SELECT token_version, ativo')) {
    return { rows: [{ token_version: user.token_version, ativo: user.ativo, papel: user.papel, tenant_id: user.tenant_id }] }
   }
   if (sql.includes('SELECT id, senha_hash FROM users')) {
    return { rows: user.ativo ? [{ id: user.id, senha_hash: user.senha_hash }] : [] }
   }
   if (sql.includes('UPDATE users') && sql.includes('senha_hash')) {
    user.senha_hash = params[0]
    if (/token_version\s*=\s*token_version\s*\+\s*1/.test(sql)) user.token_version += 1
    return { rows: [], rowCount: 1 }
   }
   if (sql.includes('UPDATE refresh_tokens SET revogado = true WHERE user_id')) {
    for (const row of refresh) if (row.user_id === params[0]) row.revogado = true
    return { rows: [], rowCount: refresh.length }
   }
   if (sql.includes('FROM refresh_tokens rt JOIN users')) {
    const revogado = /revogado\s*=\s*true/.test(sql)
    const row = refresh.find((item) => item.token_hash === params[0] && item.revogado === revogado)
    return { rows: row ? [{ ...user, user_id: user.id, token_version: user.token_version }] : [] }
   }
   return { rows: [], rowCount: 0 }
  }
  const app = Fastify(); apps.push(app)
  app.decorate('db', { query })
  await authPlugin(app)
  await app.register(authRoutes)
  app.get('/protected', { preHandler: app.authenticate }, async () => ({ ok: true }))

  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'ada@example.test', senha: senhaAtual } })
  expect(login.statusCode).toBe(200)
  const antigo = login.json().access_token
  const refreshAntigo = login.json().refresh_token
  expect((await app.inject({ url: '/protected', headers: { authorization: `Bearer ${antigo}` } })).statusCode).toBe(200)

  const troca = await app.inject({
   method: 'PATCH', url: '/v1/auth/senha', headers: { authorization: `Bearer ${antigo}` },
   payload: { senha_atual: senhaAtual, nova_senha: novaSenha },
  })
  expect(troca.statusCode).toBe(200)
  expect(troca.json()).toEqual({ ok: true })
  expect(sqls.some((sql) => sql.includes('senha_hash') && /token_version\s*=\s*token_version\s*\+\s*1/.test(sql))).toBe(true)
  expect((await app.inject({ url: '/protected', headers: { authorization: `Bearer ${antigo}` } })).statusCode).toBe(401)

  const deNovo = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'ada@example.test', senha: novaSenha } })
  expect(deNovo.statusCode).toBe(200)
  const novo = deNovo.json().access_token
  expect(novo).not.toBe(antigo)
  expect((await app.inject({ url: '/protected', headers: { authorization: `Bearer ${novo}` } })).statusCode).toBe(200)
  expect((await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refresh_token: refreshAntigo } })).statusCode).toBe(401)
 })
})
