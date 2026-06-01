import { liveGmvSql, liveOrdersSql } from './metric-sql.js'

const toNum = (value) => Number(value ?? 0)

export function resolveMonthRange(query = {}) {
  const periodo = typeof query.periodo === 'string' && /^\d{4}-\d{2}$/.test(query.periodo)
    ? query.periodo
    : null
  const inicio = typeof query.inicio === 'string' && /^\d{4}-\d{2}$/.test(query.inicio)
    ? query.inicio
    : periodo
  const fim = typeof query.fim === 'string' && /^\d{4}-\d{2}$/.test(query.fim)
    ? query.fim
    : inicio

  if (inicio && fim) {
    const [fy, fm] = fim.split('-').map(Number)
    return {
      startDate: `${inicio}-01`,
      endDate: new Date(Date.UTC(fy, fm, 0)).toISOString().slice(0, 10),
    }
  }

  const now = new Date()
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() + 1
  return {
    startDate: `${y}-${String(m).padStart(2, '0')}-01`,
    endDate: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10),
  }
}

function normalizeMetric(row = {}) {
  return {
    gmv_mes: toNum(row.gmv_mes),
    gmv_acumulado: toNum(row.gmv_acumulado),
    total_lives: toNum(row.total_lives),
    total_videos: toNum(row.total_videos),
    pedidos_mes: toNum(row.pedidos_mes),
    comissao_franquia: toNum(row.comissao_franquia),
    comissao_franqueadora: toNum(row.comissao_franqueadora),
    comissao_apresentadora: toNum(row.comissao_apresentadora),
  }
}

