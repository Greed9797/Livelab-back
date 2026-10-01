// Chave de API de escopo financeiro (papel `automacao_financeiro`).
//
// Duas travas independentes, testadas separadamente:
// 1. allowlist por papel (src/plugins/auth.js) — o que a CHAVE alcança;
// 2. papel (requirePapel com os grupos de role_groups.js) — o que o PAPEL alcança.
import Fastify from 'fastify'
import fp from 'fastify-plugin'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import {
  ROTAS_API_KEY, ROTAS_API_KEY_FINANCEIRO, ROTAS_API_KEY_POR_PAPEL, authPlugin, chaveAlcancaRota,
} from '../src/plugins/auth.js'
import * as grupos from '../src/config/role_groups.js'
import { auditLogPlugin } from '../src/plugins/audit_log.js'
import { apiKeysRoutes } from '../src/routes/api_keys.js'
import { financeiroRoutes } from '../src/routes/financeiro.js'
import { financeiroCustosRoutes } from '../src/routes/financeiro_custos.js'
import { financeiroReceitasRoutes } from '../src/routes/financeiro_receitas.js'
import { financeiroReceitasAvulsasRoutes } from '../src/routes/financeiro_receitas_avulsas.js'
import { financeiroApresentadorasPagamentosRoutes } from '../src/routes/financeiro_apresentadoras_pagamentos.js'
import { livesRoutes } from '../src/routes/lives.js'
import { marcasRoutes } from '../src/routes/marcas.js'
import { usuariosRoutes } from '../src/routes/usuarios.js'
import { apresentadorasRoutes } from '../src/routes/apresentadoras.js'
import { comissoesRoutes } from '../src/routes/comissoes.js'

const FIN = 'automacao_financeiro'
const OPS = 'automacao'
const tenantId = '11111111-1111-4111-8111-111111111111'
const keyId = '66666666-6666-4666-8666-666666666666'
const adminId = '99999999-9999-4999-8999-999999999999'
const CHAVE = 'llk_chave-de-teste-com-tamanho-suficiente'

// ids reais de cada formato aceito
const U = '7b0c4a52-3d1e-4f6a-9c2b-8e5d1f0a9b3c'
const U_MAIUSC = '7B0C4A52-3D1E-4F6A-9C2B-8E5D1F0A9B3C'
const CALC_FIXO = `calc:${U}:2026-09:fixo`
const CALC_COMISSAO = `calc:${U}:2026-12:comissao`
const REC = `rec:${U}:2026-01`

beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'x'.repeat(48)
})

// ─── Rotas liberadas, com o corpo que cada uma aceita ─────────────────────────
const LIBERADAS = [
  ['GET', '/v1/financeiro/lancamentos?mes=2026-09'],
  ['GET', '/v1/financeiro/caixa?ate=2026-09-30'],
  ['GET', '/v1/financeiro/receita?mes=2026-09'],
  ['GET', '/v1/financeiro/dre/mes?mes=2026-09'],
  ['GET', '/v1/financeiro/resumo?inicio=2026-09&fim=2026-09'],
  ['GET', '/v1/financeiro/fluxo-caixa?mes=2026-09'],
  ['GET', '/v1/financeiro/receitas?mes=2026-09'],
  ['GET', '/v1/financeiro/receitas-avulsas?mes=2026-09'],
  ['GET', '/v1/financeiro/custos?mes=2026-09'],
  ['GET', '/v1/financeiro/custos-recorrentes'],
  ['GET', '/v1/financeiro/apresentadoras-pagamentos?mes=2026-09'],
  ['POST', '/v1/financeiro/custos', { descricao: 'Energia', valor: 450.9, competencia: '2026-09', grupo: 'estrutural' }],
  ['POST', '/v1/financeiro/custos/parcelado', { descricao: 'Notebook', parcelas: 3, valor_total: 6000, competencia: '2026-09' }],
  ['POST', '/v1/financeiro/custos/gerar?mes=2026-09'],
  ['POST', '/v1/financeiro/custos/importar', { dry_run: true, pontuais: [], recorrentes: [] }],
  ['POST', '/v1/financeiro/custos-recorrentes', { nome: 'Aluguel', valor: 3500, dia_vencimento: 10, inicio: '2026-09-01' }],
  ['POST', '/v1/financeiro/receitas/gerar?mes=2026-09'],
  ['POST', '/v1/financeiro/receitas-avulsas', { descricao: 'Workshop', valor_previsto: 1200, data_vencimento: '2026-09-20' }],
  ['PATCH', `/v1/financeiro/custos/${U}`, { valor: 470 }],
  ['PATCH', `/v1/financeiro/custos/${REC}`, { valor: 3600 }],
  ['PATCH', `/v1/financeiro/custos/${U}/pagar`, { data_pagamento: '2026-09-10' }],
  ['PATCH', `/v1/financeiro/custos/${REC}/pagar`, {}],
  ['PATCH', `/v1/financeiro/custos/${U}/desfazer`],
  ['PATCH', `/v1/financeiro/custos-recorrentes/${U}`, { valor: 3700 }],
  ['PATCH', `/v1/financeiro/receitas/${CALC_FIXO}/receber`, { data_pagamento: '2026-09-15' }],
  ['PATCH', `/v1/financeiro/receitas/${CALC_COMISSAO}/receber`, {}],
  ['PATCH', `/v1/financeiro/receitas/${U}/receber`, { valor_pago: 900 }],
  ['PATCH', `/v1/financeiro/receitas/${U}/desfazer`],
  ['PATCH', `/v1/financeiro/receitas/${CALC_FIXO}/desfazer`],
  ['PATCH', `/v1/financeiro/receitas-avulsas/${U}`, { valor_previsto: 1300 }],
  ['PATCH', `/v1/financeiro/receitas-avulsas/${U}/receber`, {}],
  ['PATCH', `/v1/financeiro/receitas-avulsas/${U}/desfazer`],
  ['PATCH', `/v1/financeiro/apresentadoras-pagamentos/${U}/2026-09/fixo/pagar`, {}],
  ['PATCH', `/v1/financeiro/apresentadoras-pagamentos/${U}/2026-09/variavel/pagar`, { valor_pago: '850.00' }],
  ['PATCH', `/v1/financeiro/apresentadoras-pagamentos/${U}/2026-09/fixo/desfazer`],
  ['PATCH', `/v1/financeiro/apresentadoras-pagamentos/${U}/2026-09/variavel/desfazer`],
  ['PATCH', '/v1/financeiro/impostos/2026-09/pagar', { data_pagamento: '2026-10-20' }],
  ['PATCH', '/v1/financeiro/impostos/2026-09/desfazer'],
]

