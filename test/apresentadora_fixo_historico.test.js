import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { presenterFixedSql, presenterFixedCapSql, presenterFixedAtSql, DEFAULT_APRESENTADORA_FIXO, MAX_APRESENTADORA_FIXO } from '../src/config/presenter_defaults.js'

/**
 * Fixo mensal que reescrevia o passado.
 *
 * apresentadoras.fixo era um valor único "atual" e TODO relatório de mês fechado lia
 * dele. Reajustar um salário mudava retroativamente a folha de todos os meses já
 * fechados: quem imprimisse o PDF de julho em agosto via um número, e em setembro
 * outro. A migration 137 grava uma linha por mudança de valor.
 *
 * Estes testes fixam as invariantes que fazem isso funcionar sem mexer em nenhum
 * número exibido hoje. Quebrar qualquer uma volta a mover dinheiro de mês fechado —
 * em silêncio, que é como o bug original passou despercebido.
 */
const migration = readFileSync(new URL('../migrations/137_apresentadora_fixo_historico.sql', import.meta.url), 'utf8')
const listaMigrations = readFileSync(new URL('../apply_migrations.js', import.meta.url), 'utf8')
const rollups = readFileSync(new URL('../src/lib/performance-rollups.js', import.meta.url), 'utf8')
const financeiro = readFileSync(new URL('../src/routes/financeiro.js', import.meta.url), 'utf8')

const posicao = (texto, agulha) => texto.indexOf(agulha)

describe('migration 137 — a tabela nasce sem mudar nenhum número', () => {
  it('está na lista hardcoded (senão é ignorada em silêncio)', () => {
    expect(listaMigrations).toContain('137_apresentadora_fixo_historico.sql')
  })

  it('o backfill grava o valor ATUAL vigente desde 1900 — toda janela encontra a linha', () => {
    // É isso que sustenta "nenhum número muda ao aplicar". Usar data_inicio do contrato
    // deixaria janelas anteriores sem linha.
    expect(migration).toMatch(/INSERT INTO apresentadora_fixo_historico[\s\S]*DATE '1900-01-01'[\s\S]*FROM apresentadoras/i)
  })

  it('o backfill roda ANTES de ligar o RLS', () => {
    // O runner usa o pool de sistema, que por invariante nunca seta app.tenant_id.
    // Com RLS já ativo e role sem BYPASSRLS o INSERT grava zero linhas SEM erro, e a
    // migration fica marcada como aplicada para sempre.
    const backfill = posicao(migration, 'INSERT INTO apresentadora_fixo_historico')
    const rls = posicao(migration, 'ENABLE ROW LEVEL SECURITY')
    expect(backfill).toBeGreaterThan(-1)
    expect(rls).toBeGreaterThan(backfill)
  })

  it('backfill é idempotente — rodar duas vezes não duplica', () => {
    const trecho = migration.slice(posicao(migration, 'INSERT INTO apresentadora_fixo_historico'))
    expect(trecho).toMatch(/ON CONFLICT \(tenant_id, apresentadora_id, vigencia_inicio\) DO NOTHING/i)
  })

  it('NÃO usa CONCURRENTLY', () => {
    // CONCURRENTLY faz o runner abandonar a transação e cair num split ingênuo por ';'
    // que quebra o corpo $$ da função e pode deixar o backfill aplicado sem marcar a
    // migration — reexecutando o arquivo inteiro no próximo boot.
    expect(migration).not.toMatch(/\bCONCURRENTLY\b/i)
  })

  it('UNIQUE por (tenant, apresentadora, vigência) — desempata duas edições no mesmo dia', () => {
    expect(migration).toMatch(/CREATE UNIQUE INDEX[\s\S]*\(tenant_id, apresentadora_id, vigencia_inicio\)/i)
  })

  it('RLS com USING e WITH CHECK', () => {
    const policy = migration.slice(posicao(migration, 'CREATE POLICY'))
    expect(policy).toMatch(/USING \(tenant_id = current_setting\('app\.tenant_id', true\)::uuid\)/)
    expect(policy).toMatch(/WITH CHECK \(tenant_id = current_setting\('app\.tenant_id', true\)::uuid\)/)
  })
})