export async function getClienteOperacional(db, { tenantId, clienteId, startDate, endDate }) {
  const cliente = await db.query(
    `SELECT *
     FROM clientes
     WHERE id = $1 AND tenant_id = $2::uuid AND deleted_at IS NULL`,
    [clienteId, tenantId],
  )
  if (!cliente.rows[0]) return null

  const marcas = await db.query(
    `SELECT m.*
     FROM marcas m
     WHERE m.cliente_id = $1 AND m.tenant_id = $2::uuid
     ORDER BY m.status = 'ativa' DESC, m.nome ASC`,
    [clienteId, tenantId],
  )

  const metrics = await db.query(
    `WITH marca_scope AS (
       SELECT id FROM marcas WHERE cliente_id = $1 AND tenant_id = $2::uuid
     ),
     vendas AS (
       SELECT va.*
       FROM vendas_atribuidas va
       JOIN marca_scope ms ON ms.id = va.marca_id
       WHERE va.tenant_id = $2::uuid
     ),
     legacy_lives AS (
       SELECT l.id,
              ${liveGmvSql('l')} AS gmv,
              ${liveOrdersSql('l')} AS pedidos,
              l.encerrado_em
       FROM lives l
       WHERE l.tenant_id = $2::uuid
         AND l.cliente_id = $1
         AND l.id NOT IN (
           SELECT origem_id FROM vendas_atribuidas
           WHERE tenant_id = $2::uuid AND origem = 'live'
         )
     )
     SELECT
       COALESCE(SUM(v.gmv) FILTER (WHERE v.data >= $3::date AND v.data < ($4::date + interval '1 day')), 0)
         + COALESCE(SUM(ll.gmv) FILTER (WHERE ll.encerrado_em >= $3::date AND ll.encerrado_em < ($4::date + interval '1 day')), 0) AS gmv_mes,
       COALESCE(SUM(v.gmv), 0) + COALESCE(SUM(ll.gmv), 0) AS gmv_acumulado,
       COUNT(DISTINCT v.origem_id) FILTER (WHERE v.origem = 'live')::int
         + COUNT(DISTINCT ll.id)::int AS total_lives,
       COUNT(DISTINCT v.origem_id) FILTER (WHERE v.origem = 'video')::int AS total_videos,
       COALESCE(SUM(v.pedidos) FILTER (WHERE v.data >= $3::date AND v.data < ($4::date + interval '1 day')), 0)
         + COALESCE(SUM(ll.pedidos) FILTER (WHERE ll.encerrado_em >= $3::date AND ll.encerrado_em < ($4::date + interval '1 day')), 0) AS pedidos_mes,
       COALESCE(SUM(v.comissao_franquia), 0) AS comissao_franquia,
       COALESCE(SUM(v.comissao_franqueadora), 0) AS comissao_franqueadora,
       COALESCE(SUM(v.comissao_apresentadora), 0) AS comissao_apresentadora
     FROM vendas v
     FULL OUTER JOIN legacy_lives ll ON false`,
    [clienteId, tenantId, startDate, endDate],
  )

  const lives = await db.query(
    `WITH venda_live_marca AS (
       SELECT DISTINCT ON (va.origem_id)
              va.origem_id AS live_id,
              va.marca_id,
              m.nome AS marca_nome
       FROM vendas_atribuidas va
       JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
       WHERE va.tenant_id = $2::uuid
         AND va.origem = 'live'
         AND m.cliente_id = $1
       ORDER BY va.origem_id, va.atualizado_em DESC
     )
     SELECT l.id, l.cabine_id, l.cliente_id, vl.marca_id, l.iniciado_em, l.encerrado_em,
            l.status, l.status_publicacao,
            ${liveGmvSql('l')} AS gmv,
            ${liveOrdersSql('l')} AS pedidos,
            l.fat_gerado, l.final_orders_count,
            c.numero AS cabine_numero,
            vl.marca_nome,
            COALESCE(a.nome, u.nome) AS apresentadora_nome
     FROM lives l
     LEFT JOIN cabines c ON c.id = l.cabine_id AND c.tenant_id = l.tenant_id
     LEFT JOIN venda_live_marca vl ON vl.live_id = l.id
     LEFT JOIN live_apresentadoras_v2 lav ON lav.live_id = l.id AND lav.tenant_id = l.tenant_id AND lav.papel = 'principal'
     LEFT JOIN apresentadoras a ON a.id = lav.apresentadora_id AND a.tenant_id = l.tenant_id
     LEFT JOIN users u ON u.id = l.apresentador_id AND u.tenant_id = l.tenant_id
     WHERE l.tenant_id = $2::uuid
       AND (l.cliente_id = $1 OR vl.live_id IS NOT NULL)
     ORDER BY COALESCE(l.encerrado_em, l.iniciado_em) DESC NULLS LAST
     LIMIT 50`,
    [clienteId, tenantId],
  )

  const videos = await db.query(
    `SELECT vr.*, m.nome AS marca_nome, a.nome AS apresentadora_nome
     FROM video_registros vr
     JOIN marcas m ON m.id = vr.marca_id AND m.tenant_id = vr.tenant_id
     LEFT JOIN apresentadoras a ON a.id = vr.apresentadora_id AND a.tenant_id = vr.tenant_id
     WHERE vr.tenant_id = $2::uuid AND m.cliente_id = $1
     ORDER BY vr.data DESC, vr.criado_em DESC
     LIMIT 50`,
    [clienteId, tenantId],
  )

  const vendas = await db.query(
    `SELECT va.*, m.nome AS marca_nome, a.nome AS apresentadora_nome
     FROM vendas_atribuidas va
     JOIN marcas m ON m.id = va.marca_id AND m.tenant_id = va.tenant_id
     LEFT JOIN apresentadoras a ON a.id = va.apresentadora_id AND a.tenant_id = va.tenant_id
     WHERE va.tenant_id = $2::uuid AND m.cliente_id = $1
     ORDER BY va.data DESC, va.atualizado_em DESC
     LIMIT 100`,
    [clienteId, tenantId],
  )

  return {
    cliente: cliente.rows[0],
    marcas: marcas.rows,
    metrics: normalizeMetric(metrics.rows[0]),
    lives: lives.rows,
    videos: videos.rows,
    vendas_atribuidas: vendas.rows,
    apresentadoras: Array.from(new Map(vendas.rows
      .filter((row) => row.apresentadora_id)
      .map((row) => [row.apresentadora_id, { id: row.apresentadora_id, nome: row.apresentadora_nome }])).values()),
  }
}