const RECUSADAS = [
  // DELETE de tudo
  ['DELETE', `/v1/financeiro/custos/${U}`],
  ['DELETE', `/v1/financeiro/custos/${REC}`],
  ['DELETE', `/v1/financeiro/custos-recorrentes/${U}`],
  ['DELETE', `/v1/financeiro/receitas-avulsas/${U}`],
  ['DELETE', `/v1/financeiro/adicionais-apresentadoras/${U}`],
  ['DELETE', '/v1/financeiro/custos'],
  ['DELETE', `/v1/lives/${U}`],
  // config (saldo de abertura, corte, alíquota) e vencimento das apresentadoras
  ['GET', '/v1/financeiro/config'],
  ['PATCH', '/v1/financeiro/config'],
  ['GET', '/v1/financeiro/apresentadoras-pagamentos/config'],
  ['PATCH', '/v1/financeiro/apresentadoras-pagamentos/config'],
  // asaas, chaves, contratos, configurações
  ['GET', '/v1/asaas/extrato'],
  ['POST', '/v1/asaas/conciliar'],
  ['GET', '/v1/asaas'],
  ['GET', '/v1/api-keys'],
  ['POST', '/v1/api-keys'],
  ['POST', `/v1/api-keys/${U}/revogar`],
  ['GET', '/v1/contratos'],
  ['POST', '/v1/contratos'],
  ['GET', '/v1/configuracoes'],
  ['PATCH', '/v1/configuracoes'],
  // financeiro que ficou de fora
  ['GET', '/v1/financeiro/operacional'],
  ['GET', '/v1/financeiro/faturamento'],
  ['GET', '/v1/financeiro/resumo/franqueadora'],
  ['GET', '/v1/financeiro/dashboard'],
  ['GET', '/v1/financeiro/fechamento-apresentadoras'],
  ['POST', '/v1/financeiro/adicionais-apresentadoras'],
  ['GET', '/v1/relatorios/financeiro/csv'],
  ['POST', '/v1/comissoes/recalcular-mes'],
  // rotas legadas sem :componente
  ['PATCH', `/v1/financeiro/apresentadoras-pagamentos/${U}/2026-09/pagar`],
  ['PATCH', `/v1/financeiro/apresentadoras-pagamentos/${U}/2026-09/desfazer`],
  // ids malformados
  ['PATCH', `/v1/financeiro/custos/${U.slice(0, -1)}`],
  ['PATCH', `/v1/financeiro/custos/${U.slice(0, -1)}/pagar`],
  ['PATCH', `/v1/financeiro/custos-recorrentes/${REC}`],
  ['PATCH', `/v1/financeiro/receitas-avulsas/${CALC_FIXO}`],
  ['PATCH', `/v1/financeiro/receitas-avulsas/${U.slice(0, 30)}/receber`],
  ['PATCH', `/v1/financeiro/receitas/calc:${U}:2026-13:fixo/receber`],
  ['PATCH', `/v1/financeiro/receitas/calc:${U}:2026-00:fixo/receber`],
  ['PATCH', `/v1/financeiro/receitas/calc:${U}:2026-9:fixo/receber`],
  ['PATCH', `/v1/financeiro/receitas/calc:${U}:2026-09:variavel/receber`],
  ['PATCH', `/v1/financeiro/receitas/calc:${U}:2026-09/receber`],
  ['PATCH', `/v1/financeiro/receitas/calc:${U.slice(0, -1)}:2026-09:fixo/receber`],
  ['PATCH', `/v1/financeiro/receitas/CALC:${U}:2026-09:fixo/receber`],
  ['PATCH', '/v1/financeiro/receitas/rec:x/receber'],
  ['PATCH', '/v1/financeiro/custos/rec:x'],
  ['PATCH', `/v1/financeiro/custos/rec:${U}:2026-13`],
  ['PATCH', `/v1/financeiro/custos/rec:${U}`],
  ['PATCH', `/v1/financeiro/custos/rec:${U}:2026-09:fixo`],
  ['PATCH', `/v1/financeiro/custos/${U}:2026-09`],
  ['PATCH', '/v1/financeiro/custos/'],
  ['PATCH', '/v1/financeiro/custos'],
  ['PATCH', '/v1/financeiro/impostos/2026-13/pagar'],
  ['PATCH', '/v1/financeiro/impostos/2026-00/pagar'],
  ['PATCH', '/v1/financeiro/impostos/2026-9/pagar'],
  ['PATCH', '/v1/financeiro/impostos/26-09/pagar'],
  ['PATCH', '/v1/financeiro/impostos/2026-09-01/pagar'],
  ['PATCH', `/v1/financeiro/apresentadoras-pagamentos/${U}/2026-13/fixo/pagar`],
  ['PATCH', `/v1/financeiro/apresentadoras-pagamentos/${U}/2026-09/outro/pagar`],
  ['PATCH', `/v1/financeiro/apresentadoras-pagamentos/${U}/2026-09/comissao/pagar`],
  ['PATCH', `/v1/financeiro/apresentadoras-pagamentos/${U}/2026-09/FIXO/pagar`],
  ['PATCH', `/v1/financeiro/apresentadoras-pagamentos/${U.slice(0, -2)}/2026-09/fixo/pagar`],
  ['PATCH', `/v1/financeiro/apresentadoras-pagamentos/${CALC_FIXO}/2026-09/fixo/pagar`],
  // sub-rotas extras e barras
  ['GET', '/v1/financeiro/custos/extra'],
  ['GET', `/v1/financeiro/custos/${U}`],
  ['GET', '/v1/financeiro/lancamentos/'],
  ['GET', '/v1/financeiro/lancamentos/export'],
  ['GET', '/v1/financeiro/dre'],
  ['GET', '/v1/financeiro/dre/mes/extra'],
  ['POST', '/v1/financeiro/custos/'],
  ['POST', '/v1/financeiro/custos/importar/extra'],
  ['POST', `/v1/financeiro/custos/${U}`],
  ['PATCH', `/v1/financeiro/custos/${U}/pagar/extra`],
  ['PATCH', `/v1/financeiro/custos/${U}/estornar`],
  ['PATCH', `/v1/financeiro/receitas/${U}/receber/x`],
  ['PATCH', `/v1/financeiro/receitas-avulsas/${U}/receber/${U}`],
  ['PATCH', `/v1/financeiro/impostos/2026-09/pagar/extra`],
  ['PATCH', `/v1/financeiro/apresentadoras-pagamentos/${U}/2026-09/fixo/pagar/extra`],
  ['PATCH', '//v1/financeiro/custos-recorrentes/' + U],
  ['PATCH', `/v1/financeiro/custos%2F${U}`],
  ['PATCH', `/v1/financeiro/custos/${U}%2Fpagar`],
  ['GET', '/V1/FINANCEIRO/CUSTOS'],
  // método errado
  ['POST', '/v1/financeiro/lancamentos'],
  ['PUT', `/v1/financeiro/custos/${U}`],
  ['GET', '/v1/financeiro/custos/parcelado'],
  ['PATCH', '/v1/financeiro/custos-recorrentes'],
  ['POST', `/v1/financeiro/custos/${U}/pagar`],
  ['POST', '/v1/financeiro/impostos/2026-09/pagar'],
  ['GET', '/v1/financeiro/receitas/gerar'],
  ['PUT', '/v1/financeiro/receitas-avulsas'],
  // escopo operacional: a chave financeira não alcança nada dele
  ['GET', '/v1/lives'],
  ['GET', `/v1/lives/${U}`],
  ['POST', '/v1/lives/manual'],
  ['GET', '/v1/marcas'],
  ['POST', '/v1/marcas'],
  ['GET', '/v1/apresentadoras'],
  ['POST', '/v1/usuarios'],
  ['POST', '/v1/usuarios/convidar'],
  ['GET', '/v1/usuarios'],
  ['GET', '/v1/comissoes/resumo'],
  ['POST', '/v1/analytics/imports/ingest'],
]

