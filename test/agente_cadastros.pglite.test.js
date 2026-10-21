import Fastify from 'fastify'
import fp from 'fastify-plugin'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { auditLogPlugin } from '../src/plugins/audit_log.js'
import { cadastrosRoutes } from '../src/routes/cadastros.js'
import { authPlugin, hashDaChave } from '../src/plugins/auth.js'

const tenant = '11111111-1111-4111-8111-111111111111'
const otherTenant = '22222222-2222-4222-8222-222222222222'
const marca = '33333333-3333-4333-8333-333333333333'
const cliente = '44444444-4444-4444-8444-444444444444'
const outraMarca = '55555555-5555-4555-8555-555555555555'
const outraCliente = '66666666-6666-4666-8666-666666666666'
const keyId = '77777777-7777-4777-8777-777777777777'
const chave = 'llk_agente-cadastros-de-teste-com-tamanho-suficiente'

process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'x'.repeat(48)

let db
let app

async function buildApp({ falharAuditoria = false } = {}) {
  app = Fastify()
  await app.register(fp(async (instancia) => instancia.decorate('db', db), { name: 'db' }))
  await app.register(authPlugin)
  app.decorate('withTenant', async (_tenantId, fn) => fn(db))
  app.setErrorHandler((error, _request, reply) => reply.code(500).send({ error: error.message }))
  if (falharAuditoria) {
    app.decorate('audit', { log: async () => { throw new Error('falha de auditoria') } })
  } else {
    await app.register(auditLogPlugin)
  }
  await app.register(cadastrosRoutes)
}

beforeEach(async () => {
  try {
    db = new PGlite()
    await db.exec(`
    CREATE TABLE marcas (
      id uuid, tenant_id uuid, cliente_id uuid, nome text, tipo text, status text, sistema boolean,
      site text, marketplace_url text, tiktok_username text, logo_url text, cor text,
      atualizado_em timestamptz, criado_em timestamptz
    );
    CREATE TABLE clientes (
      id uuid, tenant_id uuid, nome text, celular text, email text, cpf text, cnpj text,
      razao_social text, nicho text, fat_anual numeric, cidade text, estado text, cep text,
      vende_tiktok boolean, site text, tiktok_username text, logo_url text, atualizado_em timestamptz
    );
    CREATE TABLE audit_log (
      tenant_id uuid, user_id uuid, action text, entity_type text, entity_id uuid,
      metadata jsonb, ip text, user_agent text
    );
    CREATE TABLE api_keys (
      id uuid, tenant_id uuid, nome text, key_hash text, criado_por uuid, papel text,
      revogada_em timestamptz, expira_em timestamptz, ultimo_uso timestamptz
    );
    INSERT INTO api_keys (id, tenant_id, nome, key_hash, papel)
    VALUES ('${keyId}','${tenant}','agente de contratos','${hashDaChave(chave)}','automacao_cadastros');
    INSERT INTO clientes VALUES
      ('${cliente}','${tenant}','Marca Um','47999999999','um@marca.test','111','222','Marca Um LTDA','beleza',100,'Blumenau','SC','89000-000',true,'https://um.test','marcaum','https://img.test/um.png',NOW()),
      ('${outraCliente}','${otherTenant}','Marca Dois','48999999999','dois@marca.test','333','444','Marca Dois LTDA','moda',200,'Joinville','SC','89200-000',false,'https://dois.test','marcadois','https://img.test/dois.png',NOW());
    INSERT INTO marcas VALUES
      ('${marca}','${tenant}','${cliente}','Marca Um','cliente','ativa',false,'https://um.test','https://market.test/um',NULL,'https://img.test/um.png','#112233',NOW(),NOW()),
      ('${outraMarca}','${otherTenant}','${outraCliente}','Marca Dois','cliente','ativa',false,'https://dois.test','https://market.test/dois',NULL,'https://img.test/dois.png','#445566',NOW(),NOW());
    `)
  } catch (error) {
    throw new Error(`fixture PGlite: ${error.message}`)
  }
})

afterEach(async () => {
  if (app) await app.close()
  if (db) await db.close()
  app = null
  db = null
})

