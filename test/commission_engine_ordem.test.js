// Ordem das apresentadoras no commission-engine.
//
// Os pedidos da live inteira vão para a linha de índice 0 (rateá-los por porcentagem
// arredondaria e a soma deixaria de fechar o total). Sem ORDER BY, a ordem de um
// UNION + DISTINCT é livre: a mesma live recalculada duas vezes podia dar os pedidos a
// pessoas diferentes, e o "quem vendeu quanto" mudava sozinho entre execuções.

import { describe, expect, it, vi } from 'vitest'
import { calcularComissoesDaLive } from '../src/services/commission-engine.js'

const AP1 = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa'
const AP2 = 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb'
const MARCA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function makeDb(apresentadoras) {
  const inserted = []
  let apresentadorasSql = null
  const query = vi.fn(async (sql, values) => {
    if (sql.includes('FROM lives l')) {
      return {
        rows: [{
          id: 'live-1',
          cliente_id: 'cliente-1',
          apresentador_id: 'user-1',
          iniciado_em: '2026-05-20T18:00:00.000Z',
          contrato_id: 'contrato-1',
          comissao_pct: '10',
          valor_fixo_comissao: '0',
          marca_id: MARCA,
          comissao_franquia_pct: '10',
          comissao_franqueadora_pct: '2',
        }],
      }
    }
    if (sql.includes('SELECT DISTINCT ap.id AS apresentadora_id')) {
      apresentadorasSql = sql
      // O Postgres devolveria já ordenado; o mock reproduz a ordem que o ORDER BY impõe.
      return { rows: [...apresentadoras].sort((a, b) => (b.papel === 'principal') - (a.papel === 'principal')) }
    }
    if (sql.includes('FROM vendas_atribuidas')) return { rows: [{ gmv_mes: '0' }] }
    if (sql.includes('FROM apresentadora_comissao_faixas')) return { rows: [] }
    if (sql.includes('INSERT INTO vendas_atribuidas')) {
      // $1..$10 → índices 0..9: apresentadora_id é $4, gmv é $6 e pedidos é $7.
      inserted.push({ apresentadora_id: values[3], gmv: values[5], pedidos: values[6] })
      return { rows: [] }
    }
    return { rows: [] }
  })
  return { db: { query }, inserted, sql: () => apresentadorasSql }
}

describe('commission engine — ordem determinista das apresentadoras', () => {
  it('ordena por papel num nível externo, sem o alias que não existe dentro do DISTINCT', async () => {
    const { db, sql } = makeDb([
      { apresentadora_id: AP1, percentual_rateio: '40.00', gmv_rateado: null, papel: 'apoio' },
      { apresentadora_id: AP2, percentual_rateio: '60.00', gmv_rateado: null, papel: 'principal' },
    ])

    await calcularComissoesDaLive(db, { tenantId: 't1', liveId: 'live-1', gmv: 5000, pedidos: 10 })

    const q = sql()
    expect(q).toContain("ORDER BY (ordenado.papel = 'principal') DESC NULLS LAST")
    expect(q).toContain('ordenado.apresentadora_id ASC')
    // `ap` expõe só id e user_id: ORDER BY ap.apresentadora_id não compilaria, e sob
    // SELECT DISTINCT o Postgres recusa ORDER BY por expressão derivada.
    expect(q).not.toContain('ap.apresentadora_id')
    expect(q.indexOf('ORDER BY')).toBeGreaterThan(q.indexOf(') ordenado'))
  })

  it('dá os pedidos para a principal, e duas execuções dão o mesmo resultado', async () => {
    const linhas = [
      { apresentadora_id: AP1, percentual_rateio: '40.00', gmv_rateado: null, papel: 'apoio' },
      { apresentadora_id: AP2, percentual_rateio: '60.00', gmv_rateado: null, papel: 'principal' },
    ]

    const primeira = makeDb(linhas)
    await calcularComissoesDaLive(primeira.db, { tenantId: 't1', liveId: 'live-1', gmv: 5000, pedidos: 10 })

    // Mesma live, entrada em ordem invertida (é o que um UNION sem ORDER BY pode devolver).
    const segunda = makeDb([...linhas].reverse())
    await calcularComissoesDaLive(segunda.db, { tenantId: 't1', liveId: 'live-1', gmv: 5000, pedidos: 10 })

    expect(primeira.inserted).toEqual(segunda.inserted)
    expect(primeira.inserted[0]).toMatchObject({ apresentadora_id: AP2, pedidos: 10 })
    expect(primeira.inserted[1]).toMatchObject({ apresentadora_id: AP1, pedidos: 0 })
  })
})
