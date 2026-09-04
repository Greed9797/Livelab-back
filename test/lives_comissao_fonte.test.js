import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// A coluna "Comissão" da tabela de lives mostrava "—" em 571 de 624 lives dos últimos 60 dias
// enquanto o Financeiro mostrava comissão para 497 delas. A lista lia lives.comissao_apresentadora_*
// (snapshot do apresentadoras.comissao_pct chapado, 0 em 13 de 18 cadastros) e o Financeiro lia
// vendas_atribuidas (motor com faixas). Este teste prende a lista e o detalhe à mesma fonte.
const src = readFileSync(new URL('../src/routes/lives.js', import.meta.url), 'utf8')

function blocoDaRota(prefixo) {
  const inicio = src.indexOf(prefixo)
  expect(inicio, `rota ${prefixo} não encontrada`).toBeGreaterThan(-1)
  // bloco inteiro da rota: da declaração até a próxima rota registrada no app
  const fim = src.indexOf('\n  app.', inicio + 1)
  return src.slice(inicio, fim === -1 ? undefined : fim)
}

describe('GET /v1/lives e /v1/lives/:id — comissão da apresentadora vem do motor', () => {
  for (const rota of ["app.get('/v1/lives',", "app.get('/v1/lives/:id',"]) {
    it(`${rota} soma vendas_atribuidas da live e só cai no snapshot como fallback`, () => {
      const bloco = blocoDaRota(rota)
      expect(bloco).toMatch(/SUM\(va_c\.comissao_apresentadora\)[\s\S]*va_c\.origem = 'live'[\s\S]*va_c\.origem_id = l\.id[\s\S]*l\.comissao_apresentadora_valor\s*\)\s*AS comissao_apresentadora/)
      expect(bloco).toMatch(/NULLIF\(SUM\(va_c\.gmv\), 0\)[\s\S]*l\.comissao_apresentadora_pct\s*\)\s*AS pct_apresentadora/)
      // o snapshot cru não pode voltar a ser a fonte primária
      expect(bloco).not.toMatch(/^\s*l\.comissao_apresentadora_valor AS comissao_apresentadora/m)
    })
  }
})
