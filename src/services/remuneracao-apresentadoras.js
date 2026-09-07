import { presenterFixedAtSql } from '../config/presenter_defaults.js'
import { prorateFatorSql } from '../lib/financeiro-remuneracao.js'
import { apresentadoraHorasSql, liveGmvSql, liveHoursSql, liveOrdersSql } from '../lib/metric-sql.js'

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

// Histórico que acompanha o pagamento mensal. Não alimenta o fechamento: a
// comissão acima continua sendo a fonte única dos totais. Aqui só explicamos
// quais lives encerradas foram atendidas pela apresentadora, inclusive as que
// tiveram GMV/comissão zero.
export async function buscarHistoricoLivesApresentadora(db, { tenantId, apresentadoraId, mes }) {
  const inicio = competenciaDoMes(mes)
  const fim = ultimoDiaDoMes(mes)
  // A tabela/PDF não pode misturar memória de comissão atualizada no meio do
  // request com lives lidas antes dela. withTenant não abre transação, então o
  // snapshot explícito preserva a reconciliação com o fechamento exibido.
  await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    const [result, memoriaQ] = await Promise.all([
      db.query(`
    WITH lives_atendidas AS (
      -- Principal legado: lives.apresentador_id aponta para users.id, enquanto
      -- o Financeiro usa apresentadoras.id.
      SELECT l.id AS live_id
      FROM lives l
      JOIN apresentadoras a
        ON a.user_id = l.apresentador_id AND a.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1::uuid AND a.id = $2::uuid

      UNION

      -- Secundária legada: vínculo mantém users.id.
      SELECT l.id AS live_id
      FROM lives l
      JOIN live_apresentadores la
        ON la.live_id = l.id AND la.tenant_id = l.tenant_id
      JOIN apresentadoras a
        ON a.user_id = la.apresentador_id AND a.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1::uuid AND a.id = $2::uuid

      UNION

      -- Split atual: vínculo já guarda apresentadoras.id.
      SELECT l.id AS live_id
      FROM lives l
      JOIN live_apresentadoras_v2 lav
        ON lav.live_id = l.id AND lav.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1::uuid AND lav.apresentadora_id = $2::uuid
    )
    SELECT
      l.id AS live_id,
      (l.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date::text AS data,
      COALESCE(marca_live.nome, marca_venda.nome) AS marca_nome,
      cabine.nome AS cabine_nome,
      ${liveHoursSql('l')} AS duracao_horas,
      ${liveGmvSql('l')} AS gmv,
      CASE
        WHEN split_atual.apresentadora_id IS NOT NULL THEN COALESCE(
          split_atual.gmv_rateado,
          ${liveGmvSql('l')} * split_atual.percentual_rateio / 100.0,
          CASE WHEN split_atual.papel = 'principal' THEN ${liveGmvSql('l')} ELSE 0 END
        )
        ELSE ${liveGmvSql('l')}
      END AS gmv_atribuido,
      ${apresentadoraHorasSql({ live: 'l', rateio: 'split_atual' })} AS horas_atribuidas,
      ${liveOrdersSql('l')} AS pedidos,
      COALESCE(comissao.valor, 0) AS comissao
    FROM lives_atendidas atendida
    JOIN lives l ON l.id = atendida.live_id AND l.tenant_id = $1::uuid
    LEFT JOIN cabines cabine ON cabine.id = l.cabine_id AND cabine.tenant_id = l.tenant_id
    LEFT JOIN marcas marca_live ON marca_live.id = l.marca_id AND marca_live.tenant_id = l.tenant_id
    -- Quando existe split v2, a performance individual usa a mesma atribuição
    -- de GMV/horas do ranking de apresentadoras; gmv/duração continuam sendo
    -- os valores integrais da live para a tabela histórica.
    LEFT JOIN LATERAL (
      SELECT lav.apresentadora_id, lav.gmv_rateado, lav.segundos_rateio,
             lav.percentual_rateio, lav.papel
      FROM live_apresentadoras_v2 lav
      WHERE lav.live_id = l.id
        AND lav.tenant_id = l.tenant_id
        AND lav.apresentadora_id = $2::uuid
      LIMIT 1
    ) split_atual ON true
    -- Uma live legada pode não ter marca em lives; a marca da venda só é fallback
    -- para o rótulo. LATERAL garante no máximo uma linha de resultado.
    LEFT JOIN LATERAL (
      SELECT m.nome
      FROM vendas_atribuidas va
      JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
      WHERE va.tenant_id = l.tenant_id
        AND va.origem = 'live' AND va.origem_id = l.id
      ORDER BY va.criado_em DESC NULLS LAST, va.id DESC
      LIMIT 1
    ) marca_venda ON true
    -- A comissão é individual e pertence à competência selecionada. O LATERAL
    -- agregado impede que várias vendas multipliquem a linha da live.
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(va.comissao_apresentadora), 0) AS valor
      FROM vendas_atribuidas va
      WHERE va.tenant_id = l.tenant_id
        AND va.origem = 'live' AND va.origem_id = l.id
        AND va.apresentadora_id = $2::uuid
        AND va.data >= $3::date AND va.data <= $4::date
        AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
    ) comissao ON true
    WHERE l.status = 'encerrada'
      AND l.iniciado_em >= ($3::date::timestamp) AT TIME ZONE 'America/Sao_Paulo'
      AND l.iniciado_em < (($4::date::timestamp + INTERVAL '1 day') AT TIME ZONE 'America/Sao_Paulo')
    ORDER BY l.iniciado_em ASC, l.id ASC
      `, [tenantId, apresentadoraId, inicio, fim]),
      // Cópia completa da memória de comissão para o PDF mensal. Ao contrário
      // de /v1/comissoes/memoria, esta consulta não tem LIMIT: truncar uma
      // competência mudaria o total mostrado no documento de pagamento.
      db.query(`
        SELECT
          va.id, va.data::text AS data, va.origem, va.gmv, va.comissao_apresentadora,
          CASE WHEN va.gmv > 0
            THEN ROUND((va.comissao_apresentadora / va.gmv * 100)::numeric, 2)
            ELSE 0 END AS pct_aplicado,
          m.nome AS marca_nome,
          month_gmv.gmv_mes AS base_gmv_mes,
          faixa.gmv_inicio AS faixa_gmv_inicio,
          faixa.gmv_fim AS faixa_gmv_fim,
          faixa.comissao_pct AS faixa_pct,
          (va.origem = 'live' AND EXTRACT(DOW FROM va.data) IN (0, 6)) AS fim_de_semana
        FROM vendas_atribuidas va
        LEFT JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(va_mes.gmv), 0) + COALESCE(va.gmv, 0) AS gmv_mes
          FROM vendas_atribuidas va_mes
          WHERE va_mes.tenant_id = va.tenant_id
            AND va_mes.apresentadora_id = va.apresentadora_id
            AND date_trunc('month', va_mes.data::timestamp) = date_trunc('month', va.data::timestamp)
            AND va_mes.id <> va.id
            AND COALESCE(va_mes.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
        ) month_gmv ON true
        LEFT JOIN LATERAL (
          SELECT f.gmv_inicio, f.gmv_fim, f.comissao_pct
          FROM apresentadora_comissao_faixas f
          WHERE f.tenant_id = va.tenant_id
            AND f.apresentadora_id = va.apresentadora_id
            AND f.ativo = true
            AND f.gmv_inicio <= COALESCE(month_gmv.gmv_mes, va.gmv, 0)
            AND (f.gmv_fim IS NULL OR f.gmv_fim >= COALESCE(month_gmv.gmv_mes, va.gmv, 0))
          ORDER BY f.gmv_inicio DESC
          LIMIT 1
        ) faixa ON true
        WHERE va.tenant_id = $1::uuid
          AND va.apresentadora_id = $2::uuid
          AND va.data >= $3::date AND va.data <= $4::date
          AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
        ORDER BY va.data ASC, va.criado_em ASC, va.id ASC
      `, [tenantId, apresentadoraId, inicio, fim]),
    ])
    await db.query('COMMIT')

    const lives = result.rows.map((row) => ({
      live_id: row.live_id,
      data: row.data,
      marca_nome: row.marca_nome ?? null,
      cabine_nome: row.cabine_nome ?? null,
      duracao_horas: Number(row.duracao_horas ?? 0),
      gmv: Number(row.gmv ?? 0),
      gmv_atribuido: Number(row.gmv_atribuido ?? 0),
      horas_atribuidas: Number(row.horas_atribuidas ?? 0),
      pedidos: Number(row.pedidos ?? 0),
      comissao: Number(row.comissao ?? 0),
    }))
    const memoria = memoriaQ.rows.map((row) => ({
      id: row.id,
      data: row.data,
      origem: row.origem,
      marca_nome: row.marca_nome ?? null,
      gmv: Number(row.gmv ?? 0),
      comissao_apresentadora: Number(row.comissao_apresentadora ?? 0),
      pct_aplicado: Number(row.pct_aplicado ?? 0),
      base_gmv_mes: Number(row.base_gmv_mes ?? 0),
      faixa: row.faixa_pct == null ? null : {
        gmv_inicio: Number(row.faixa_gmv_inicio ?? 0),
        gmv_fim: row.faixa_gmv_fim == null ? null : Number(row.faixa_gmv_fim),
        comissao_pct: Number(row.faixa_pct ?? 0),
      },
      fim_de_semana: Boolean(row.fim_de_semana),
    }))
    const totalVariavelCentavos = memoria.reduce((total, row) => total + centavosDoBanco(row.comissao_apresentadora), 0)
    const horasLive = lives.reduce((total, live) => total + live.horas_atribuidas, 0)
    const gmvLives = lives.reduce((total, live) => total + live.gmv_atribuido, 0)
    return {
      mes,
      apresentadora_id: apresentadoraId,
      performance: {
        total_lives: lives.length,
        horas_live: horasLive,
        gmv_lives: gmvLives,
        gmv_por_hora: horasLive > 0 ? gmvLives / horasLive : null,
      },
      total_variavel: valorResposta(totalVariavelCentavos),
      memoria_completa: true,
      lives,
      memoria,
    }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {})
    throw error
  }
}