const semQuery = (url) => url.split('?')[0]

describe('allowlist do escopo financeiro', () => {
  it.each(LIBERADAS)('libera %s %s para automacao_financeiro', (metodo, url) => {
    expect(chaveAlcancaRota(metodo, url, FIN)).toBe(true)
  })

  it.each(LIBERADAS)('nega %s %s para a chave operacional', (metodo, url) => {
    expect(chaveAlcancaRota(metodo, url, OPS)).toBe(false)
    // chamada sem papel = escopo operacional (comportamento de antes)
    expect(chaveAlcancaRota(metodo, url)).toBe(false)
  })

  it.each(RECUSADAS)('recusa %s %s', (metodo, url) => {
    expect(chaveAlcancaRota(metodo, url, FIN)).toBe(false)
  })

  it('aceita uuid em maiúsculas e o `:` codificado do id virtual', () => {
    expect(chaveAlcancaRota('PATCH', `/v1/financeiro/custos/${U_MAIUSC}/pagar`, FIN)).toBe(true)
    expect(chaveAlcancaRota('PATCH', `/v1/financeiro/receitas/calc%3A${U}%3A2026-09%3Afixo/receber`, FIN)).toBe(true)
    expect(chaveAlcancaRota('PATCH', `/v1/financeiro/custos/rec%3a${U}%3a2026-09`, FIN)).toBe(true)
    // só `:` é desfeito; `/` codificado continua sem casar
    expect(chaveAlcancaRota('PATCH', `/v1/financeiro/custos/${U}%2Fpagar`, FIN)).toBe(false)
  })

  it('não tem DELETE, nem config, asaas ou api-keys, e cada entrada casa com um caminho concreto', () => {
    expect(ROTAS_API_KEY_FINANCEIRO.every(([m]) => m !== 'DELETE')).toBe(true)
    for (const [, rota] of ROTAS_API_KEY_FINANCEIRO) {
      expect(rota.startsWith('/v1/financeiro/')).toBe(true)
      expect(rota).not.toMatch(/config|asaas|api-keys|operacional|faturamento/)
    }
    const concretas = ROTAS_API_KEY_FINANCEIRO.map(([m, rota]) => [m, rota
      .replace(':vid', CALC_FIXO).replace(':id', U).replace(':mes', '2026-09').replace(':componente', 'variavel')])
    for (const [m, url] of concretas) expect(chaveAlcancaRota(m, url, FIN), `${m} ${url}`).toBe(true)
    // cada rota de LIBERADAS cobre uma entrada, e toda entrada tem caso em LIBERADAS
    for (const [m, rota] of ROTAS_API_KEY_FINANCEIRO) {
      const coberta = LIBERADAS.some(([lm, url]) => lm === m
        && ROTAS_API_KEY_POR_PAPEL[FIN].filter(([em]) => em === m).length > 0
        && new RegExp(`^${rota.replace(/:(vid|id|mes|componente)/g, '[^/]+')}$`).test(semQuery(url)))
      expect(coberta, `${m} ${rota} sem caso em LIBERADAS`).toBe(true)
    }
  })

  it('papel desconhecido (ou papel de gente) não alcança rota nenhuma', () => {
    for (const papel of [null, '', 'franqueado', 'franqueador_master', 'financeiro', '__proto__', 'constructor', 'toString']) {
      expect(chaveAlcancaRota('GET', '/v1/lives', papel)).toBe(false)
      expect(chaveAlcancaRota('GET', '/v1/financeiro/lancamentos', papel)).toBe(false)
    }
  })

  it('placeholder desconhecido ou colado em texto faz a entrada nunca casar', async () => {
    const auth = await import('../src/plugins/auth.js')
    const original = [...auth.ROTAS_API_KEY_FINANCEIRO]
    try {
      auth.ROTAS_API_KEY_FINANCEIRO.push(['GET', '/v1/teste/:qualquer'], ['GET', '/v1/teste/x-:id'])
      expect(chaveAlcancaRota('GET', '/v1/teste/abc', FIN)).toBe(false)
      expect(chaveAlcancaRota('GET', `/v1/teste/x-${U}`, FIN)).toBe(false)
    } finally {
      auth.ROTAS_API_KEY_FINANCEIRO.splice(0, auth.ROTAS_API_KEY_FINANCEIRO.length, ...original)
    }
  })
})

