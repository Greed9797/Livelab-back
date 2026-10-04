import { describe, expect, it, vi } from 'vitest'
import {
  CadastroError,
  atualizarCadastro,
  criarCadastro,
  mapCadastroRow,
  promoverACliente,
  resolverCadastroId,
} from '../src/services/cadastros.js'
import { cadastroColsSql, cadastroFromSql } from '../src/lib/cadastro-sql.js'
import { marcaStatusOperacionalSql } from '../src/lib/entity-status.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const marcaId = '22222222-2222-4222-8222-222222222222'
const clienteId = '33333333-3333-4333-8333-333333333333'

function fakeDb(handler) {
  const query = vi.fn(async (sql, params) => (await handler(sql, params)) ?? { rows: [] })
  return { query }
}

describe('cadastro-sql', () => {
  it('ficha só é juntada para marca tipo cliente e com tenant explícito', () => {
    const from = cadastroFromSql('$1')
    expect(from).toMatch(/LEFT JOIN clientes c\s+ON c\.id = m\.cliente_id AND c\.tenant_id = m\.tenant_id AND m\.tipo = 'cliente'/)
    expect(from).toContain('tenant_id = $1::uuid AND marca_id = m.id')
  })

  it('colunas do contrato público', () => {
    const cols = cadastroColsSql()
    for (const alias of ['AS id', 'AS marca_id', 'AS cliente_id', 'AS sistema', 'AS gera_receita',
      'AS status_operacional', 'AS status_comercial', 'AS tiktok_username', 'AS acesso_email',
      'c.gateway_customer_id', 'AS apresentadoras']) {
      expect(cols).toContain(alias)
    }
    // gera_receita = mesma regra de receita-marca-sql (marcaGeraReceitaSql)
    expect(cols).toContain("m.tipo = 'cliente' AND COALESCE(m.sistema, false) = false")
  })

  it('status operacional: deleted_at só entra quando pedido (papel do portal não lê a coluna)', () => {
    expect(marcaStatusOperacionalSql('m', 'c')).not.toContain('deleted_at')
    expect(marcaStatusOperacionalSql('m', 'c', { considerarExcluido: true }))
      .toContain("WHEN m.tipo = 'cliente' AND c.deleted_at IS NOT NULL THEN 'arquivada'")
  })
})

describe('mapCadastroRow', () => {
  const row = {
    id: marcaId, marca_id: marcaId, cliente_id: clienteId, tipo: 'cliente', sistema: false, gera_receita: true,
    celular: '47999', email: 'a@b.c', cnpj: '1', razao_social: 'R', gateway_customer_id: 'cus_1',
    acesso_user_id: 'u', acesso_email: 'x@y.z', acesso_ativo: true,
    gmv_mes: '1234.50', lives_mes: 2, videos_mes: null,
    comercial_condicao_id: 'c1', comercial_fixo_mensal: '1000', comercial_comissao_franquia_pct: '5',
    comercial_tipo_cobranca: 'fixo_mais_comissao', comercial_fixo_confirmado: true,
    comercial_comissao_confirmada: true, comercial_origem: 'gestao',
  }

  it('converte números, monta configuracao_comercial e não vaza colunas internas', () => {
    const out = mapCadastroRow(row)
    expect(out.gmv_mes).toBe(1234.5)
    expect(out.videos_mes).toBe(0)
    expect(out.configuracao_comercial.status).toBe('configurado')
    expect(Object.keys(out).some((k) => k.startsWith('comercial_'))).toBe(false)
    expect(out.celular).toBe('47999')
  })

  it('ocultarFicha (chave de API) zera contato e faturamento', () => {
    const out = mapCadastroRow(row, { ocultarFicha: true })
    for (const k of ['celular', 'email', 'cnpj', 'razao_social', 'gateway_customer_id', 'acesso_email', 'acesso_user_id']) {
      expect(out[k]).toBeNull()
    }
    expect(out.marca_id).toBe(marcaId)
  })

  it('marca não-cliente: configuração comercial não aplicável', () => {
    expect(mapCadastroRow({ ...row, tipo: 'afiliada', comercial_condicao_id: null }).configuracao_comercial.status)
      .toBe('nao_aplicavel')
  })
})

describe('resolverCadastroId', () => {
  it('id inválido não consulta o banco', async () => {
    const db = fakeDb(() => ({ rows: [] }))
    expect(await resolverCadastroId(db, { tenantId, id: 'nao-uuid' })).toBeNull()
    expect(db.query).not.toHaveBeenCalled()
  })

  it('aceita marca_id', async () => {
    const db = fakeDb((sql) => (/FROM marcas WHERE id/.test(sql) ? { rows: [{ id: marcaId }] } : null))
    expect(await resolverCadastroId(db, { tenantId, id: marcaId })).toBe(marcaId)
    expect(db.query.mock.calls[0][1]).toEqual([marcaId, tenantId])
  })

  it('aceita cliente_id da ficha e devolve a marca tipo cliente', async () => {
    const db = fakeDb((sql) => (/JOIN clientes c/.test(sql) ? { rows: [{ id: marcaId }] } : { rows: [] }))
    expect(await resolverCadastroId(db, { tenantId, id: clienteId })).toBe(marcaId)
    const [sql, params] = db.query.mock.calls[1]
    expect(sql).toContain("m.tipo = 'cliente'")
    expect(sql).toContain('c.tenant_id = $2::uuid')
    expect(params).toEqual([clienteId, tenantId])
  })
})

