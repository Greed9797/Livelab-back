import { centsToExactMoney, exactMoneyToCents } from './money.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const erro = (message, code, statusCode = 400) => Object.assign(new Error(message), { code, statusCode })

/** A chave é obrigatória quando a chamada escolhe uma parcela do saldo. */
export function requisicaoPerda({ chaveOperacao, tipo, origemTipo, ref, motivo, valor }) {
  if (valor != null && !chaveOperacao) throw erro('chave_operacao é obrigatória para valor parcial', 'IDEMPOTENCY_KEY_REQUIRED')
  if (chaveOperacao != null && !UUID.test(String(chaveOperacao))) throw erro('chave_operacao inválida', 'INVALID_IDEMPOTENCY_KEY')
  if (!chaveOperacao) return null
  return {
    tipo, origem_tipo: origemTipo, ref: String(ref),
    motivo: String(motivo ?? '').trim(),
    valor: valor == null ? null : centsToExactMoney(exactMoneyToCents(valor)),
  }
}

/** Chamar sob lock do tenant/título. Mesmo UUID com payload diferente é conflito. */
export async function perdaJaRegistrada(db, { tenantId, chaveOperacao, requisicao }) {
  if (!chaveOperacao) return false
  const { rows } = await db.query(
    `SELECT requisicao FROM financeiro_perdas_eventos
      WHERE tenant_id = $1::uuid AND chave_operacao = $2::uuid`,
    [tenantId, chaveOperacao],
  )
  if (!rows[0]) return false
  const salvo = rows[0].requisicao
  if (Object.keys(requisicao).some((key) => salvo?.[key] !== requisicao[key])) {
    throw erro('chave_operacao já usada com conteúdo diferente', 'IDEMPOTENCY_KEY_CONFLICT', 409)
  }
  return true
}