export async function getMarcaOperacional(db, { tenantId, marcaId, startDate, endDate }) {
  const marca = await db.query(
    `SELECT m.*, c.nome AS cliente_nome
     FROM marcas m
     LEFT JOIN clientes c ON c.id = m.cliente_id AND c.tenant_id = m.tenant_id
     WHERE m.id = $1 AND m.tenant_id = $2::uuid`,
    [marcaId, tenantId],
  )
  if (!marca.rows[0]) return null

  const metrics = await db.query(
    `WITH vendas AS (
       SELECT * FROM vendas_atribuidas
       WHERE tenant_id = $2::uuid AND marca_id = $1
     )
     SELECT
       COALESCE(SUM(v.gmv) FILTER (WHERE v.data >= $3::date AND v.data < ($4::date + interval '1 day')), 0) AS gmv_mes,
       COALESCE(SUM(v.gmv), 0) AS gmv_acumulado,
       COUNT(DISTINCT v.origem_id) FILTER (WHERE v.origem = 'live')::int AS total_lives,
       COUNT(DISTINCT v.origem_id) FILTER (WHERE v.origem = 'video')::int AS total_videos,
       COALESCE(SUM(v.pedidos) FILTER (WHERE v.data >= $3::date AND v.data < ($4::date + interval '1 day')), 0) AS pedidos_mes,
       COALESCE(SUM(v.comissao_franquia), 0) AS comissao_franquia,
       COALESCE(SUM(v.comissao_franqueadora), 0) AS comissao_franqueadora,
       COALESCE(SUM(v.comissao_apresentadora), 0) AS comissao_apresentadora
     FROM vendas v`,
    [marcaId, tenantId, startDate, endDate],
  )

  const lives = await db.query(
    `WITH venda_live_marca AS (
       SELECT DISTINCT ON (va.origem_id)
              va.origem_id AS live_id,
              va.marca_id
       FROM vendas_atribuidas va
       WHERE va.tenant_id = $2::uuid
         AND va.origem = 'live'
         AND va.marca_id = $1
       ORDER BY va.origem_id, va.atualizado_em DESC
     )
     SELECT l.id, l.cabine_id, l.cliente_id, vl.marca_id, l.iniciado_em, l.encerrado_em,
            l.status, l.status_publicacao,
            ${liveGmvSql('l')} AS gmv,
            ${liveOrdersSql('l')} AS pedidos,
            l.fat_gerado, l.final_orders_count,
            c.numero AS cabine_numero,
            COALESCE(a.nome, u.nome) AS apresentadora_nome
     FROM lives l
     JOIN venda_live_marca vl ON vl.live_id = l.id
     LEFT JOIN cabines c ON c.id = l.cabine_id AND c.tenant_id = l.tenant_id
     LEFT JOIN live_apresentadoras_v2 lav ON lav.live_id = l.id AND lav.tenant_id = l.tenant_id AND lav.papel = 'principal'
     LEFT JOIN apresentadoras a ON a.id = lav.apresentadora_id AND a.tenant_id = l.tenant_id
     LEFT JOIN users u ON u.id = l.apresentador_id AND u.tenant_id = l.tenant_id
     WHERE l.tenant_id = $2::uuid
     ORDER BY COALESCE(l.encerrado_em, l.iniciado_em) DESC NULLS LAST
     LIMIT 50`,
    [marcaId, tenantId],
  )

  const videos = await db.query(
    `SELECT vr.*, a.nome AS apresentadora_nome
     FROM video_registros vr
     LEFT JOIN apresentadoras a ON a.id = vr.apresentadora_id AND a.tenant_id = vr.tenant_id
     WHERE vr.tenant_id = $2::uuid AND vr.marca_id = $1
     ORDER BY vr.data DESC, vr.criado_em DESC
     LIMIT 50`,
    [marcaId, tenantId],
  )

  const vendas = await db.query(
    `SELECT va.*, a.nome AS apresentadora_nome
     FROM vendas_atribuidas va
     LEFT JOIN apresentadoras a ON a.id = va.apresentadora_id AND a.tenant_id = va.tenant_id
     WHERE va.tenant_id = $2::uuid AND va.marca_id = $1
     ORDER BY va.data DESC, va.atualizado_em DESC
     LIMIT 100`,
    [marcaId, tenantId],
  )

  return {
    marca: marca.rows[0],
    metrics: normalizeMetric(metrics.rows[0]),
    lives: lives.rows,
    videos: videos.rows,
    vendas_atribuidas: vendas.rows,
    apresentadoras: Array.from(new Map(vendas.rows
      .filter((row) => row.apresentadora_id)
      .map((row) => [row.apresentadora_id, { id: row.apresentadora_id, nome: row.apresentadora_nome }])).values()),
  }
}
