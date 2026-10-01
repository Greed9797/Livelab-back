// Classe do custo ('fixo' | 'variavel') — regra ÚNICA do financeiro (SPEC v3).
//
//   1. override explícito: item.classe_custo (linha de custos) ou, na falta dele,
//      item.classe_custo_recorrente (recorrente de origem) — migration 171;
//   2. senão, derivada da origem:
//        fixo     = recorrente | parcela | apresentadora com componente 'fixo'
//        variavel = manual (pontual) | apresentadora com componente 'variavel'
//                   (ou sem componente: contrato antigo) | imposto
//   Imposto é SEMPRE variável (não aceita override). Receita → null.
//
// Re-exportada por services/financeiro-agregador.js. Pura (sem banco).

export const CLASSES_CUSTO = Object.freeze(['fixo', 'variavel'])

const ehClasse = (v) => v === 'fixo' || v === 'variavel'

export function classeDoItem(item) {
  if (!item || item.natureza === 'receita') return null
  if (item.origem === 'imposto') return 'variavel'
  if (item.origem === 'apresentadora') return item.componente === 'fixo' ? 'fixo' : 'variavel'
  if (ehClasse(item.classe_custo)) return item.classe_custo
  if (ehClasse(item.classe_custo_recorrente)) return item.classe_custo_recorrente
  if (item.origem === 'recorrente' || item.origem === 'parcela') return 'fixo'
  return 'variavel'
}
