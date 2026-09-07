import { presenterFixedAtSql } from '../config/presenter_defaults.js'
import { prorateFatorSql } from '../lib/financeiro-remuneracao.js'

export const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/
export const DATA_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

export function competenciaDoMes(mes) {
  return `${mes}-01`
}

export function ultimoDiaDoMes(mes) {
  const [ano, numeroMes] = mes.split('-').map(Number)
  return new Date(Date.UTC(ano, numeroMes, 0)).toISOString().slice(0, 10)
}

export function dataEhFimDeSemana(data) {
  if (!DATA_RE.test(String(data))) return false
  const date = new Date(`${data}T12:00:00Z`)
  // Datas como 2026-02-31 são normalizadas pelo Date: rejeite-as antes de olhar o dia.
  if (date.toISOString().slice(0, 10) !== data) return false
  const dia = date.getUTCDay()
  return dia === 0 || dia === 6
}

export function dataEhValida(data) {
  if (!DATA_RE.test(String(data))) return false
  return new Date(`${data}T12:00:00Z`).toISOString().slice(0, 10) === data
}

export function dinheiroEmCentavos(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    const cents = Math.round(value * 100)
    return Math.abs(value * 100 - cents) < 1e-7 && Number.isSafeInteger(cents) && cents <= 999999999999999 ? cents : null
  }
  if (typeof value !== 'string') return null
  const normalizado = value.trim().replace(',', '.')
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalizado)) return null
  const [inteiro, decimal = ''] = normalizado.split('.')
  // NUMERIC(15,2): no máximo 13 algarismos inteiros. Também protege o cast JS.
  if (inteiro.length > 13) return null
  const cents = Number(inteiro) * 100 + Number(decimal.padEnd(2, '0'))
  return Number.isSafeInteger(cents) ? cents : null
}

function centavosDoBanco(valor) {
  const cents = dinheiroEmCentavos(typeof valor === 'string' ? valor : Number(valor ?? 0))
  if (cents == null) throw new Error('Valor monetário inválido retornado pelo banco')
  return cents
}

const valorResposta = (centavos) => centavos / 100

// Fonte privada do fechamento. Mantém exatamente o fixo histórico do DRE, mas não
// reutiliza rankings públicos (eles excluem vendas de GMV zero via HAVING).
export async function buscarFechamentoApresentadoras(db, { tenantId, mes }) {
  const competencia = competenciaDoMes(mes)
  const fim = ultimoDiaDoMes(mes)
  const [fixos, comissoes, adicionais] = await Promise.all([
    db.query(`
      SELECT a.id AS apresentadora_id, a.nome,
             ROUND(COALESCE(${presenterFixedAtSql('a', '$2::date')}
               * ${prorateFatorSql("date_trunc('month', $2::date)", 'a.data_inicio', 'a.data_fim')}, 0), 2) AS valor
      FROM apresentadoras a
      WHERE a.tenant_id = $1::uuid
        AND a.ativo IS TRUE
        AND COALESCE(a.arquivada, false) = false
      ORDER BY a.nome ASC
    `, [tenantId, fim]),
    db.query(`
      SELECT va.apresentadora_id, a.nome,
             COALESCE(SUM(va.comissao_apresentadora), 0) AS valor
      FROM vendas_atribuidas va
      JOIN apresentadoras a ON a.id = va.apresentadora_id AND a.tenant_id = va.tenant_id
      WHERE va.tenant_id = $1::uuid
        AND va.data >= $2::date AND va.data <= $3::date
        AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
        AND va.apresentadora_id IS NOT NULL
      GROUP BY va.apresentadora_id, a.nome
      ORDER BY a.nome ASC
    `, [tenantId, competencia, fim]),
    db.query(`
      SELECT ara.id, ara.apresentadora_id, a.nome, ara.tipo, ara.descricao,
             ara.data_referencia::text AS data_referencia, ara.valor
      FROM apresentadora_remuneracao_adicionais ara
      JOIN apresentadoras a ON a.id = ara.apresentadora_id AND a.tenant_id = ara.tenant_id
      WHERE ara.tenant_id = $1::uuid AND ara.competencia = $2::date
        AND ara.cancelado_em IS NULL
      ORDER BY a.nome ASC, ara.data_referencia ASC NULLS LAST, ara.criado_em ASC
    `, [tenantId, competencia]),
  ])

  const porId = new Map()
  const incluir = (id, nome) => {
    if (!porId.has(id)) porId.set(id, { apresentadora_id: id, nome, fixo_centavos: 0, comissao_centavos: 0, adicionais_centavos: 0, extras: [] })
    return porId.get(id)
  }
  for (const row of fixos.rows) incluir(row.apresentadora_id, row.nome).fixo_centavos = centavosDoBanco(row.valor)
  for (const row of comissoes.rows) incluir(row.apresentadora_id, row.nome).comissao_centavos = centavosDoBanco(row.valor)
  for (const row of adicionais.rows) {
    const item = incluir(row.apresentadora_id, row.nome)
    const cents = centavosDoBanco(row.valor)
    item.adicionais_centavos += cents
    item.extras.push({ id: row.id, tipo: row.tipo, data_referencia: row.data_referencia, descricao: row.descricao, valor: valorResposta(cents) })
  }
  const apresentadoras = [...porId.values()].map((item) => {
    const totalCentavos = item.fixo_centavos + item.comissao_centavos + item.adicionais_centavos
    return {
      apresentadora_id: item.apresentadora_id,
      nome: item.nome,
      fixo: valorResposta(item.fixo_centavos),
      comissao: valorResposta(item.comissao_centavos),
      adicionais: valorResposta(item.adicionais_centavos),
      total: valorResposta(totalCentavos),
      extras: item.extras,
    }
  })
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
  const totaisCentavos = apresentadoras.reduce((acc, item) => ({
    fixo: acc.fixo + centavosDoBanco(item.fixo),
    comissao: acc.comissao + centavosDoBanco(item.comissao),
    adicionais: acc.adicionais + centavosDoBanco(item.adicionais),
    total: acc.total + centavosDoBanco(item.total),
  }), { fixo: 0, comissao: 0, adicionais: 0, total: 0 })
  const totais = Object.fromEntries(Object.entries(totaisCentavos).map(([key, cents]) => [key, valorResposta(cents)]))
  return { mes, apresentadoras, totais }
}
