import { describe, expect, it, vi } from 'vitest'
import {
  aprovarPendentesSemConflito,
  conflitoHorarioError,
  motivoConflitoAprovacaoSemCabine,
} from '../src/services/portal-apresentadora-aprovacao.js'

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
      expect(sql).toContain('pending_peer')
      return { rows: [{ em_conciliacao: false, conflito_apresentadora: true }] }
    })
    await expect(motivoConflitoAprovacaoSemCabine({ query }, { tenantId: MARCA, submissionId: MARCA }))
      .resolves.toBe('Já existe uma live oficial desta apresentadora neste horário. Confira o registro e use Vincular live existente.')
  })

  it('recusa a conciliação que a lista já mostra, mesmo sem sobreposição da apresentadora', async () => {
    const query = vi.fn(async () => ({ rows: [{ em_conciliacao: true, conflito_apresentadora: false }] }))
    await expect(motivoConflitoAprovacaoSemCabine({ query }, { tenantId: MARCA, submissionId: MARCA }))
      .resolves.toBe('Conflito de horário com outra live ou envio da mesma marca.')
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