// ─── As entradas antigas casam exatamente como antes ──────────────────────────
// Cópia literal do casador anterior (um único :id, regex com flag i).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_BODY_ANTIGO = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const esc = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function casadorAntigo(metodo, caminho) {
  const limpo = String(caminho ?? '').split('?')[0]
  return ROTAS_API_KEY.some(([m, rota]) => {
    if (m !== metodo) return false
    if (rota.includes(':id')) {
      const [prefixo, ...resto] = rota.split(':id')
      if (resto.length !== 1) return false
      return new RegExp(`^${esc(prefixo)}${UUID_BODY_ANTIGO}${esc(resto[0])}$`, 'i').test(limpo)
    }
    if (!rota.endsWith('/')) return limpo === rota
    return limpo.startsWith(rota) && UUID_RE.test(limpo.slice(rota.length))
  })
}

describe('escopo operacional não mudou', () => {
  const metodos = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']
  const sufixos = ['', '/', `/${U}`, `/${U_MAIUSC}`, `/${U.slice(0, -1)}`, `/${U}/publicar`, `/${U}/encerrar`,
    `/${U}/condicoes`, `/${U}/condicoes/preview`, `/${U}/condicoes/extra`, '/manual', '/manual/x', '/convidar',
    '/resumo', '/apresentadoras', '/marcas', '/preview', '/ingest', `/${CALC_FIXO}`, `/${REC}`, '?x=1', `/${U}?x=1`]
  const bases = [...new Set(ROTAS_API_KEY.map(([, r]) => r.split('/:id')[0].replace(/\/$/, '')))]
    .concat(['/v1/financeiro/custos', '/v1/financeiro/lancamentos', '/v1/clientes', '/v1/usuarios'])

  it('mesmo resultado do casador anterior em todo o corpus', () => {
    let total = 0
    for (const metodo of metodos) {
      for (const base of bases) {
        for (const sufixo of sufixos) {
          const url = `${base}${sufixo}`
          expect(chaveAlcancaRota(metodo, url), `${metodo} ${url}`).toBe(casadorAntigo(metodo, url))
          expect(chaveAlcancaRota(metodo, url, OPS), `${metodo} ${url}`).toBe(casadorAntigo(metodo, url))
          total++
        }
      }
    }
    expect(total).toBeGreaterThan(500)
  })

  it('cada entrada antiga continua casando com o seu caminho concreto', () => {
    for (const [m, rota] of ROTAS_API_KEY) {
      const url = rota.endsWith('/') ? `${rota}${U}` : rota.replace(':id', U)
      expect(chaveAlcancaRota(m, url, OPS), `${m} ${url}`).toBe(true)
      expect(chaveAlcancaRota(m, url, FIN), `${m} ${url} não pode abrir para a chave financeira`).toBe(false)
    }
  })
})

