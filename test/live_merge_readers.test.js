import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { activeLiveJoinSql, activeLiveSql } from '../src/lib/live-merge-sql.js'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('live merge operational reader guard', () => {
  it('excludes absorbed sources and undone destinations', () => {
    expect(activeLiveSql('live')).toBe('live.uniao_destino_id IS NULL AND live.uniao_desfeita_em IS NULL')
    expect(activeLiveJoinSql('live')).toBe('AND live.uniao_destino_id IS NULL AND live.uniao_desfeita_em IS NULL')
  })

  it('keeps core operational readers on the same guard', () => {
    for (const path of [
      'src/routes/lives.js', 'src/routes/analytics.js', 'src/routes/financeiro.js',
      'src/routes/relatorios.js', 'src/lib/performance-rollups.js', 'src/lib/operacional.js',
    ]) expect(read(path), path).toContain('activeLiveSql')
  })

  it('does not offer or approve a merged live for a new submission link', () => {
    const portal = read('src/routes/portal_apresentadora.js')
    expect(portal).toMatch(/l\.status='encerrada'[\s\S]{0,300}l\.uniao_destino_id IS NULL AND l\.uniao_desfeita_em IS NULL/)
    expect(portal).toContain('live_oficial_id AS live_oficial_origem_id')
    expect(portal).toContain('COALESCE(origem.uniao_destino_id,s.live_oficial_id) AS live_oficial_id')
  })
})
