import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { READ_AGENDA, READ_CABINES, READ_LIVES, WRITE_LIVES } from '../src/config/role_groups.js'
import { MIGRATIONS_LIST } from '../apply_migrations.js'

describe('portal da apresentadora — fronteiras de autorização', () => {
  it('não mantém apresentadora nas rotas operacionais genéricas', () => {
    for (const group of [READ_CABINES, READ_LIVES, WRITE_LIVES, READ_AGENDA]) {
      expect(group).not.toContain('apresentador')
      expect(group).not.toContain('apresentadora')
    }
  })

  it('registra a migração aditiva e mantém relato pendente fora de lives', async () => {
    expect(MIGRATIONS_LIST).toContain('144_portal_apresentadora_submissoes.sql')
    const migration = await readFile(new URL('../migrations/144_portal_apresentadora_submissoes.sql', import.meta.url), 'utf8')
    expect(migration).toContain("status IN ('pendente', 'devolvida', 'aprovada', 'cancelada')")
    expect(migration).toContain('live_oficial_id UUID REFERENCES lives')
    expect(migration).toContain('apresentadora_live_submissao_historico')
    expect(migration).toContain('snapshot JSONB NOT NULL')
  })

  it('persiste um snapshot allowlisted da versão, nunca um objeto vazio', async () => {
    const route = await readFile(new URL('../src/routes/portal_apresentadora.js', import.meta.url), 'utf8')
    const history = route.slice(route.indexOf('function recordHistory'), route.indexOf('async function inSubmissionTransaction'))
    expect(history).toContain('jsonb_build_object')
    expect(history).toContain("'gmv_declarado'")
    expect(history).toContain("'live_oficial_id'")
    expect(history).not.toContain('JSON.stringify(snapshot)')
  })

  it('não devolve remuneração de colegas no ranking público', async () => {
    const route = await readFile(new URL('../src/routes/comissoes.js', import.meta.url), 'utf8')
    const publicSection = route.slice(route.indexOf("app.get('/v1/public/ranking/apresentadoras'"), route.indexOf("app.get('/v1/comissoes/marcas'"))
    expect(publicSection).not.toContain('total_recebido: row.')
    expect(publicSection).not.toContain('comissao_variavel: row.')
    expect(publicSection).not.toContain('fixo: row.')
  })
})
