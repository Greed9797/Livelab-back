// Pagamentos de apresentadoras como lançamentos financeiros (natureza 'custo').
// valor_previsto = total do fechamento (buscarFechamentoApresentadoras — NÃO reimplementado);
// baixa persistida em apresentadora_pagamentos; status derivado (lancamento-status.js).
import { statusLancamento } from '../lib/lancamento-status.js'
import { buscarFechamentoApresentadoras, dinheiroEmCentavos, ultimoDiaDoMes } from './remuneracao-apresentadoras.js'

export const VENCIMENTO_DIA_PADRAO = 10
export const VENCIMENTO_OFFSET_PADRAO = 1

// Competências (YYYY-MM) cujo mês intersecta [inicio, fim] (strings YYYY-MM-DD).
export function mesesDoPeriodo(inicio, fim) {
  let [a, m] = inicio.slice(0, 7).split('-').map(Number)
  const [fa, fm] = fim.slice(0, 7).split('-').map(Number)
  const out = []
  while (a < fa || (a === fa && m <= fm)) {
    out.push(`${a}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) { m = 1; a += 1 }
  }
  return out
}

// Vencimento: dia configurado no mês (competência + offset); dia > fim do mês => último dia.
export function vencimentoApresentadora(mes, dia = VENCIMENTO_DIA_PADRAO, offset = VENCIMENTO_OFFSET_PADRAO) {
  let [a, m] = mes.split('-').map(Number)
  m += Number(offset)
  while (m > 12) { m -= 12; a += 1 }
  const ym = `${a}-${String(m).padStart(2, '0')}`
  const d = Math.min(Number(dia), Number(ultimoDiaDoMes(ym).slice(8, 10)))
  return `${ym}-${String(d).padStart(2, '0')}`
}

export async function buscarConfigVencimento(db, tenantId) {
  const r = await db.query(
    `SELECT apresentadoras_vencimento_dia AS dia, apresentadoras_vencimento_mes_offset AS mes_offset
       FROM tenants WHERE id = $1::uuid`, [tenantId])
  const row = r.rows[0]
  return {
    dia: Number(row?.dia ?? VENCIMENTO_DIA_PADRAO),
    mes_offset: Number(row?.mes_offset ?? VENCIMENTO_OFFSET_PADRAO),
  }
}

function hojeSaoPaulo() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
}

const dinheiro = (v) => Number(v ?? 0)

export async function listarPagamentosApresentadoras(db, { tenantId, inicio, fim, hoje }) {
  hoje = hoje ?? hojeSaoPaulo()
  const config = await buscarConfigVencimento(db, tenantId)
  const meses = mesesDoPeriodo(inicio, fim)
  const pagos = await db.query(`
    SELECT apresentadora_id, competencia::text AS competencia, valor_pago, data_pagamento::text AS data_pagamento, observacao
      FROM apresentadora_pagamentos
     WHERE tenant_id = $1::uuid AND competencia >= $2::date AND competencia <= $3::date`,
  [tenantId, `${meses[0]}-01`, `${meses[meses.length - 1]}-01`])
  const pagoPor = new Map(pagos.rows.map((p) => [`${p.apresentadora_id}|${p.competencia.slice(0, 7)}`, p]))

  const itens = []
  for (const mes of meses) {
    const fechamento = await buscarFechamentoApresentadoras(db, { tenantId, mes })
    const vistos = new Set()
    const vencimento = vencimentoApresentadora(mes, config.dia, config.mes_offset)
    const montar = (apresentadoraId, nome, total, detalhe) => {
      const pg = pagoPor.get(`${apresentadoraId}|${mes}`)
      const item = {
        id: `apresentadora:${apresentadoraId}:${mes}`,
        natureza: 'custo',
        origem: 'apresentadora',
        apresentadora_id: apresentadoraId,
        descricao: `Pagamento ${nome} - ${mes.slice(5)}/${mes.slice(0, 4)}`,
        competencia: `${mes}-01`,
        data_vencimento: vencimento,
        valor_previsto: total,
        valor_pago: pg ? dinheiro(pg.valor_pago) : 0,
        data_pagamento: pg?.data_pagamento ?? null,
        observacao: pg?.observacao ?? null,
        ...detalhe,
      }
      item.status = statusLancamento(item, hoje)
      itens.push(item)
    }
    for (const ap of fechamento.apresentadoras) {
      vistos.add(ap.apresentadora_id)
      if (ap.total <= 0 && !pagoPor.has(`${ap.apresentadora_id}|${mes}`)) continue
      montar(ap.apresentadora_id, ap.nome, ap.total, { fixo: ap.fixo, comissao: ap.comissao, adicionais: ap.adicionais })
    }
    // Pagamento registrado para apresentadora que saiu do fechamento (inativada/arquivada).
    for (const [chave, pg] of pagoPor) {
      const [apId, m] = chave.split('|')
      if (m !== mes || vistos.has(apId)) continue
      const n = await db.query('SELECT nome FROM apresentadoras WHERE id = $1::uuid AND tenant_id = $2::uuid', [apId, tenantId])
      montar(apId, n.rows[0]?.nome ?? 'Apresentadora', 0, { fixo: 0, comissao: 0, adicionais: 0 })
    }
  }
  return itens.sort((a, b) => a.competencia.localeCompare(b.competencia) || a.descricao.localeCompare(b.descricao, 'pt-BR'))
}

// Baixa: default = total do fechamento. Retorna null se a apresentadora não existe no tenant.
export async function registrarPagamentoApresentadora(db, { tenantId, apresentadoraId, mes, valorPago, dataPagamento, observacao, userId }) {
  const ap = await db.query('SELECT id FROM apresentadoras WHERE id = $1::uuid AND tenant_id = $2::uuid', [apresentadoraId, tenantId])
  if (!ap.rows[0]) return null
  let valor = valorPago
  if (valor == null) {
    const f = await buscarFechamentoApresentadoras(db, { tenantId, mes, apresentadoraId })
    valor = f.apresentadoras[0]?.total ?? 0
  } else {
    const cents = dinheiroEmCentavos(valor)
    if (cents == null) throw new TypeError('valor_pago inválido')
    valor = cents / 100
  }
  const r = await db.query(`
    INSERT INTO apresentadora_pagamentos (tenant_id, apresentadora_id, competencia, valor_pago, data_pagamento, observacao, criado_por)
    VALUES ($1::uuid, $2::uuid, $3::date, $4::numeric, COALESCE($5::date, (now() AT TIME ZONE 'America/Sao_Paulo')::date), $6, $7::uuid)
    ON CONFLICT (tenant_id, apresentadora_id, competencia)
    DO UPDATE SET valor_pago = EXCLUDED.valor_pago, data_pagamento = EXCLUDED.data_pagamento,
                  observacao = EXCLUDED.observacao, atualizado_em = now()
    RETURNING apresentadora_id, competencia::text AS competencia, valor_pago, data_pagamento::text AS data_pagamento, observacao`,
  [tenantId, apresentadoraId, `${mes}-01`, valor, dataPagamento ?? null, observacao ?? null, userId ?? null])
  return r.rows[0]
}

export async function desfazerPagamentoApresentadora(db, { tenantId, apresentadoraId, mes }) {
  const r = await db.query(
    `DELETE FROM apresentadora_pagamentos WHERE tenant_id = $1::uuid AND apresentadora_id = $2::uuid AND competencia = $3::date RETURNING id`,
    [tenantId, apresentadoraId, `${mes}-01`])
  return r.rowCount > 0
}
