import { describe, expect, it, vi } from 'vitest'
import {
  aprovarPendentesSemConflito,
  conflitoHorarioError,
  motivoConflitoAprovacaoSemCabine,
} from '../src/services/portal-apresentadora-aprovacao.js'
import { franquiaDaLinha, __test } from '../src/services/portal-aprovacao-lote.js'

const MARCA = '11111111-1111-4111-8111-111111111111'

function row(id, overrides = {}) {
  return {
    id,
    status: 'pendente',
    arquivamento_status: null,
    marca_id: MARCA,
    apresentadora_id: '22222222-2222-4222-8222-222222222222',
    iniciado_em: '2020-01-02T15:00:00.000Z',
    encerrado_em: '2020-01-02T16:00:00.000Z',
    gmv_declarado: '10.00',
    pedidos_declarados: 1,
    apresentadora_nome: 'Ana',
    marca_nome: 'Marca',
    ...overrides,
  }
}

const passthrough = (data) => ({ data })

describe('motivoConflitoAprovacaoSemCabine', () => {
  it('recusa sobreposição da apresentadora com a mesma frase da aprovação sem cabine', async () => {
    const query = vi.fn(async (sql) => {
      expect(sql).not.toMatch(/FOR UPDATE/i)
      expect(sql).toContain('apresentador_id')
      expect(sql).not.toContain('pending_peer')
      expect(sql).not.toContain('em_conciliacao')
      return { rows: [{ conflito_apresentadora: true }] }
    })
    await expect(motivoConflitoAprovacaoSemCabine({ query }, { tenantId: MARCA, submissionId: MARCA }))
      .resolves.toBe('Já existe uma live oficial desta apresentadora neste horário. Confira o registro e use Vincular live existente.')
  })

  it('não recusa em conciliação nem mesma marca quando a apresentadora não sobrepõe', async () => {
    const query = vi.fn(async (sql) => {
      expect(sql).not.toContain('pending_peer')
      return { rows: [{ conflito_apresentadora: false }] }
    })
    await expect(motivoConflitoAprovacaoSemCabine({ query }, { tenantId: MARCA, submissionId: MARCA }))
      .resolves.toBeNull()
  })

  it('libera envio sem as duas marcas de conflito', async () => {
    const query = vi.fn(async () => ({ rows: [{ em_conciliacao: false, conflito_apresentadora: false }] }))
    await expect(motivoConflitoAprovacaoSemCabine({ query }, { tenantId: MARCA, submissionId: MARCA })).resolves.toBeNull()
  })
})

