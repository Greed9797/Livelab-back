// Setup global de testes (vitest).
//
// O cache em memória de dashboard (src/lib/dashboard-cache.js) é um Map em nível
// de módulo que persiste entre testes do mesmo processo. Sem limpeza, um teste
// que faz GET num endpoint cacheado (ex.: /v1/financeiro/resumo) contamina o
// próximo teste com a MESMA chave (tenant+período) — que recebe um HIT do mock
// anterior em vez de computar o seu. Limpamos antes de cada teste para isolar.
import { beforeEach } from 'vitest'
import { _clearDashboardCache } from '../src/lib/dashboard-cache.js'

beforeEach(() => {
  _clearDashboardCache()
})
