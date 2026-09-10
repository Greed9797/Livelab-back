import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { READ_AGENDA, READ_CABINES, READ_LIVES, WRITE_LIVES } from '../src/config/role_groups.js'
import { MIGRATIONS_LIST } from '../apply_migrations.js'

describe('portal da apresentadora — fronteiras de autorização', () => {
  it('mantém apresentadora nas rotas operacionais genéricas até o front migrar ao portal', () => {
    // O portal (/v1/portal/apresentadora/*) existe no backend, mas o front ainda
    // consome as rotas genéricas (/v1/lives, /v1/agenda) na tela da apresentadora.
    // Remover os papéis daqui quebra a produção (403 "Acesso não autorizado
    // para este papel", ex.: Stela). Reavaliar quando o front usar o portal.
    for (const group of [READ_CABINES, READ_LIVES, WRITE_LIVES, READ_AGENDA]) {
      expect(group).toContain('apresentador')
      expect(group).toContain('apresentadora')
    }
  })

  it('registra a migração aditiva e mantém relato pendente fora de lives', async () => {
    expect(MIGRATIONS_LIST).toContain('144_portal_apresentadora_submissoes.sql')
    expect(MIGRATIONS_LIST).toContain('146_portal_apresentadora_metricas.sql')
    const migration = await readFile(new URL('../migrations/144_portal_apresentadora_submissoes.sql', import.meta.url), 'utf8')
    expect(migration).toContain("status IN ('pendente', 'devolvida', 'aprovada', 'cancelada')")
    expect(migration).toContain('live_oficial_id UUID REFERENCES lives')
    expect(migration).toContain('apresentadora_live_submissao_historico')
    expect(migration).toContain('snapshot JSONB NOT NULL')
  })

  it('mantém métricas de funil opcionais e concede apenas as colunas canônicas ao runtime do portal', async () => {
    const migration = await readFile(new URL('../migrations/146_portal_apresentadora_metricas.sql', import.meta.url), 'utf8')
    for (const column of ['live_impressions_declaradas', 'manual_views_declaradas', 'live_impressions_oficiais', 'manual_views_oficiais']) {
      expect(migration).toContain(column)
    }
    expect(migration).toContain('GRANT INSERT (live_impressions, manual_views) ON lives TO livelab_portal_runtime')
    expect(migration).toContain('apresentadora_remuneracao_adicionais')
  })

  it('persiste um snapshot allowlisted da versão, nunca um objeto vazio', async () => {
    const route = await readFile(new URL('../src/routes/portal_apresentadora.js', import.meta.url), 'utf8')
    const history = route.slice(route.indexOf('function recordHistory'), route.indexOf('async function inSubmissionTransaction'))
    expect(history).toContain('jsonb_build_object')
    expect(history).toContain("'gmv_declarado'")
    expect(history).toContain("'live_impressions_oficiais'")
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
