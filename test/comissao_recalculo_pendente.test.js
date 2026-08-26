import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Comissão que congela errada em silêncio.
 *
 * O recálculo pós-edição roda FORA da transação, em fire-and-forget. Se falha — ou se o
 * processo morre entre o COMMIT e a chamada — a vendas_atribuidas fica com o valor ANTIGO,
 * não-zero. E o cron de reconciliação só varria `COALESCE(comissao_apresentadora,0) = 0`:
 * comissão errada mas não-zero nunca era reprocessada. Ficava errada para sempre, sem erro
 * e sem log.
 *
 * A correção é uma intenção durável: marca gravada na MESMA transação da edição, limpa só
 * pelo recálculo que confirmar. Estes testes fixam as invariantes que fazem isso funcionar —
 * quebrar qualquer uma reabre a janela.
 */
const lives = readFileSync(new URL('../src/routes/lives.js', import.meta.url), 'utf8')
const cron = readFileSync(new URL('../src/jobs/recalcular_comissoes.js', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')
const migration = readFileSync(
  new URL('../migrations/136_comissao_recalculo_pendente.sql', import.meta.url), 'utf8')
const listaMigrations = readFileSync(new URL('../apply_migrations.js', import.meta.url), 'utf8')

describe('comissão pendente — a marca é gravada com a edição', () => {
  it('a migration está na lista hardcoded (senão é ignorada em silêncio)', () => {
    expect(listaMigrations).toContain('136_comissao_recalculo_pendente.sql')
  })

  it('a coluna nasce FALSE e NOT NULL — nenhuma live existente vira trabalho retroativo', () => {
    expect(migration).toMatch(/comissao_recalculo_pendente BOOLEAN NOT NULL DEFAULT FALSE/i)
  })

  it('o índice é PARCIAL — a varredura não pode custar escrita em toda live', () => {
    expect(migration).toMatch(/CREATE INDEX[\s\S]*WHERE comissao_recalculo_pendente/i)
  })

  it('a marca entra pelo addField, ou seja, no UPDATE da própria transação', () => {
    expect(lives).toMatch(/addField\('comissao_recalculo_pendente', true\)/)
  })

  it('a condição de marcar é a MESMA que dispara o recálculo', () => {
    // Duas condições separadas divergiriam: marcar sem recalcular gera trabalho eterno,
    // recalcular sem marcar traz a comissão congelada de volta.
    expect(lives).toMatch(/const precisaRecalcularComissao = gmvMudou/)
    expect(lives).toMatch(/if \(precisaRecalcularComissao\) addField/)
    expect(lives).toMatch(/if \(precisaRecalcularComissao && !rateioRecalculadoNaTransacao\) \{/)
  })

  it('a marca só é limpa DEPOIS do recálculo bem-sucedido', () => {
    const bloco = lives
      .split('if (precisaRecalcularComissao && !rateioRecalculadoNaTransacao) {')[1]
      ?.slice(0, 1600) ?? ''
    const posCalculo = bloco.indexOf('calcularComissoesDaLive')
    const posLimpeza = bloco.indexOf('comissao_recalculo_pendente = FALSE')
    expect(posCalculo).toBeGreaterThan(-1)
    expect(posLimpeza).toBeGreaterThan(posCalculo)
  })
})

describe('comissão pendente — o cron reprocessa quem ficou marcado', () => {
  it('existe uma varredura por comissao_recalculo_pendente', () => {
    expect(cron).toMatch(/WHERE l\.comissao_recalculo_pendente/)
  })

  it('recálculo e limpeza da marca ficam na MESMA transação', () => {
    const bloco = cron.split('WHERE l.comissao_recalculo_pendente')[1] ?? ''
    const calc = bloco.indexOf('calcularComissoesDaLive')
    const limpa = bloco.indexOf('comissao_recalculo_pendente = FALSE')
    const commit = bloco.indexOf("COMMIT")
    expect(calc).toBeGreaterThan(-1)
    expect(limpa).toBeGreaterThan(calc)
    expect(commit).toBeGreaterThan(limpa) // limpeza antes do COMMIT: ou vale tudo, ou nada
  })

  it('falha no reprocessamento faz ROLLBACK e mantém a marca', () => {
    const bloco = cron.split('WHERE l.comissao_recalculo_pendente')[1] ?? ''
    expect(bloco).toMatch(/ROLLBACK/)
    expect(bloco).toMatch(/segue marcada/)
  })
})

describe('ads_gmv — o campo que manda no GMV precisa deixar rastro', () => {
  // ads_gmv é o topo de COALESCE(ads_gmv, manual_gmv, fat_gerado): mudá-lo muda o número de
  // todos os dashboards. Era o único dos três sem registro — dava para alterar o GMV exibido
  // sem deixar como responder "quem mexeu, e quando".
  it('grava revisão em live_metric_revisions', () => {
    expect(lives).toMatch(/VALUES \(\$1, \$2, 'ads_gmv'/)
  })

  it('entra no diff do audit_log junto dos outros campos de GMV', () => {
    const bloco = lives.split('const auditFields = [')[1]?.split(']')[0] ?? ''
    expect(bloco).toContain("'ads_gmv'")
    expect(bloco).toContain("'fat_gerado'")
    expect(bloco).toContain("'manual_gmv'")
  })

  it('só registra quando o valor realmente muda', () => {
    expect(lives).toMatch(/d\.ads_gmv !== undefined && d\.ads_gmv !== live\.ads_gmv/)
  })
})

describe('cache da Home — invalidação centralizada', () => {
  it('o hook global invalida também o cache próprio da Home', () => {
    // Antes cada rota tinha que lembrar; encerrar uma live não lembrava, e a Home ficava
    // até 45s no total anterior. Flagrado em monitor: live encerrada, +R$385 no banco,
    // número velho na tela.
    const hook = app.split("app.addHook('onResponse'")[1]?.slice(0, 900) ?? ''
    expect(hook).toContain('invalidateTenant(tenantId)')
    expect(hook).toContain('invalidateHomeDashboard(tenantId)')
  })
})