describe('migration 137 — o registro é do BANCO, não de uma rota', () => {
  // São 5 caminhos de escrita de apresentadoras.fixo e o dominante é PATCH /v1/usuarios/:id
  // (a maioria das apresentadoras tem login). Instrumentar rota por rota deixaria buracos,
  // e um rollback de deploy congelaria o histórico no valor velho.
  it('trigger na coluna fixo, em INSERT e em UPDATE', () => {
    expect(migration).toMatch(/CREATE TRIGGER apresentadora_fixo_historico_ins\s*\nAFTER INSERT ON apresentadoras/i)
    expect(migration).toMatch(/CREATE TRIGGER apresentadora_fixo_historico_upd\s*\nAFTER UPDATE OF fixo ON apresentadoras/i)
  })

  it('não tenta usar TG_OP na cláusula WHEN', () => {
    // Um trigger único "AFTER INSERT OR UPDATE ... WHEN (TG_OP = ... OR NEW.fixo ...)"
    // é recusado pelo Postgres: `column "tg_op" does not exist`. WHEN de INSERT também
    // não enxerga OLD. Daí serem dois triggers.
    const semComentarios = migration.replace(/^\s*--.*$/gm, '')
    const whens = semComentarios.match(/WHEN \([^)]*\)/g) ?? []
    expect(whens.length).toBeGreaterThan(0)
    for (const w of whens) expect(w.toUpperCase()).not.toContain('TG_OP')
  })

  it('só grava quando o valor muda de verdade', () => {
    // Sem isso, salvar a foto ou renomear a apresentadora criaria linha de histórico:
    // o formulário reenvia o fixo em todo salvamento.
    expect(migration).toMatch(/WHEN \(NEW\.fixo IS DISTINCT FROM OLD\.fixo\)/i)
  })

  it('segunda edição do mesmo dia sobrescreve em vez de empatar', () => {
    expect(migration).toMatch(/ON CONFLICT \(tenant_id, apresentadora_id, vigencia_inicio\)\s*\n?\s*DO UPDATE SET valor = EXCLUDED\.valor/i)
  })

  it('o trigger de INSERT abre a vigência em 1900, igual ao backfill', () => {
    // Um valor inicial não tem "antes". Carimbar a data de cadastro deixaria todo mês
    // anterior sem linha, caindo no valor mutável de apresentadoras.fixo — e quem
    // entrasse depois desta migration continuaria com o mês fechado flutuando.
    const fn = migration.slice(posicao(migration, 'CREATE OR REPLACE FUNCTION'), posicao(migration, 'DROP TRIGGER'))
    expect(fn).toMatch(/TG_OP = 'INSERT' THEN DATE '1900-01-01'/)
  })

  it('vigência no fuso de São Paulo, nunca CURRENT_DATE', () => {
    // O processo roda em UTC no Railway: entre 21h e meia-noite CURRENT_DATE já é amanhã,
    // e o reajuste entraria num dia que ainda não começou para o usuário.
    const fn = migration.slice(posicao(migration, 'CREATE OR REPLACE FUNCTION'), posicao(migration, 'DROP TRIGGER'))
    expect(fn).toMatch(/\(now\(\) AT TIME ZONE 'America\/Sao_Paulo'\)::date/)
    expect(fn).not.toMatch(/CURRENT_DATE/)
  })
})

describe('presenterFixedCapSql — o piso/teto não mudou', () => {
  it('presenterFixedSql continua gerando a mesma normalização de antes', () => {
    const sql = presenterFixedSql('a')
    expect(sql).toContain(`COALESCE(a.fixo, 0) <= 0`)
    expect(sql).toContain(`> ${MAX_APRESENTADORA_FIXO}`)
    expect(sql).toContain(`THEN ${DEFAULT_APRESENTADORA_FIXO}`)
  })

  it('a MESMA regra vale para o valor histórico', () => {
    // Duas normalizações diferentes dariam dois números para a mesma apresentadora
    // dependendo da tela.
    const cru = presenterFixedSql('a')
    const cap = presenterFixedCapSql('a.fixo')
    const semParenteses = (s) => s.replace(/[()]/g, '').replace(/\s+/g, ' ')
    expect(semParenteses(cap)).toBe(semParenteses(cru))
  })
})

