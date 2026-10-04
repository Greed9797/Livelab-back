// Receita por marca (fixo + comissão de franquia) — SQL COMPARTILHADO entre o
// financeiro (/resumo, /operacional) e as receitas/títulos (receitas-comercial.js).
// Fonte única: condições comerciais versionadas (marca_condicoes_comerciais) +
// datas de contrato da marca (migration 133) + GMV de lives/vídeos.
//
// Todos os fragmentos usam os MESMOS params posicionais do financeiro.js:
//   $1 = data inicial (YYYY-MM-DD), $2 = data final inclusiva, $3 = tenant_id.
//
// Modalidades comerciais preservadas:
//   - "GMV + %"  → fixo > 0 e pct > 0 (tipo_cobranca decide soma ou maior)
//   - "só fixo"  → pct = 0 (comissão zero)
//   - "só %"     → fixo = 0 (sem linha de fixo)

import { liveGmvSql, liveOrdersSql } from './metric-sql.js'
import { marcaResolveLateralSql } from './marca-sql.js'
import { prorateFatorSql } from './financeiro-remuneracao.js'
import { activeLiveSql } from './live-merge-sql.js'
import { notArchivedSql, saoPauloInclusiveRangeSql } from './live-count-sql.js'

/** Condição comercial vigente no mês `mesExpr` (1º dia) para a marca `marcaExpr`. */
export function condicaoVigenteLateralSql({ alias = 'mc', marcaExpr = 'm.id', mesExpr, tenantParam = '$3' }) {
  return `LEFT JOIN LATERAL (
        SELECT c.id, c.fixo_mensal, c.tipo_cobranca, c.comissao_franquia_pct,
               c.fixo_vencimento_dia, c.fixo_vencimento_mes_offset,
               c.comissao_vencimento_dia, c.comissao_vencimento_mes_offset,
               c.comissao_janela_inicio_dia
          FROM marca_condicoes_comerciais c
         WHERE c.tenant_id = ${tenantParam}::uuid
           AND c.marca_id = ${marcaExpr}
           AND c.inicio_vigencia <= (${mesExpr})::date
           AND c.cancelled_at IS NULL
         ORDER BY c.inicio_vigencia DESC
         LIMIT 1
      ) ${alias} ON true`
}

/**
 * Marca que gera receita comercial (título a receber): só marca de CLIENTE e nunca a
 * marca-sistema do tenant. Afiliada / própria / parceira e "Livelab Sistema" têm GMV
 * operacional, mas não têm cliente a cobrar — o GMV delas (× %) não é receita da casa.
 * Mesmo filtro do fixo por vigência e da visão "em apuração".
 */
export function marcaGeraReceitaSql(marca = 'm') {
  return `${marca}.tipo = 'cliente' AND COALESCE(${marca}.sistema, false) = false`
}

/**
 * Data de vencimento em SQL: dia `diaExpr` do mês (competência + offset);
 * dia maior que o último dia do mês vira o último dia. Mesmo cálculo de
 * `calcularVencimento` (receitas-comercial.js).
 */
export function vencimentoSql(competenciaExpr, diaExpr, offsetExpr) {
  const mesVenc = `date_trunc('month', (${competenciaExpr})::date::timestamp + make_interval(months => (${offsetExpr})::int))`
  return `((${mesVenc})::date + (LEAST((${diaExpr})::int,
            EXTRACT(DAY FROM (${mesVenc} + interval '1 month' - interval '1 day'))::int) - 1))`
}

/**
 * Fixo mensal LEGADO (semântica migration 116): 1× por marca tipo='cliente' por mês
 * COM atividade (GMV/pedidos > 0 em lives ou vídeos), rateado por data_inicio/data_fim.
 * Cópia fiel de `marcaFixoMensalSql()` de src/routes/financeiro.js — o financeiro
 * pode importar daqui sem mudar comportamento.
 */
