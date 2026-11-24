// Cliente excluído (clientes.deleted_at) sai da carteira: o DELETE não muda
// clientes.status, então sem o filtro ele voltava em ?status=all como "ativo" e o
// detalhe respondia 404 "Cliente não encontrado".
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getClienteOperacional } from '../src/lib/operacional.js'
import { listarCadastros, obterCadastro } from '../src/services/cadastros.js'

const tenant = '11111111-1111-4111-8111-111111111111'
const outroTenant = '22222222-2222-4222-8222-222222222222'
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const cli = { ativo: uuid(1), arquivado: uuid(2), excluido: uuid(3), outroTenant: uuid(4) }
const marca = {
  ativo: uuid(11), arquivado: uuid(12), excluido: uuid(13), outroTenant: uuid(14),
  afiliada: uuid(15), propriaDoExcluido: uuid(16),
}

let db

beforeEach(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE clientes (
      id uuid, tenant_id uuid, nome text, status text, celular text, email text, cnpj text, razao_social text,
      nicho text, cidade text, estado text, site text, logo_url text, tiktok_username text,
      gateway_customer_id text, user_id uuid, deleted_at timestamptz
    );
    CREATE TABLE marcas (
      id uuid, tenant_id uuid, cliente_id uuid, nome text, tipo text, status text, sistema boolean, site text,
      marketplace_url text, tiktok_username text, logo_url text, cor text, data_inicio date, data_fim date,
      observacoes text, origem_dados text, criado_em timestamptz DEFAULT now(), atualizado_em timestamptz
    );
    CREATE TABLE users (id uuid, tenant_id uuid, papel text, email text, ativo boolean);
    CREATE TABLE marca_condicoes_comerciais (
      id uuid, tenant_id uuid, marca_id uuid, inicio_vigencia date, revision int, cancelled_at timestamptz,
      fixo_mensal numeric, comissao_franquia_pct numeric, tipo_cobranca text, fixo_confirmado boolean,
      comissao_confirmada boolean, origem text
    );
    CREATE TABLE apresentadoras (id uuid, tenant_id uuid, nome text, ativo boolean, arquivada boolean);
    CREATE TABLE apresentadora_marcas (
      tenant_id uuid, marca_id uuid, apresentadora_id uuid, papel text, comissao_video_pct numeric, ativo boolean
    );
    CREATE TABLE lives (
      id uuid, tenant_id uuid, marca_id uuid, status text, iniciado_em timestamptz, ads_gmv numeric,
      manual_gmv numeric, fat_gerado numeric, uniao_destino_id uuid, uniao_desfeita_em timestamptz,
      arquivada_em timestamptz
    );
    CREATE TABLE video_registros (tenant_id uuid, marca_id uuid, data date, gmv_atribuido numeric);

    INSERT INTO clientes (id, tenant_id, nome, status, deleted_at) VALUES
      ('${cli.ativo}', '${tenant}', 'Cliente Ativo', 'ativo', NULL),
      ('${cli.arquivado}', '${tenant}', 'Cliente Arquivado', 'arquivado', NULL),
      ('${cli.excluido}', '${tenant}', 'Cliente Para Testes', 'ativo', now()),
      ('${cli.outroTenant}', '${outroTenant}', 'Cliente Alheio', 'ativo', NULL);
    INSERT INTO marcas (id, tenant_id, cliente_id, nome, tipo, status) VALUES
      ('${marca.ativo}', '${tenant}', '${cli.ativo}', 'Cliente Ativo', 'cliente', 'ativa'),
      ('${marca.arquivado}', '${tenant}', '${cli.arquivado}', 'Cliente Arquivado', 'cliente', 'arquivada'),
      ('${marca.excluido}', '${tenant}', '${cli.excluido}', 'Cliente Para Testes', 'cliente', 'arquivada'),
      ('${marca.outroTenant}', '${outroTenant}', '${cli.outroTenant}', 'Cliente Alheio', 'cliente', 'ativa'),
      ('${marca.afiliada}', '${tenant}', NULL, 'Afiliada', 'afiliada', 'ativa'),
      ('${marca.propriaDoExcluido}', '${tenant}', '${cli.excluido}', 'Marca Própria', 'propria', 'ativa');
  `)
})

afterEach(() => db.close())

const ids = async (filtros = {}) => (await listarCadastros(db, { tenantId: tenant, ...filtros }))
  .map((c) => c.marca_id).sort()

describe('cliente excluído na lista de cadastros', () => {
  it('não volta em nenhuma visão (todos, inativos, arquivados ou busca)', async () => {
    expect(await ids({ status: 'all' })).not.toContain(marca.excluido)
    expect(await ids({ status: 'arquivada' })).not.toContain(marca.excluido)
    expect(await ids({ status: 'all', tipo: 'cliente' })).not.toContain(marca.excluido)
    expect(await ids({ status: 'all', q: 'teste' })).toEqual([])
    expect(await ids()).not.toContain(marca.excluido)
  })

  it('toda linha de cliente listada abre o detalhe', async () => {
    const clientes = (await listarCadastros(db, { tenantId: tenant, status: 'all' })).filter((c) => c.cliente_id)
    expect(clientes).not.toHaveLength(0)
    for (const { cliente_id: clienteId } of clientes) {
      // Só a 1ª consulta decide o 404; as demais são métricas, fora deste teste.
      const primeira = { query: async (sql, params) => {
        const r = await db.query(sql, params)
        if (r.rows.length > 0) throw new Error('encontrado')
        return r
      } }
      await expect(getClienteOperacional(primeira, { tenantId: tenant, clienteId })).rejects.toThrow('encontrado')
    }
  })

  it('mantém ativos, arquivados, marcas sem ficha e marca não-cliente ligada ao excluído', async () => {
    expect(await ids({ status: 'all' })).toEqual(
      [marca.ativo, marca.arquivado, marca.afiliada, marca.propriaDoExcluido].sort(),
    )
    expect(await ids({ status: 'arquivada' })).toEqual([marca.arquivado])
    expect(await ids()).toEqual([marca.ativo, marca.afiliada, marca.propriaDoExcluido].sort())
  })

  it('consulta direta por id continua devolvendo o histórico como arquivada', async () => {
    expect((await obterCadastro(db, { tenantId: tenant, id: marca.excluido })).status_operacional).toBe('arquivada')
  })
})