// ─── Grupos de papel ──────────────────────────────────────────────────────────
describe('grupos de papel', () => {
  const arrays = Object.entries(grupos).filter(([, v]) => Array.isArray(v))

  it("'automacao_financeiro' está SÓ em READ_FINANCEIRO e WRITE_FINANCEIRO", () => {
    const com = arrays.filter(([, v]) => v.includes(FIN)).map(([k]) => k).sort()
    expect(com).toEqual(['READ_FINANCEIRO', 'WRITE_FINANCEIRO'])
  })

  it("'automacao' (bot de lives) continua fora de todo grupo financeiro", () => {
    expect(grupos.READ_FINANCEIRO).not.toContain(OPS)
    expect(grupos.WRITE_FINANCEIRO).not.toContain(OPS)
    const com = arrays.filter(([, v]) => v.includes(OPS)).map(([k]) => k).sort()
    expect(com).toEqual([
      'READ_ANALYTICS', 'READ_APRESENTADORAS', 'READ_CABINES', 'READ_COMISSOES', 'READ_LIVES', 'READ_MARCAS',
      'WRITE_APRESENTADORAS', 'WRITE_LIVES', 'WRITE_MARCAS',
    ])
  })
})

// ─── HTTP: rotas reais ────────────────────────────────────────────────────────
function chave(papel, extra = {}) {
  return { id: keyId, tenant_id: tenantId, papel, nome: 'bot financeiro', criado_por: null, revogada_em: null, expira_em: null, ...extra }
}

/**
 * App com o plugin de auth real e as rotas reais. O banco devolve vazio para
 * tudo — o que interessa aqui é se a request passou das travas, não o resultado.
 * @param {{ chaveRow?: object|null, papelJwt?: string, modulos?: Function[], audit?: boolean }} opts
 */