export function marcaFixoMensalAtividadeSql() {
  return `
    SELECT m.id AS marca_id, m.nome AS marca_nome,
           COALESCE(mc.fixo_mensal, m.valor_fixo_minimo) AS valor_fixo_minimo,
           COALESCE(mc.tipo_cobranca, m.tipo_cobranca, 'fixo_mais_comissao') AS tipo_cobranca,
           am2.mes::date AS mes,
           1::int AS meses_ativos,
           ${prorateFatorSql('am2.mes', 'm.data_inicio', 'm.data_fim')} AS fator_meses
      FROM (
        SELECT DISTINCT marca_id, mes FROM (
          SELECT l.marca_id, date_trunc('month', l.iniciado_em AT TIME ZONE 'America/Sao_Paulo') AS mes
          FROM lives l
          WHERE l.tenant_id = $3::uuid AND l.status = 'encerrada' AND l.marca_id IS NOT NULL
            AND ${activeLiveSql('l')}
            AND ${notArchivedSql('l')}
            AND ${saoPauloInclusiveRangeSql('l.iniciado_em', '$1', '$2')}
            AND (${liveGmvSql('l')} > 0 OR ${liveOrdersSql('l')} > 0)
          UNION
          SELECT vr.marca_id, date_trunc('month', vr.data::timestamp) AS mes
          FROM video_registros vr
          WHERE vr.tenant_id = $3::uuid
            AND vr.data >= $1::date AND vr.data <= $2::date
            AND (vr.gmv_atribuido > 0 OR vr.pedidos_atribuidos > 0)
        ) u
      ) am2
      JOIN marcas m ON m.id = am2.marca_id AND m.tenant_id = $3::uuid
      LEFT JOIN LATERAL (
        SELECT c.fixo_mensal, c.tipo_cobranca
          FROM marca_condicoes_comerciais c
         WHERE c.tenant_id = $3::uuid
           AND c.marca_id = m.id
           AND c.inicio_vigencia <= am2.mes::date
           AND c.cancelled_at IS NULL
         ORDER BY c.inicio_vigencia DESC
         LIMIT 1
      ) mc ON true
     WHERE m.tenant_id = $3::uuid AND m.tipo = 'cliente'`
}

/**
 * Início efetivo do contrato para cobrança por vigência:
 *   data_inicio da marca → 1ª condição comercial real (não o baseline técnico
 *   1900-01-01 da migration 151) → mês de cadastro da marca.
 */
export function inicioContratoSql(marca = 'm') {
  return `COALESCE(
      ${marca}.data_inicio,
      (SELECT MIN(c0.inicio_vigencia) FROM marca_condicoes_comerciais c0
        WHERE c0.tenant_id = ${marca}.tenant_id AND c0.marca_id = ${marca}.id
          AND c0.cancelled_at IS NULL AND c0.inicio_vigencia > DATE '1900-01-01'),
      date_trunc('month', ${marca}.criado_em AT TIME ZONE 'America/Sao_Paulo')::date
    )`
}

/**
 * Fixo mensal POR VIGÊNCIA (decisão do dono): cobrado em TODO mês entre o início e
 * data_fim do contrato — com ou sem atividade —, rateado por dias no mês de entrada
 * e de saída. Valor e tipo_cobranca vêm da condição vigente em cada mês.
 * Mesmo shape de `marcaFixoMensalAtividadeSql()` (drop-in).
 */
export function marcaFixoVigenciaSql() {
  return `
    SELECT m.id AS marca_id, m.nome AS marca_nome,
           COALESCE(mc.fixo_mensal, m.valor_fixo_minimo) AS valor_fixo_minimo,
           COALESCE(mc.tipo_cobranca, m.tipo_cobranca, 'fixo_mais_comissao') AS tipo_cobranca,
           gs.mes::date AS mes,
           1::int AS meses_ativos,
           ${prorateFatorSql('gs.mes', 'vig.inicio', 'm.data_fim')} AS fator_meses
      FROM marcas m
      CROSS JOIN LATERAL (SELECT ${inicioContratoSql('m')} AS inicio) vig
      CROSS JOIN LATERAL generate_series(
        GREATEST(date_trunc('month', $1::date::timestamp), date_trunc('month', vig.inicio::timestamp)),
        LEAST(date_trunc('month', $2::date::timestamp), date_trunc('month', COALESCE(m.data_fim, $2::date)::timestamp)),
        interval '1 month'
      ) gs(mes)
      ${condicaoVigenteLateralSql({ alias: 'mc', marcaExpr: 'm.id', mesExpr: 'gs.mes' })}
     WHERE m.tenant_id = $3::uuid AND ${marcaGeraReceitaSql('m')}
       AND (m.status NOT IN ('inativa','arquivada') OR m.data_fim IS NOT NULL)`
}

