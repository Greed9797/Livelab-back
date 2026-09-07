import { buscarFechamentoApresentadoras } from './remuneracao-apresentadoras.js'

// Same monthly computation as Financeiro/PDF, scoped before rows leave SQL.
export async function getOwnPortalRemuneration(db, { tenantId, apresentadoraId, mes }) {
  if (!apresentadoraId) throw new TypeError('Perfil de apresentadora obrigatório')
  const result = await buscarFechamentoApresentadoras(db, { tenantId, apresentadoraId, mes })
  const own = result.apresentadoras.find((item) => item.apresentadora_id === apresentadoraId)
  return { mes, fixo: own?.fixo ?? 0, comissao: own?.comissao ?? 0,
    adicionais: own?.adicionais ?? 0, total: own?.total ?? 0, extras: own?.extras ?? [] }
}