describe('escritas: regras que não deixam mexer em dinheiro por aqui', () => {
  it('criar com campo financeiro → 409 USE_MARCA_CONDITION_ENDPOINT, sem tocar no banco', async () => {
    const db = fakeDb(() => null)
    await expect(criarCadastro(db, { tenantId, dados: { nome: 'X', tipo: 'afiliada', comissao_franquia_pct: 5 } }))
      .rejects.toMatchObject({ statusCode: 409, code: 'USE_MARCA_CONDITION_ENDPOINT' })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('criar cliente sem celular → 400', async () => {
    const db = fakeDb(() => null)
    await expect(criarCadastro(db, { tenantId, dados: { nome: 'X' } }))
      .rejects.toMatchObject({ statusCode: 400, code: 'CADASTRO_INVALIDO' })
  })

  it('criar afiliada com campo de ficha → 400 CAMPO_FICHA_SEM_CLIENTE', async () => {
    const db = fakeDb(() => null)
    await expect(criarCadastro(db, { tenantId, dados: { nome: 'X', tipo: 'afiliada', cnpj: '123' } }))
      .rejects.toMatchObject({ statusCode: 400, code: 'CAMPO_FICHA_SEM_CLIENTE' })
  })

  it('criar com nome duplicado → 409 e ROLLBACK', async () => {
    const db = fakeDb((sql) => (/lower\(nome\) = lower/.test(sql) ? { rows: [{ '?column?': 1 }] } : null))
    await expect(criarCadastro(db, { tenantId, dados: { nome: 'X', tipo: 'afiliada' } }))
      .rejects.toMatchObject({ statusCode: 409, code: 'MARCA_NOME_DUPLICADA' })
    const sqls = db.query.mock.calls.map(([sql]) => sql)
    expect(sqls).toContain('ROLLBACK')
    expect(sqls.some((s) => /INSERT/.test(s))).toBe(false)
  })

  it('atualizar tipo ou cliente_id → 409 USE_PROMOVER_CLIENTE', async () => {
    const db = fakeDb(() => null)
    await expect(atualizarCadastro(db, { tenantId, id: marcaId, dados: { tipo: 'cliente' } }))
      .rejects.toMatchObject({ statusCode: 409, code: 'USE_PROMOVER_CLIENTE' })
    await expect(atualizarCadastro(db, { tenantId, id: marcaId, dados: { cliente_id: clienteId } }))
      .rejects.toMatchObject({ statusCode: 409, code: 'USE_PROMOVER_CLIENTE' })
    await expect(atualizarCadastro(db, { tenantId, id: marcaId, dados: { valor_fixo_minimo: 1 } }))
      .rejects.toMatchObject({ statusCode: 409, code: 'USE_MARCA_CONDITION_ENDPOINT' })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('atualizar campo de ficha em marca sem ficha → 400 e ROLLBACK', async () => {
    const db = fakeDb((sql) => {
      if (/SELECT id FROM marcas WHERE id/.test(sql)) return { rows: [{ id: marcaId }] }
      if (/FOR UPDATE/.test(sql)) return { rows: [{ id: marcaId, nome: 'X', tipo: 'afiliada', cliente_id: null, sistema: false }] }
      return null
    })
    await expect(atualizarCadastro(db, { tenantId, id: marcaId, dados: { celular: '1' } }))
      .rejects.toMatchObject({ statusCode: 400, code: 'CAMPO_FICHA_SEM_CLIENTE' })
    const sqls = db.query.mock.calls.map(([sql]) => sql)
    expect(sqls).toContain('ROLLBACK')
    expect(sqls.some((s) => /^\s*UPDATE/.test(s))).toBe(false)
  })

  it('promover com condição retroativa → 409 PROMOCAO_CONDICAO_RETROATIVA sem gravar', async () => {
    const db = fakeDb((sql) => {
      if (/SELECT id FROM marcas WHERE id/.test(sql)) return { rows: [{ id: marcaId }] }
      if (/FROM marcas WHERE id = \$1::uuid AND tenant_id = \$2::uuid FOR UPDATE/.test(sql)) {
        return { rows: [{ id: marcaId, nome: 'Afi', tipo: 'afiliada', cliente_id: null, sistema: false, data_inicio: null }] }
      }
      if (/AS hoje/.test(sql)) return { rows: [{ hoje: '2026-10-02' }] }
      if (/FROM marca_condicoes_comerciais/.test(sql)) {
        return { rows: [{ id: 'c1', inicio_vigencia: '1900-01-01', fixo_mensal: '0', comissao_franquia_pct: '10' }] }
      }
      return null
    })
    const err = await promoverACliente(db, { tenantId, id: marcaId, dados: { celular: '47' } }).catch((e) => e)
    expect(err).toBeInstanceOf(CadastroError)
    expect(err).toMatchObject({ statusCode: 409, code: 'PROMOCAO_CONDICAO_RETROATIVA', data_inicio: '2026-10-02' })
    const sqls = db.query.mock.calls.map(([sql]) => sql)
    expect(sqls).toContain('ROLLBACK')
    expect(sqls.some((s) => /INSERT INTO clientes|UPDATE marcas/.test(s))).toBe(false)
  })

  it('não promove a marca do sistema', async () => {
    const db = fakeDb((sql) => {
      if (/SELECT id FROM marcas WHERE id/.test(sql)) return { rows: [{ id: marcaId }] }
      if (/FOR UPDATE/.test(sql)) return { rows: [{ id: marcaId, nome: 'Livelab Sistema', tipo: 'propria', sistema: true }] }
      return null
    })
    await expect(promoverACliente(db, { tenantId, id: marcaId, dados: { celular: '1' } }))
      .rejects.toMatchObject({ statusCode: 409, code: 'CADASTRO_SISTEMA' })
  })
})