/**
 * Comissão de franquia VARIÁVEL por marca e mês (gmv × pct da condição vigente na
 * data do fato). Mesma regra do CTE comissao_marca_raw/comissao_marca do /resumo:
 * lives encerradas (GMV inline) + vídeos (vendas_atribuidas não reprovadas).
 * Só marcas que geram receita (`marcaGeraReceitaSql`): sem o filtro, GMV de marca
 * afiliada/própria/parceira/sistema com % > 0 virava título de comissão.
 * Saída: marca_id, mes (date), comissao, gmv.
 */
export function comissaoMarcaMensalSql() {
  // Competência = mês em que a janela de apuração começa (j=1 → mês civil).
  const compLive = `date_trunc('month', (l.iniciado_em AT TIME ZONE 'America/Sao_Paulo') - make_interval(days => mc.comissao_janela_inicio_dia - 1))`
  const compVideo = `date_trunc('month', va.data::timestamp - make_interval(days => COALESCE(vc.comissao_janela_inicio_dia, 1) - 1))`
  // Fatos até $2 + 27 dias podem cair na competência de $2; o filtro final recorta por competência.
  return `
    SELECT raw.marca_id, raw.mes::date AS mes, SUM(raw.comissao) AS comissao, SUM(raw.gmv) AS gmv
      FROM (
        SELECT mc.marca_id,
               ${compLive} AS mes,
               COALESCE(SUM(${liveGmvSql('l')} * COALESCE(mc.comissao_franquia_pct, 0) / 100.0), 0) AS comissao,
               COALESCE(SUM(${liveGmvSql('l')}), 0) AS gmv
        FROM lives l
        ${marcaResolveLateralSql('$3')}
        WHERE l.tenant_id = $3::uuid
          AND l.status = 'encerrada'
          AND ${activeLiveSql('l')}
          AND ${notArchivedSql('l')}
          AND ${saoPauloInclusiveRangeSql('l.iniciado_em', '$1', '($2::date + 27)')}
          AND mc.id IS NOT NULL
        GROUP BY mc.marca_id, ${compLive}
        UNION ALL
        SELECT va.marca_id,
               ${compVideo} AS mes,
               COALESCE(SUM(CASE WHEN vc.id IS NOT NULL
                                 THEN va.gmv * COALESCE(vc.comissao_franquia_pct, 0) / 100.0
                                 ELSE va.comissao_franquia END), 0) AS comissao,
               COALESCE(SUM(va.gmv), 0) AS gmv
          FROM vendas_atribuidas va
          LEFT JOIN LATERAL (
            SELECT c.id, c.comissao_franquia_pct, c.comissao_janela_inicio_dia
              FROM marca_condicoes_comerciais c
             WHERE c.tenant_id = va.tenant_id AND c.marca_id = va.marca_id
               AND c.inicio_vigencia <= va.data AND c.cancelled_at IS NULL
             ORDER BY c.inicio_vigencia DESC LIMIT 1
          ) vc ON true
         WHERE va.tenant_id = $3::uuid AND va.origem = 'video'
           AND COALESCE(va.status_aprovacao, 'pendente_aprovacao') <> 'reprovada'
           AND va.data >= $1::date AND va.data <= ($2::date + 27)
         GROUP BY va.marca_id, ${compVideo}
      ) raw
      JOIN marcas mr ON mr.id = raw.marca_id AND mr.tenant_id = $3::uuid
     WHERE ${marcaGeraReceitaSql('mr')}
       AND raw.mes::date BETWEEN date_trunc('month', $1::date)::date AND date_trunc('month', $2::date)::date
     GROUP BY raw.marca_id, raw.mes`
}

/**
 * Receita por marca × competência: comissão + fixo (vigência ou atividade) e a
 * condição vigente no mês (tipo_cobranca + vencimentos). Uma linha por marca/mês.
 * `fixo`: 'vigencia' (padrão, decisão do dono) | 'atividade' (legado migration 116).
 */