async function buildApp({ chaveRow = null, papelJwt = 'franqueado', modulos = [], audit = false } = {}) {
  const app = Fastify()
  const query = vi.fn(async (sql) => {
    if (typeof sql === 'string' && sql.includes('FROM api_keys') && sql.includes('key_hash')) return { rows: chaveRow ? [chaveRow] : [] }
    if (typeof sql === 'string' && sql.includes('token_version')) {
      return { rows: [{ token_version: 1, ativo: true, papel: papelJwt, tenant_id: tenantId }] }
    }
    return { rows: [], rowCount: 0 }
  })
  await app.register(fp(async (i) => { i.decorate('db', { query }) }, { name: 'db' }))
  await app.register(authPlugin)
  const auditLog = vi.fn(async () => {})
  if (audit) await app.register(auditLogPlugin)
  else app.decorate('audit', { log: auditLog })
  const withTenant = vi.fn(async (_t, fn) => fn({ query, release() {} }))
  app.decorate('withTenant', withTenant)
  app.decorate('dbTenant', async () => ({ query, release() {} }))
  for (const m of modulos) await app.register(m)
  await app.ready()
  const jwt = (papel = papelJwt) => app.jwt.sign({ sub: adminId, tenant_id: tenantId, papel, token_version: 1 })
  return { app, query, withTenant, jwt, auditLog }
}

const FINANCEIRO_MODULOS = [
  financeiroRoutes, financeiroCustosRoutes, financeiroReceitasRoutes,
  financeiroReceitasAvulsasRoutes, financeiroApresentadorasPagamentosRoutes,
]

const ehRotaInexistente = (res) => res.statusCode === 404 && /Route .* not found/.test(res.body)

describe('HTTP com as rotas financeiras reais', () => {
  it('a chave financeira passa pelas duas travas em toda rota liberada', async () => {
    const { app } = await buildApp({ chaveRow: chave(FIN), modulos: FINANCEIRO_MODULOS })
    for (const [method, url, payload] of LIBERADAS) {
      const res = await app.inject({ method, url, headers: { 'x-api-key': CHAVE }, ...(payload ? { payload } : {}) })
      expect([401, 403], `${method} ${url} → ${res.statusCode} ${res.body}`).not.toContain(res.statusCode)
      expect(ehRotaInexistente(res), `${method} ${url} não existe no servidor`).toBe(false)
    }
    await app.close()
  })

  it('a chave operacional leva 403 em toda rota financeira liberada', async () => {
    const { app, withTenant } = await buildApp({ chaveRow: chave(OPS), modulos: FINANCEIRO_MODULOS })
    for (const [method, url, payload] of LIBERADAS) {
      const res = await app.inject({ method, url, headers: { 'x-api-key': CHAVE }, ...(payload ? { payload } : {}) })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
    expect(withTenant).not.toHaveBeenCalled()
    await app.close()
  })

  it("papel 'automacao' é recusado nas rotas financeiras mesmo que a allowlist deixasse", async () => {
    // Caminho do JWT: sem allowlist nenhuma no meio, só o requirePapel decide.
    const { app, withTenant, jwt } = await buildApp({ papelJwt: OPS, modulos: FINANCEIRO_MODULOS })
    for (const [method, url, payload] of LIBERADAS) {
      const res = await app.inject({ method, url, headers: { authorization: `Bearer ${jwt()}` }, ...(payload ? { payload } : {}) })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
    expect(withTenant).not.toHaveBeenCalled()
    await app.close()
  })

  it('DELETE e config ficam fechados para a chave financeira e nada é apagado', async () => {
    const { app, query, withTenant } = await buildApp({ chaveRow: chave(FIN), modulos: FINANCEIRO_MODULOS })
    const casos = [
      ['DELETE', `/v1/financeiro/custos/${U}?escopo=grupo`],
      ['DELETE', `/v1/financeiro/custos-recorrentes/${U}`],
      ['DELETE', `/v1/financeiro/receitas-avulsas/${U}`],
      ['GET', '/v1/financeiro/config'],
      ['PATCH', '/v1/financeiro/config', { saldo_abertura: 999999 }],
      ['GET', '/v1/financeiro/operacional'],
      ['GET', '/v1/financeiro/faturamento'],
      ['GET', '/v1/financeiro/apresentadoras-pagamentos/config'],
      ['PATCH', '/v1/financeiro/apresentadoras-pagamentos/config', { fixo: { dia: 1 } }],
      ['PATCH', `/v1/financeiro/apresentadoras-pagamentos/${U}/2026-09/pagar`, {}],
    ]
    for (const [method, url, payload] of casos) {
      const res = await app.inject({ method, url, headers: { 'x-api-key': CHAVE }, ...(payload ? { payload } : {}) })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
      expect(res.json().error).toBe('Esta chave não tem acesso a esta rota')
    }
    expect(withTenant).not.toHaveBeenCalled()
    expect(query.mock.calls.some(([sql]) => /DELETE FROM|UPDATE tenants|financeiro_config/i.test(sql))).toBe(false)
    await app.close()
  })

  it('id malformado leva 403 da allowlist antes de chegar ao handler', async () => {
    const { app, withTenant } = await buildApp({ chaveRow: chave(FIN), modulos: FINANCEIRO_MODULOS })
    for (const url of [
      `/v1/financeiro/receitas/calc:${U}:2026-13:fixo/receber`,
      '/v1/financeiro/receitas/rec:x/receber',
      `/v1/financeiro/custos/${U.slice(0, -1)}/pagar`,
      '/v1/financeiro/impostos/2026-13/pagar',
      `/v1/financeiro/apresentadoras-pagamentos/${U}/2026-09/outro/pagar`,
    ]) {
      const res = await app.inject({ method: 'PATCH', url, headers: { 'x-api-key': CHAVE }, payload: {} })
      expect(res.statusCode, url).toBe(403)
    }
    expect(withTenant).not.toHaveBeenCalled()
    await app.close()
  })

  it('o audit_log registra a baixa feita pela chave (via=api_key, api_key_nome)', async () => {
    const { app, query } = await buildApp({ chaveRow: chave(FIN), modulos: FINANCEIRO_MODULOS, audit: true })
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM api_keys') && sql.includes('key_hash')) return { rows: [chave(FIN)] }
      if (sql.includes('INSERT INTO custos')) {
        return { rows: [{ id: U, descricao: 'Energia', valor: '450.90', competencia: '2026-09-01', data_vencimento: '2026-09-01', grupo: 'estrutural', tipo: 'outros' }] }
      }
      return { rows: [], rowCount: 0 }
    })
    const res = await app.inject({
      method: 'POST', url: '/v1/financeiro/custos', headers: { 'x-api-key': CHAVE },
      payload: { descricao: 'Energia', valor: 450.9, competencia: '2026-09', grupo: 'estrutural' },
    })
    expect(res.statusCode).toBe(201)
    await new Promise((r) => setTimeout(r, 10))
    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO audit_log'))
    expect(insert).toBeTruthy()
    const [, params] = insert
    expect(params[0]).toBe(tenantId)
    expect(params[1]).toBe(keyId)
    expect(params[2]).toBe('financeiro.custo_create')
    expect(JSON.parse(params[5])).toMatchObject({ via: 'api_key', api_key_nome: 'bot financeiro' })
    await app.close()
  })
})

