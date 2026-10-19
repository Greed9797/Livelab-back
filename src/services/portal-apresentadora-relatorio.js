import { buscarFechamentoApresentadoras, buscarHistoricoLivesApresentadora } from './remuneracao-apresentadoras.js'

// O PDF da apresentadora usa o mesmo fechamento e o mesmo histórico do gestor.
// O id pedido, se vier, só pode ser o perfil ligado ao usuário.
export function rejectOtherPresenterReport(profileId, requestedId) {
  if (requestedId == null || requestedId === '') return
  if (String(requestedId) !== String(profileId)) {
    const error = new Error('Você só pode baixar o seu próprio relatório.')
    error.statusCode = 403
    throw error
  }
}

export async function getOwnMonthlyPresenterReport(db, { tenantId, apresentadoraId, nome, mes }) {
  const fechamento = await buscarFechamentoApresentadoras(db, { tenantId, apresentadoraId, mes })
  const detalhes = await buscarHistoricoLivesApresentadora(db, { tenantId, apresentadoraId, mes })
  const row = fechamento.apresentadoras.find((item) => item.apresentadora_id === apresentadoraId)
  return {
    mes,
    fechamento: row ?? {
      apresentadora_id: apresentadoraId,
      nome,
      fixo: 0,
      comissao: 0,
      adicionais: 0,
      total: 0,
      extras: [],
    },
    detalhes,
  }
}