export function receitaMarcaMensalSql({ fixo = 'vigencia' } = {}) {
  const fixoSql = fixo === 'atividade' ? marcaFixoMensalAtividadeSql() : marcaFixoVigenciaSql()
  return `
    WITH comissao_marca AS (${comissaoMarcaMensalSql()}),
    fixo_marca AS (
      SELECT f.marca_id, f.mes::date AS mes,
             f.valor_fixo_minimo AS fixo_cheio, f.fator_meses,
             (f.valor_fixo_minimo * f.fator_meses) AS fixo
        FROM (${fixoSql}) f
       WHERE f.valor_fixo_minimo > 0 AND f.fator_meses > 0
    ),
    base AS (
      SELECT COALESCE(cm.marca_id, fm.marca_id) AS marca_id,
             COALESCE(cm.mes, fm.mes) AS mes,
             COALESCE(cm.comissao, 0) AS comissao,
             COALESCE(cm.gmv, 0) AS gmv,
             COALESCE(fm.fixo, 0) AS fixo,
             COALESCE(fm.fixo_cheio, 0) AS fixo_cheio,
             COALESCE(fm.fator_meses, 0) AS fator_meses
        FROM comissao_marca cm
        FULL OUTER JOIN fixo_marca fm ON fm.marca_id = cm.marca_id AND fm.mes = cm.mes
    )
    SELECT b.marca_id, b.mes::date AS competencia, b.comissao, b.gmv, b.fixo, b.fixo_cheio, b.fator_meses,
           m.nome AS marca_nome, m.tipo AS marca_tipo, m.cliente_id, cl.nome AS cliente_nome,
           mc.id AS condicao_id,
           COALESCE(mc.tipo_cobranca, m.tipo_cobranca, 'fixo_mais_comissao') AS tipo_cobranca,
           COALESCE(mc.comissao_franquia_pct, 0) AS comissao_franquia_pct,
           COALESCE(mc.fixo_vencimento_dia, 5) AS fixo_vencimento_dia,
           COALESCE(mc.fixo_vencimento_mes_offset, 1) AS fixo_vencimento_mes_offset,
           COALESCE(mc.comissao_vencimento_dia, 5) AS comissao_vencimento_dia,
           COALESCE(mc.comissao_vencimento_mes_offset, 1) AS comissao_vencimento_mes_offset,
           COALESCE(mc.comissao_janela_inicio_dia, 1) AS comissao_janela_inicio_dia
      FROM base b
      JOIN marcas m ON m.id = b.marca_id AND m.tenant_id = $3::uuid
      LEFT JOIN clientes cl ON cl.id = m.cliente_id AND cl.tenant_id = m.tenant_id
      ${condicaoVigenteLateralSql({ alias: 'mc', marcaExpr: 'b.marca_id', mesExpr: 'b.mes' })}
     WHERE b.marca_id IS NOT NULL
     ORDER BY b.mes, m.nome`
}

/**
 * Marcas tipo='cliente' (não sistema) com condição comercial vigente no mês $1
 * (1º dia) e contrato ativo no mês (início efetivo <= $2 e data_fim >= $1).
 * Usado pela visão de Receita para mostrar marcas cuja comissão ainda não gerou
 * título ("em apuração"). Params: $1 = 1º dia do mês, $2 = último dia, $3 = tenant_id.
 */
export function marcasCondicaoVigenteMesSql() {
  return `
    SELECT m.id AS marca_id, m.nome AS marca_nome, m.cliente_id, cl.nome AS cliente_nome,
           mc.id AS condicao_id,
           COALESCE(mc.tipo_cobranca, m.tipo_cobranca, 'fixo_mais_comissao') AS tipo_cobranca,
           COALESCE(mc.comissao_franquia_pct, 0) AS comissao_franquia_pct,
           COALESCE(mc.fixo_mensal, 0) AS fixo_mensal,
           COALESCE(mc.comissao_vencimento_dia, 5) AS comissao_vencimento_dia,
           COALESCE(mc.comissao_vencimento_mes_offset, 1) AS comissao_vencimento_mes_offset,
           COALESCE(mc.comissao_janela_inicio_dia, 1) AS comissao_janela_inicio_dia
      FROM marcas m
      LEFT JOIN clientes cl ON cl.id = m.cliente_id AND cl.tenant_id = m.tenant_id
      ${condicaoVigenteLateralSql({ alias: 'mc', marcaExpr: 'm.id', mesExpr: '$1::date' })}
     WHERE m.tenant_id = $3::uuid AND ${marcaGeraReceitaSql('m')}
       AND mc.id IS NOT NULL
       AND m.status = 'ativa'
       AND ${inicioContratoSql('m')} <= $2::date
       AND (m.data_fim IS NULL OR m.data_fim >= $1::date)
     ORDER BY m.nome`
}