describe('aprovarPendentesSemConflito', () => {
  it('aprova os limpos, lista o conflito e segue depois de uma falha', async () => {
    const approvedIds = []
    const result = await aprovarPendentesSemConflito({
      rows: [
        row('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { iniciado_em: '2020-01-02T18:00:00.000Z', encerrado_em: '2020-01-02T19:00:00.000Z' }),
        row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
        row('cccccccc-cccc-4ccc-8ccc-cccccccccccc', { iniciado_em: '2020-01-02T12:00:00.000Z', encerrado_em: '2020-01-02T13:00:00.000Z', apresentadora_nome: 'Bia' }),
        row('dddddddd-dddd-4ddd-8ddd-dddddddddddd', { status: 'devolvida' }),
      ],
      tenantId: MARCA,
      revisorId: MARCA,
      recordHistory: async () => {},
      normalizeOfficialMetrics: passthrough,
      runInDb: async (work) => work({}),
      conflict: async (_db, { submissionId }) => (
        submissionId.startsWith('ccc') ? 'Conflito de horário com outra live ou envio da mesma marca.' : null
      ),
      approve: async (_db, { submissionId }) => {
        approvedIds.push(submissionId)
        if (submissionId.startsWith('bbb')) throw new Error('marca inválida')
        return { id: submissionId, live_oficial_id: `live-${submissionId.slice(0, 8)}` }
      },
    })

    expect(approvedIds).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ])
    expect(result.approved).toEqual([
      expect.objectContaining({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', live_oficial_id: 'live-aaaaaaaa', apresentadora_nome: 'Ana' }),
    ])
    expect(result.skipped_conflito).toEqual([
      expect.objectContaining({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', apresentadora_nome: 'Bia' }),
    ])
    expect(result.failed).toEqual([
      expect.objectContaining({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', error: 'marca inválida' }),
    ])
    expect(result.skipped.find((item) => item.id.startsWith('ddd'))?.reason).toBe('Envio não está pendente.')
    expect(result.approved).toHaveLength(1)
  })

  it('classifica a recusa de horário da aprovação individual como conflito, não como falha', async () => {
    const result = await aprovarPendentesSemConflito({
      rows: [row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')],
      tenantId: MARCA,
      revisorId: MARCA,
      recordHistory: async () => {},
      normalizeOfficialMetrics: passthrough,
      runInDb: async (work) => work({}),
      conflict: async () => null,
      approve: async () => {
        throw conflitoHorarioError('Já existe uma live oficial desta apresentadora neste horário. Confira o registro e use Vincular live existente.')
      },
    })

    expect(result.approved).toEqual([])
    expect(result.failed).toEqual([])
    expect(result.skipped_conflito[0]?.reason).toMatch(/apresentadora neste horário/)
    expect(result.skipped[0]?.conflito).toBe(true)
  })
})

const USER = '33333333-3333-4333-8333-333333333333'
const APRESENTADORA = '22222222-2222-4222-8222-222222222222'
const LIVE = '44444444-4444-4444-8444-444444444444'

function contexto(submissoes) {
  return {
    rows: [{
      payload: {
        submissoes,
        faixas: [],
        faixas_tenant: [],
      },
    }],
  }
}

function info(id, overrides = {}) {
  return {
    id,
    apresentadora_id: APRESENTADORA,
    marca_id: MARCA,
    iniciado_em: '2020-01-02T15:00:00.000Z',
    encerrado_em: '2020-01-02T16:00:00.000Z',
    gmv_declarado: 176,
    pedidos_declarados: 2,
    observacao: "O'Brien",
    live_impressions_declaradas: 4,
    manual_views_declaradas: 1,
    user_id: USER,
    apresentadora_ativa: true,
    apresentadora_arquivada: false,
    user_ativo: true,
    marca_tipo: 'afiliada',
    marca_status: 'ativa',
    cliente_id: null,
    cliente_encontrado: false,
    marca_pct: 0,
    marca_franqueadora_pct: 0,
    condicao_pct: null,
    gmv_mes: 0,
    em_conciliacao: false,
    conflito_apresentadora: false,
    ...overrides,
  }
}

describe('aprovar lote numa sessão', () => {
  it('não trava marcas e não grava franquia 0 quando a taxa não existe', () => {
    expect(franquiaDaLinha(info(LIVE), { presenterBands: [], defaultBands: [], gmvMes: 176 })).toBeNull()
    const sql = __test.scriptGravar({
      tenantId: MARCA,
      submissionId: LIVE,
      revisorId: MARCA,
      apresentadoraId: APRESENTADORA,
      userId: USER,
      marcaId: MARCA,
      clienteId: null,
      tipo: 'afiliado',
      iniciadoEm: '2020-01-02T15:00:00.000Z',
      encerradoEm: '2020-01-02T16:00:00.000Z',
      agendaFim: '2020-01-02T16:00:00.000Z',
      gmv: 176,
      pedidos: 2,
      impressions: 4,
      views: 1,
      observacao: "O'Brien",
      franquia: null,
      comissaoApresentadora: 1.76,
      comissaoApresentadoraPct: 1,
      franqueadora: 0,
      marcaCondicaoId: null,
      data: '2020-01-02',
      lockKey: `live-approve:${MARCA}:${APRESENTADORA}`,
    })
    expect(__test.contextoSql()).not.toMatch(/FOR UPDATE/i)
    expect(sql).toMatch(/FOR UPDATE/)
    expect(sql).not.toMatch(/marcas/i)
    expect(sql).toMatch(/pg_advisory_xact_lock/)
    expect(sql).toContain("O''Brien")
    expect(sql).toMatch(/comissao_calculada, comissao_apresentadora_pct, comissao_apresentadora_valor/)
    expect(sql).toContain('NULL, 1, 1.76')
    expect(__test.contextoSql()).not.toMatch(/comissao_confirmada/)
  })

  it('lê o resultado final quando o driver devolve um resultado por comando', async () => {
    const row = await __test.gravarLimpa(async () => ([
      { rows: [], command: 'SELECT' },
      { rows: [{ outcome: 'approved', live_id: LIVE }] },
    ]), {
      tenantId: MARCA,
      submissionId: LIVE,
      revisorId: MARCA,
      apresentadoraId: APRESENTADORA,
      userId: USER,
      marcaId: MARCA,
      clienteId: null,
      tipo: 'afiliado',
      iniciadoEm: '2020-01-02T15:00:00.000Z',
      encerradoEm: '2020-01-02T16:00:00.000Z',
      agendaFim: '2020-01-02T16:00:00.000Z',
      gmv: 176,
      pedidos: 2,
      impressions: null,
      views: null,
      observacao: null,
      franquia: null,
      comissaoApresentadora: 1.76,
      comissaoApresentadoraPct: 1,
      franqueadora: 0,
      marcaCondicaoId: null,
      data: '2020-01-02',
      lockKey: 'live-approve:test',
    })
    expect(row).toEqual({ outcome: 'approved', live_id: LIVE })
  })

  it('aprova os limpos em uma ida cada e recalcula o mês uma vez', async () => {
    const sqls = []
    const lifts = []
    let gravadas = 0
    const session = {
      query: async (sql, params) => {
        sqls.push(sql)
        if (String(sql).includes('lote-aprovacao:contexto')) {
          expect(params[1]).toHaveLength(3)
          return contexto([
            info('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
            info('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { iniciado_em: '2020-01-02T18:00:00.000Z', encerrado_em: '2020-01-02T19:00:00.000Z' }),
            info('cccccccc-cccc-4ccc-8ccc-cccccccccccc', { iniciado_em: '2020-01-02T12:00:00.000Z', encerrado_em: '2020-01-02T13:00:00.000Z', conflito_apresentadora: true }),
          ])
        }
        if (String(sql).includes('lote-aprovacao:gravar')) {
          gravadas += 1
          return { rows: [{ outcome: 'approved', live_id: `${LIVE.slice(0, -1)}${gravadas}` }] }
        }
        throw new Error(`query inesperada: ${String(sql).slice(0, 80)}`)
      },
      transaction: async (fn) => fn({
        query: async (sql) => {
          sqls.push(sql)
          return { rows: [] }
        },
      }),
    }
    const result = await aprovarPendentesSemConflito({
      rows: [
        row('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { iniciado_em: '2020-01-02T18:00:00.000Z', encerrado_em: '2020-01-02T19:00:00.000Z' }),
        row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
        row('cccccccc-cccc-4ccc-8ccc-cccccccccccc', { iniciado_em: '2020-01-02T12:00:00.000Z', encerrado_em: '2020-01-02T13:00:00.000Z' }),
        row('dddddddd-dddd-4ddd-8ddd-dddddddddddd', { status: 'devolvida' }),
      ],
      tenantId: MARCA,
      revisorId: MARCA,
      recordHistory: async () => {},
      normalizeOfficialMetrics: passthrough,
      session,
      recalculateMonth: async (_db, lift) => { lifts.push(lift) },
    })

    expect(gravadas).toBe(2)
    expect(sqls.filter((sql) => String(sql).includes('lote-aprovacao:contexto'))).toHaveLength(1)
    expect(result.approved.map((item) => item.id)).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ])
    expect(result.skipped_conflito.map((item) => item.id)).toEqual(['cccccccc-cccc-4ccc-8ccc-cccccccccccc'])
    expect(result.skipped_conflito[0].reason).toMatch(/apresentadora neste horário/)
    expect(lifts).toEqual([{ tenantId: MARCA, apresentadoraId: APRESENTADORA, mesReferencia: '2020-01' }])
    expect(sqls.some((sql) => String(sql).includes('lote-aprovacao:reparar'))).toBe(true)
  })

  it('uma falha não desfaz o envio anterior e o segundo horário da mesma apresentadora fica de fora', async () => {
    let gravadas = 0
    const session = {
      query: async (sql) => {
        if (String(sql).includes('lote-aprovacao:contexto')) {
          return contexto([
            info('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
            info('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { iniciado_em: '2020-01-02T15:30:00.000Z', encerrado_em: '2020-01-02T16:30:00.000Z' }),
            info('cccccccc-cccc-4ccc-8ccc-cccccccccccc', { iniciado_em: '2020-01-02T18:00:00.000Z', encerrado_em: '2020-01-02T19:00:00.000Z', user_id: '55555555-5555-4555-8555-555555555555', apresentadora_id: '66666666-6666-4666-8666-666666666666' }),
          ])
        }
        gravadas += 1
        if (gravadas === 2) throw new Error('marca inválida')
        return { rows: [{ outcome: 'approved', live_id: LIVE }] }
      },
      transaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
    }
    const result = await aprovarPendentesSemConflito({
      rows: [
        row('cccccccc-cccc-4ccc-8ccc-cccccccccccc', { iniciado_em: '2020-01-02T18:00:00.000Z', encerrado_em: '2020-01-02T19:00:00.000Z' }),
        row('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { iniciado_em: '2020-01-02T15:30:00.000Z', encerrado_em: '2020-01-02T16:30:00.000Z' }),
        row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      ],
      tenantId: MARCA,
      revisorId: MARCA,
      recordHistory: async () => {},
      normalizeOfficialMetrics: passthrough,
      session,
      recalculateMonth: async () => {},
    })

    expect(result.approved.map((item) => item.id)).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'])
    expect(result.skipped_conflito.map((item) => item.id)).toEqual(['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'])
    expect(result.failed.map((item) => item.id)).toEqual(['cccccccc-cccc-4ccc-8ccc-cccccccccccc'])
    expect(gravadas).toBe(2)
  })

  it('aprova dois envios que a aprovação individual aceita e pula só a sobreposição da apresentadora', async () => {
    const contextoSql = __test.contextoSql()
    expect(contextoSql).not.toMatch(/FOR UPDATE/i)
    expect(contextoSql).not.toMatch(/pending_peer/)
    expect(contextoSql).not.toMatch(/em_conciliacao/)
    const gravadas = []
    const session = {
      query: async (sql) => {
        if (String(sql).includes('lote-aprovacao:contexto')) {
          return contexto([
            info('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { em_conciliacao: true }),
            info('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', {
              em_conciliacao: true,
              apresentadora_id: '66666666-6666-4666-8666-666666666666',
              user_id: '55555555-5555-4555-8555-555555555555',
            }),
            info('cccccccc-cccc-4ccc-8ccc-cccccccccccc', {
              conflito_apresentadora: true,
              iniciado_em: '2020-01-02T18:00:00.000Z',
              encerrado_em: '2020-01-02T19:00:00.000Z',
            }),
          ])
        }
        if (String(sql).includes('lote-aprovacao:gravar')) {
          gravadas.push(sql)
          expect(sql).not.toMatch(/marcas/i)
          return { rows: [{ outcome: 'approved', live_id: LIVE }] }
        }
        throw new Error(`query inesperada: ${String(sql).slice(0, 80)}`)
      },
      transaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
    }
    const result = await aprovarPendentesSemConflito({
      rows: [
        row('cccccccc-cccc-4ccc-8ccc-cccccccccccc', { iniciado_em: '2020-01-02T18:00:00.000Z', encerrado_em: '2020-01-02T19:00:00.000Z' }),
        row('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
        row('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      ],
      tenantId: MARCA,
      revisorId: MARCA,
      recordHistory: async () => {},
      normalizeOfficialMetrics: passthrough,
      session,
      recalculateMonth: async () => {},
    })

    expect(gravadas).toHaveLength(2)
    expect(result.approved.map((item) => item.id)).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ])
    expect(result.skipped_conflito).toEqual([
      expect.objectContaining({
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        reason: 'Já existe uma live oficial desta apresentadora neste horário. Confira o registro e use Vincular live existente.',
      }),
    ])
    expect(result.failed).toEqual([])
    expect(result.skipped.filter((item) => item.conflito).map((item) => item.id)).toEqual(['cccccccc-cccc-4ccc-8ccc-cccccccccccc'])
  })
})
