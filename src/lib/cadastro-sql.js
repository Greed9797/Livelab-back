// Cadastro unificado: a MARCA é a entidade (id público = marca_id); a ficha em
// `clientes` é o complemento comercial/faturamento 1:1 opcional da marca
// tipo='cliente'. Ver migration 174 e docs/financeiro.md §1.
//
// SQL compartilhado por src/services/cadastros.js (GET /v1/cadastros e /:id).
// Só leitura. tenant_id sempre explícito (o papel do Supabase tem bypass de RLS).
import { marcaGeraReceitaSql } from './receita-marca-sql.js'
import { marcaStatusOperacionalSql } from './entity-status.js'
import { tiktokUsernameSql } from './tiktok-username.js'
import { liveGmvSql } from './metric-sql.js'
import { activeLiveSql } from './live-merge-sql.js'
import { notArchivedSql, saoPauloInclusiveRangeSql } from './live-count-sql.js'

/** Status operacional do cadastro (cliente apagado/arquivado/cancelado derruba a marca). */
export function cadastroStatusSql(marca = 'm', cliente = 'c') {
  return marcaStatusOperacionalSql(marca, cliente, { considerarExcluido: true })
}

/**
 * FROM + JOINs do cadastro. A ficha só é juntada para marca tipo='cliente':
 * marca afiliada/própria/parceira com cliente_id (invariante I4) NÃO herda
 * contato/cnpj de um cliente — continua cadastro separado (decisão do dono #1).
 */
export function cadastroFromSql(tenantParam = '$1') {
  return `FROM marcas m
    LEFT JOIN clientes c
      ON c.id = m.cliente_id AND c.tenant_id = m.tenant_id AND m.tipo = 'cliente'
    LEFT JOIN users u
      ON u.id = c.user_id AND u.tenant_id = c.tenant_id AND u.papel = 'cliente_parceiro'
    LEFT JOIN LATERAL (
      SELECT * FROM (SELECT id, cancelled_at, fixo_mensal, comissao_franquia_pct, tipo_cobranca,
             fixo_confirmado, comissao_confirmada, origem
        FROM marca_condicoes_comerciais
       WHERE tenant_id = ${tenantParam}::uuid AND marca_id = m.id
         AND inicio_vigencia <= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
       ORDER BY inicio_vigencia DESC, revision DESC
       LIMIT 1) latest WHERE latest.cancelled_at IS NULL
    ) mcc ON true
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object(
        'id', am.apresentadora_id,
        'nome', a.nome,
        'papel', am.papel,
        'comissao_video_pct', am.comissao_video_pct
      ) ORDER BY am.papel, a.nome) AS apresentadoras
      FROM apresentadora_marcas am
      JOIN apresentadoras a ON a.id = am.apresentadora_id AND a.tenant_id = am.tenant_id
      WHERE am.marca_id = m.id
        AND am.tenant_id = ${tenantParam}::uuid
        AND am.ativo = true
        AND a.ativo IS NOT FALSE AND a.arquivada IS NOT TRUE
    ) am_agg ON true`
}

/** GMV/lives/vídeos do mês por marca (mesma fonte do GET /v1/marcas). */
export function cadastroMetricasMesJoinSql(tenantParam, startParam, endParam) {
  return `LEFT JOIN (
      SELECT id, COALESCE(SUM(gmv), 0) AS gmv_mes,
             COALESCE(SUM(is_live), 0)::int AS lives_mes,
             COALESCE(SUM(is_video), 0)::int AS videos_mes
      FROM (
        SELECT l.marca_id AS id, ${liveGmvSql('l')} AS gmv, 1 AS is_live, 0 AS is_video
        FROM lives l
        WHERE l.tenant_id = ${tenantParam}::uuid AND l.status = 'encerrada' AND l.marca_id IS NOT NULL
          AND ${activeLiveSql('l')}
          AND ${notArchivedSql('l')}
          AND ${saoPauloInclusiveRangeSql('l.iniciado_em', startParam, endParam)}
        UNION ALL
        SELECT vr.marca_id AS id, vr.gmv_atribuido AS gmv, 0 AS is_live, 1 AS is_video
        FROM video_registros vr
        WHERE vr.tenant_id = ${tenantParam}::uuid
          AND vr.data >= ${startParam}::date AND vr.data <= ${endParam}::date
      ) t GROUP BY id
    ) mtr ON mtr.id = m.id`
}

/**
 * Colunas do cadastro. Contrato de GET /v1/cadastros (o front consome estes nomes):
 * id (= marca_id), marca_id, cliente_id (ficha), tipo, sistema, gera_receita,
 * status_operacional (+ status, alias), status_comercial (clientes.status),
 * campos da ficha e da marca.
 */
export function cadastroColsSql() {
  return `
    m.id AS id,
    m.id AS marca_id,
    c.id AS cliente_id,
    m.tenant_id,
    m.nome,
    m.tipo,
    COALESCE(m.sistema, false) AS sistema,
    (${marcaGeraReceitaSql('m')}) AS gera_receita,
    ${cadastroStatusSql('m', 'c')} AS status_operacional,
    ${cadastroStatusSql('m', 'c')} AS status,
    c.status AS status_comercial,
    ${tiktokUsernameSql({ marca: 'm', cliente: 'c' })} AS tiktok_username,
    COALESCE(m.site, c.site) AS site,
    m.marketplace_url,
    COALESCE(m.logo_url, c.logo_url) AS logo_url,
    m.cor,
    m.data_inicio,
    m.data_fim,
    m.observacoes,
    m.origem_dados,
    m.criado_em,
    m.atualizado_em,
    c.nome AS cliente_nome,
    c.celular,
    c.email,
    c.cnpj,
    c.razao_social,
    c.nicho,
    c.cidade,
    c.estado,
    c.gateway_customer_id,
    c.user_id AS acesso_user_id,
    u.email AS acesso_email,
    u.ativo AS acesso_ativo,
    COALESCE(am_agg.apresentadoras, '[]'::json) AS apresentadoras,
    mcc.id AS comercial_condicao_id,
    mcc.fixo_mensal AS comercial_fixo_mensal,
    mcc.comissao_franquia_pct AS comercial_comissao_franquia_pct,
    mcc.tipo_cobranca AS comercial_tipo_cobranca,
    mcc.fixo_confirmado AS comercial_fixo_confirmado,
    mcc.comissao_confirmada AS comercial_comissao_confirmada,
    mcc.origem AS comercial_origem`
}

/** Campos de contato/faturamento da ficha — escondidos da chave de API (ver services/cadastros.js). */
export const CAMPOS_FICHA_SENSIVEIS = Object.freeze([
  'celular', 'email', 'cnpj', 'razao_social', 'gateway_customer_id',
  'acesso_user_id', 'acesso_email', 'acesso_ativo',
])