describe('HTTP: a chave financeira não alcança lives, marcas, usuários, apresentadoras', () => {
  const OPERACIONAIS = [
    ['GET', '/v1/lives'],
    ['GET', `/v1/lives/${U}`],
    ['POST', '/v1/lives/manual', {}],
    ['PATCH', `/v1/lives/${U}`, {}],
    ['GET', '/v1/marcas'],
    ['GET', `/v1/marcas/${U}`],
    ['POST', '/v1/marcas', { nome: 'X' }],
    ['PATCH', `/v1/marcas/${U}`, { nome: 'X' }],
    ['GET', '/v1/apresentadoras'],
    ['POST', '/v1/apresentadoras', { nome: 'A', email: 'a@example.com' }],
    ['PATCH', `/v1/apresentadoras/${U}`, {}],
    ['GET', '/v1/usuarios'],
    ['POST', '/v1/usuarios', { nome: 'A', email: 'a@example.com' }],
    ['POST', '/v1/usuarios/convidar', { nome: 'A', email: 'a@example.com' }],
    ['GET', '/v1/comissoes/resumo'],
  ]
  const MODULOS = [livesRoutes, marcasRoutes, usuariosRoutes, apresentadorasRoutes, comissoesRoutes]

  it('pela chave: 403 da allowlist', async () => {
    const { app, withTenant } = await buildApp({ chaveRow: chave(FIN), modulos: MODULOS })
    for (const [method, url, payload] of OPERACIONAIS) {
      const res = await app.inject({ method, url, headers: { 'x-api-key': CHAVE }, ...(payload ? { payload } : {}) })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
    expect(withTenant).not.toHaveBeenCalled()
    await app.close()
  })

  it("pelo papel: 'automacao_financeiro' leva 403 do requirePapel nas mesmas rotas", async () => {
    const { app, withTenant, jwt } = await buildApp({ papelJwt: FIN, modulos: MODULOS })
    for (const [method, url, payload] of OPERACIONAIS) {
      const res = await app.inject({ method, url, headers: { authorization: `Bearer ${jwt()}` }, ...(payload ? { payload } : {}) })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
      expect(ehRotaInexistente(res)).toBe(false)
    }
    expect(withTenant).not.toHaveBeenCalled()
    await app.close()
  })
})

// ─── Criação de chave com escopo ──────────────────────────────────────────────
describe('POST /v1/api-keys com escopo', () => {
  async function appChaves() {
    const ctx = await buildApp({ papelJwt: 'franqueado', modulos: [apiKeysRoutes] })
    ctx.query.mockImplementation(async (sql, params = []) => {
      if (sql.includes('token_version')) return { rows: [{ token_version: 1, ativo: true, papel: 'franqueado', tenant_id: tenantId }] }
      if (sql.includes('INSERT INTO api_keys')) {
        return { rows: [{ id: keyId, nome: params[1], prefixo: params[2], papel: params[6], criado_em: '2026-10-01T00:00:00Z', expira_em: params[5] }] }
      }
      if (sql.includes('FROM api_keys') && sql.includes('ORDER BY')) {
        return { rows: [
          { id: keyId, nome: 'fin', prefixo: 'llk_aaaaaaaa', papel: FIN },
          { id: U, nome: 'bot', prefixo: 'llk_bbbbbbbb', papel: OPS },
        ] }
      }
      return { rows: [], rowCount: 0 }
    })
    return ctx
  }

  it("escopo 'financeiro' grava papel automacao_financeiro, devolve e audita", async () => {
    const { app, query, jwt, auditLog } = await appChaves()
    const res = await app.inject({
      method: 'POST', url: '/v1/api-keys', headers: { authorization: `Bearer ${jwt()}` },
      payload: { nome: 'conciliador', escopo: 'financeiro' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ papel: FIN, escopo: 'financeiro', nome: 'conciliador' })
    expect(res.json().chave).toMatch(/^llk_/)
    const [sql, params] = query.mock.calls.find(([s]) => s.includes('INSERT INTO api_keys'))
    expect(sql).toContain('papel')
    expect(params[6]).toBe(FIN)
    expect(params).not.toContain(res.json().chave)
    expect(auditLog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'api_key.create',
      metadata: expect.objectContaining({ papel: FIN, escopo: 'financeiro' }),
    }))
    await app.close()
  })

  it("sem escopo continua 'automacao' (operacional)", async () => {
    const { app, query, jwt, auditLog } = await appChaves()
    const res = await app.inject({
      method: 'POST', url: '/v1/api-keys', headers: { authorization: `Bearer ${jwt()}` }, payload: { nome: 'bot lives' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ papel: OPS, escopo: 'operacional' })
    expect(query.mock.calls.find(([s]) => s.includes('INSERT INTO api_keys'))[1][6]).toBe(OPS)
    expect(auditLog.mock.calls[0][1].metadata).toMatchObject({ papel: OPS, escopo: 'operacional' })
    await app.close()
  })

  it('escopo inválido é 400 e `papel` no body é ignorado', async () => {
    const { app, query, jwt } = await appChaves()
    const ruim = await app.inject({
      method: 'POST', url: '/v1/api-keys', headers: { authorization: `Bearer ${jwt()}` },
      payload: { nome: 'x', escopo: 'admin' },
    })
    expect(ruim.statusCode).toBe(400)
    const papelNoBody = await app.inject({
      method: 'POST', url: '/v1/api-keys', headers: { authorization: `Bearer ${jwt()}` },
      payload: { nome: 'x', papel: 'franqueado' },
    })
    expect(papelNoBody.statusCode).toBe(201)
    expect(papelNoBody.json().papel).toBe(OPS)
    const inserts = query.mock.calls.filter(([s]) => s.includes('INSERT INTO api_keys'))
    expect(inserts).toHaveLength(1)
    expect(inserts[0][1][6]).toBe(OPS)
    await app.close()
  })

  it('GET lista papel e escopo', async () => {
    const { app, jwt } = await appChaves()
    const res = await app.inject({ method: 'GET', url: '/v1/api-keys', headers: { authorization: `Bearer ${jwt()}` } })
    expect(res.statusCode).toBe(200)
    expect(res.json().items).toEqual([
      expect.objectContaining({ papel: FIN, escopo: 'financeiro' }),
      expect.objectContaining({ papel: OPS, escopo: 'operacional' }),
    ])
    await app.close()
  })

  it('só papel administrativo cria; financeiro humano e as próprias chaves não', async () => {
    for (const papel of ['financeiro', 'auditor', FIN, OPS]) {
      const ctx = await buildApp({ papelJwt: papel, modulos: [apiKeysRoutes] })
      const res = await ctx.app.inject({
        method: 'POST', url: '/v1/api-keys', headers: { authorization: `Bearer ${ctx.jwt(papel)}` },
        payload: { nome: 'x', escopo: 'financeiro' },
      })
      expect(res.statusCode, papel).toBe(403)
      await ctx.app.close()
    }
    for (const papelChave of [FIN, OPS]) {
      const ctx = await buildApp({ chaveRow: chave(papelChave), modulos: [apiKeysRoutes] })
      for (const [method, url] of [['GET', '/v1/api-keys'], ['POST', '/v1/api-keys'], ['POST', `/v1/api-keys/${U}/revogar`]]) {
        const res = await ctx.app.inject({ method, url, headers: { 'x-api-key': CHAVE }, payload: { nome: 'x', escopo: 'financeiro' } })
        expect(res.statusCode, `${papelChave} ${method} ${url}`).toBe(403)
      }
      expect(ctx.query.mock.calls.some(([s]) => s.includes('INSERT INTO api_keys') || s.includes('SET revogada_em'))).toBe(false)
      await ctx.app.close()
    }
  })
})
