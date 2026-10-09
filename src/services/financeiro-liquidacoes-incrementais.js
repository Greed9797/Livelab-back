import { exactMoneyToCents, centsToExactMoney } from '../lib/money.js'
import { receberTitulo } from './receitas-comercial.js'
import { receberReceitaAvulsa } from './receitas-avulsas.js'
import { pagarCusto } from './custos-plano.js'
import { registrarPagamentoApresentadora } from './apresentadoras-pagamentos.js'
import { pagarImposto } from './financeiro-agregador.js'

const APRESENTADORA_RE = /^apresentadora:([0-9a-f-]{36}):(\d{4}-(?:0[1-9]|1[0-2]))(?::(fixo|variavel))?$/i
const IMPOSTO_RE = /^(?:imposto:)?(\d{4}-(?:0[1-9]|1[0-2]))$/
const TIPOS = new Set(['receita', 'avulsa', 'custo', 'apresentadora', 'imposto'])

function erro(message, code, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}

function dinheiroPositivo(value) {
  let cents
  try { cents = exactMoneyToCents(value) } catch { throw erro('valor_operacao deve ser decimal exato com até duas casas', 'FINANCEIRO_VALOR_INVALIDO') }
  if (cents <= 0n) throw erro('valor_operacao deve ser maior que zero', 'FINANCEIRO_VALOR_INVALIDO')
  return centsToExactMoney(cents)
}

async function acumuladoNoEvento(db, { tenantId, liquidacaoId }) {
  const { rows } = await db.query(
    `WITH alvo AS (
       SELECT id, tenant_id, origem_tipo, origem_id, valor, registrado_em
         FROM financeiro_liquidacoes
        WHERE tenant_id = $1::uuid AND id = $2::uuid
     )
     SELECT (
       COALESCE((
         SELECT SUM(l.valor) FROM financeiro_liquidacoes l, alvo a
          WHERE l.tenant_id = a.tenant_id AND l.origem_tipo = a.origem_tipo AND l.origem_id = a.origem_id
            AND (l.registrado_em, l.id) <= (a.registrado_em, a.id)
       ), 0) - COALESCE((
         SELECT SUM(e.valor) FROM financeiro_estornos e
         JOIN financeiro_liquidacoes original
           ON original.tenant_id = e.tenant_id AND original.id = e.liquidacao_id
         CROSS JOIN alvo a
          WHERE original.tenant_id = a.tenant_id
            AND original.origem_tipo = a.origem_tipo AND original.origem_id = a.origem_id
            AND (e.registrado_em, e.id) <= (a.registrado_em, a.id)
       ), 0)
     )::text AS acumulado
     FROM alvo`,
    [tenantId, liquidacaoId],
  )
  if (!rows[0]) throw erro('Liquidação canônica não encontrada após a operação', 'FINANCEIRO_LIQUIDACAO_AUSENTE', 500)
  return exactMoneyToCents(rows[0].acumulado)
}

function resumoItem(item, evento, { tipo, data, hoje, replay, pagoNoEvento }) {
  const pago = pagoNoEvento
  const operacao = exactMoneyToCents(evento.valor)
  const previsto = exactMoneyToCents(String(item?.valor_previsto ?? item?.valor ?? pago))
  const perdido = exactMoneyToCents(String(item?.valor_perdido ?? 0))
  const restante = previsto - pago - perdido
  const agendada = data > hoje
  return {
    liquidacao_id: evento.id,
    tipo,
    origem_id: evento.origem_id,
    valor_operacao: centsToExactMoney(operacao),
    valor_pago_anterior: centsToExactMoney(pago > operacao ? pago - operacao : 0n),
    valor_pago: centsToExactMoney(pago),
    saldo_restante: centsToExactMoney(restante > 0n ? restante : 0n),
    data,
    replay,
    situacao_data: agendada ? 'agendada' : 'realizada',
    afeta_caixa_atual: !agendada,
    mensagem: replay
      ? 'Operação já registrada; nenhum valor foi duplicado.'
      : agendada
        ? `Operação de R$ ${centsToExactMoney(operacao)} agendada para ${data}.`
        : `Operação de R$ ${centsToExactMoney(operacao)} registrada em ${data}.`,
    item,
  }
}

/**
 * Contrato aditivo: valorOperacao é sempre o incremento desta ação.
 * Os writers de domínio continuam projetando valor_pago acumulado para os
 * clientes legados, enquanto financeiro_liquidacoes preserva cada fato.
 */
export async function registrarBaixaIncremental(db, {
  tenantId, tipo, id, valorOperacao, data, chaveOperacao, ator,
  observacao = null, hoje,
} = {}) {
  if (!TIPOS.has(tipo)) throw erro('tipo de liquidação inválido', 'FINANCEIRO_TIPO_INVALIDO')
  const valor = dinheiroPositivo(valorOperacao)
  let resultado

  if (tipo === 'receita') {
    resultado = await receberTitulo(db, {
      tenantId, id, valorIncremental: valor, dataPagamento: data, observacao,
      chaveOperacao, actorId: ator.id, actorType: ator.tipo, retornoBasico: true,
      retornarLiquidacao: true,
    })
  } else if (tipo === 'avulsa') {
    resultado = await receberReceitaAvulsa(db, {
      tenantId, id, valorPago: valor, dataPagamento: data,
      chaveOperacao, ator, retornarLiquidacao: true,
    })
    if (!resultado) throw erro('Receita avulsa não encontrada', 'RECEITA_AVULSA_NOT_FOUND', 404)
  } else if (tipo === 'custo') {
    resultado = await pagarCusto(db, {
      tenantId, id, valorIncremental: valor, dataPagamento: data,
      hoje, ator, chaveOperacao, retornarLiquidacao: true,
    })
  } else if (tipo === 'apresentadora') {
    const match = APRESENTADORA_RE.exec(id)
    if (!match) throw erro('Pagamento de apresentadora não encontrado', 'APRESENTADORA_NOT_FOUND', 404)
    resultado = await registrarPagamentoApresentadora(db, {
      tenantId, apresentadoraId: match[1], mes: match[2], componente: match[3] ?? 'fixo',
      valorIncremental: valor, dataPagamento: data, observacao,
      userId: ator.tipo === 'usuario' ? ator.id : null, ator, chaveOperacao,
      retornarLiquidacao: true,
    })
    if (!resultado) throw erro('Apresentadora não encontrada nesta unidade', 'APRESENTADORA_NOT_FOUND', 404)
  } else {
    const match = IMPOSTO_RE.exec(id)
    if (!match) throw erro('Imposto não encontrado', 'IMPOSTO_NAO_ENCONTRADO', 404)
    resultado = await pagarImposto(db, {
      tenantId, mes: match[1], valorIncremental: valor, dataPagamento: data,
      observacao, hoje, ator, chaveOperacao, retornarLiquidacao: true,
    })
  }

  const { item, liquidacao } = resultado ?? {}
  if (!liquidacao) throw erro('Liquidação canônica não encontrada após a operação', 'FINANCEIRO_LIQUIDACAO_AUSENTE', 500)
  const evento = {
    id: liquidacao.id, valor: liquidacao.valor, data: liquidacao.data,
    origem_id: liquidacao.origemId,
  }
  const pagoNoEvento = await acumuladoNoEvento(db, { tenantId, liquidacaoId: liquidacao.id })
  return resumoItem(item, evento, {
    tipo, data: evento.data, hoje, replay: liquidacao.replay === true, pagoNoEvento,
  })
}