describe('automação cadastral em PostgreSQL real', () => {
  it('isola tenant, entrega somente o DTO permitido e audita a correção na mesma transação', async () => {
    await buildApp()
    const list = await app.inject({ method: 'GET', url: '/v1/cadastros', headers: { 'x-api-key': chave } })
    if (list.statusCode !== 200) throw new Error(list.body)
    expect(list.statusCode).toBe(200)
    expect(list.headers['cache-control']).toBe('private, no-store')
    expect(list.json()).toHaveLength(1)
    expect(Object.keys(list.json()[0]).sort()).toEqual([
      'celular', 'cep', 'cidade', 'cliente_id', 'cnpj', 'cor', 'cpf', 'email', 'estado',
      'fat_anual', 'id', 'logo_url', 'marca_id', 'marketplace_url', 'nicho', 'nome',
      'razao_social', 'site', 'tiktok_username', 'vende_tiktok',
    ])

    const patch = await app.inject({
      method: 'PATCH', url: `/v1/cadastros/${marca}`, headers: { 'x-api-key': chave },
      payload: {
        nome: 'Marca Um Corrigida', celular: '47000000000', email: 'novo@marca.test', cpf: '999', cnpj: '888',
        razao_social: 'Marca Nova LTDA', nicho: 'casa', fat_anual: 0, cidade: 'Gaspar', estado: 'SC', cep: '89110-000',
        vende_tiktok: false, site: 'https://nova.test', marketplace_url: 'https://market.test/nova',
        tiktok_username: 'marcanova', logo_url: 'https://img.test/nova.png', cor: '#abcdef',
        referencia_documento: 'Contrato renovado 2026',
      },
    })
    if (patch.statusCode !== 200) throw new Error(patch.body)
    expect(patch.statusCode).toBe(200)
    expect(patch.headers['cache-control']).toBe('private, no-store')
    const corrigido = patch.json()
    const esperado = {
      nome: 'Marca Um Corrigida', celular: '47000000000', email: 'novo@marca.test', cpf: '999', cnpj: '888',
      razao_social: 'Marca Nova LTDA', nicho: 'casa', fat_anual: 0, cidade: 'Gaspar', estado: 'SC', cep: '89110-000',
      vende_tiktok: false, site: 'https://nova.test', marketplace_url: 'https://market.test/nova',
      tiktok_username: 'marcanova', logo_url: 'https://img.test/nova.png', cor: '#abcdef',
    }
    if (Object.entries(esperado).some(([campo, valor]) => corrigido[campo] !== valor)) throw new Error(JSON.stringify(corrigido))
    expect(corrigido).toMatchObject(esperado)
    const clienteCorrigido = (await db.query(`SELECT nome, cpf, cnpj, fat_anual, vende_tiktok FROM clientes WHERE id = '${cliente}'`)).rows[0]
    expect(clienteCorrigido).toMatchObject({ nome: 'Marca Um Corrigida', cpf: '999', cnpj: '888', vende_tiktok: false })
    expect(Number(clienteCorrigido.fat_anual)).toBe(0)
    const audit = (await db.query('SELECT user_id, action, metadata FROM audit_log')).rows[0]
    expect(audit.action).toBe('cadastro.update_by_contract_agent')
    expect(audit.metadata.referencia_documento).toBe('Contrato renovado 2026')
    expect(audit.metadata.antes.cpf).toBe('[redacted]')
    expect(audit.metadata.depois.cnpj).toBe('[redacted]')
    expect(Object.keys(audit.metadata.antes).sort()).toHaveLength(17)
    expect(audit.user_id).toBe(keyId)

    const other = await app.inject({ method: 'PATCH', url: `/v1/cadastros/${outraMarca}`, headers: { 'x-api-key': chave }, payload: { nome: 'Invadida', referencia_documento: 'Contrato' } })
    if (other.statusCode !== 404) throw new Error(other.body)
    expect(other.statusCode).toBe(404)
    expect((await db.query(`SELECT nome FROM marcas WHERE id = '${outraMarca}'`)).rows[0].nome).toBe('Marca Dois')

    const proibido = await app.inject({
      method: 'PATCH', url: `/v1/cadastros/${marca}`, headers: { 'x-api-key': chave },
      payload: { referencia_documento: 'Contrato', status: 'inativa' },
    })
    expect(proibido.statusCode).toBe(403)
    expect(proibido.headers['cache-control']).toBe('private, no-store')
  })

  it('desfaz a alteração quando a auditoria estrita falha', async () => {
    await buildApp({ falharAuditoria: true })
    const response = await app.inject({ method: 'PATCH', url: `/v1/cadastros/${marca}`, headers: { 'x-api-key': chave }, payload: { nome: 'Não deve persistir', referencia_documento: 'Contrato' } })
    expect(response.statusCode).toBe(500)
    expect((await db.query(`SELECT nome FROM marcas WHERE id = '${marca}'`)).rows[0].nome).toBe('Marca Um')
  })
})
