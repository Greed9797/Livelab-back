import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authPlugin } from '../src/plugins/auth.js'
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