describe('presenterFixedAtSql — valor vigente numa data', () => {
  const sql = presenterFixedAtSql('a', "'2026-07-31'::date")

  it('cai no valor de cadastro quando não há histórico', () => {
    // Nunca devolve 0 nem inventa o padrão: apresentadora sem linha mantém o número de antes.
    expect(sql).toContain('COALESCE(')
    expect(sql).toContain('a.fixo)')
  })

  it('filtra tenant E apresentadora', () => {
    expect(sql).toContain('h.tenant_id = a.tenant_id')
    expect(sql).toContain('h.apresentadora_id = a.id')
  })

  it('pega a última vigência até a data, com desempate estável', () => {
    expect(sql).toMatch(/h\.vigencia_inicio <= \('2026-07-31'::date\)/)
    expect(sql).toMatch(/ORDER BY h\.vigencia_inicio DESC, h\.id DESC\s*\n?\s*LIMIT 1/)
  })
})

describe('ranking / comissões — resolve o fixo uma vez por apresentadora', () => {
  it('usa CTE, não subquery correlacionada dentro do MAX()', () => {
    // combined tem uma linha por live e por venda de vídeo: correlacionar ali
    // reexecutaria o lookup por linha, e este SQL serve a Home (polling 15s) e o
    // ranking público sem autenticação.
    expect(rollups).toMatch(/fixo_vigente AS \(\s*\n\s*SELECT DISTINCT ON \(apresentadora_id\)/)
    const usos = rollups.match(/MAX\(\$\{presenterFixedCapSql\('COALESCE\(fv\.valor, a\.fixo\)'\)\}\)/g) ?? []
    expect(usos.length).toBe(2) // fixo e total_recebido
    // presenterFixedAtSql é a versão correlacionada: correta no DRE, proibida aqui.
    expect(rollups).not.toContain('presenterFixedAtSql')
  })

  it('a CTE filtra tenant_id explicitamente', () => {
    // O ranking público roda pelo pool de sistema, onde o RLS não é aplicado.
    const cte = rollups.slice(posicao(rollups, 'fixo_vigente AS ('))
    expect(cte.slice(0, 400)).toContain('WHERE tenant_id = $1::uuid')
  })

  it('normaliza o fim EXCLUSIVO da janela com -1 dia', () => {
    // $3 é exclusivo (va.data < $3). Sem o -1, um reajuste feito no dia 1º de setembro
    // entraria no fechamento de AGOSTO.
    const cte = rollups.slice(posicao(rollups, 'fixo_vigente AS ('))
    expect(cte.slice(0, 400)).toMatch(/vigencia_inicio <= \(\$3::date - 1\)/)
  })
})

describe('DRE — cada mês usa o salário daquele mês', () => {
  it('o fixo é resolvido DENTRO da soma por mês, não multiplicando o total', () => {
    // Antes: fixo_atual * SUM(fatores). Um reajuste reescrevia todos os meses do
    // intervalo, inclusive competências fechadas.
    const bloco = financeiro.slice(posicao(financeiro, 'const fixoApresentadoras'))
    const trecho = bloco.slice(0, 900)
    const soma = trecho.indexOf('SELECT SUM(')
    const fixo = trecho.indexOf('presenterFixedAtSql')
    const series = trecho.indexOf('generate_series')
    expect(soma).toBeGreaterThan(-1)
    expect(fixo).toBeGreaterThan(soma)
    expect(series).toBeGreaterThan(fixo)
  })

  it('a data de referência é o último dia do mês da parcela', () => {
    const bloco = financeiro.slice(posicao(financeiro, 'const fixoApresentadoras'), posicao(financeiro, 'const custosManuais'))
    expect(bloco).toContain("((gs.mes + interval '1 month' - interval '1 day')::date)")
  })
})
