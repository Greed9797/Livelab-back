import { resolvePresenterCommissionPct } from './presenter-commission.js'
import { recalcularVendasAtribuidasApresentadora } from '../routes/vendas_atribuidas.js'
import { comissaoValorFromPct } from '../lib/comissao-sem-cabine.js'
import { calcularComissaoFranquia } from './comissao.js'
import { saoPauloDateInput } from '../lib/timezone.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MSG_CONFLITO_APRESENTADORA = 'Já existe uma live oficial desta apresentadora neste horário. Confira o registro e use Vincular live existente.'
const MSG_MARCA_INVALIDA = 'Marca ou apresentadora não é válida para esta unidade.'
const MSG_CLIENTE = 'Confira o vínculo e a situação do cliente antes de aprovar.'
const MSG_JA_REVISADA = 'Submissão não encontrada ou já revisada.'

function isConflitoHorarioError(error) {
  return error?.code === 'conflito_horario'
}

function litText(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function litUuid(value) {
  const text = String(value ?? '')
  if (!UUID_RE.test(text)) throw new Error('UUID inválido na aprovação em lote')
  return `'${text}'::uuid`
}

function litTimestamptz(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('Horário inválido na aprovação em lote')
  return `${litText(date.toISOString())}::timestamptz`
}

function litNumeric(value) {
  if (value == null) return 'NULL'
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error('Número inválido na aprovação em lote')
  return String(number)
}

function litInt(value) {
  if (value == null) return 'NULL'
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error('Inteiro inválido na aprovação em lote')
  return String(number)
}

function numOrNull(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function faixaPct(bands, baseGmv) {
  const match = [...(bands ?? [])]
    .filter((faixa) => numOrNull(faixa.gmv_inicio) != null && numOrNull(faixa.gmv_inicio) <= baseGmv
      && (faixa.gmv_fim == null || numOrNull(faixa.gmv_fim) >= baseGmv))
    .sort((a, b) => numOrNull(b.gmv_inicio) - numOrNull(a.gmv_inicio))[0]
  return match ? numOrNull(match.comissao_pct) : null
}

function marcaOperacional(info) {
  if (info.marca_tipo === 'cliente' && info.cliente_status === 'arquivado') return 'arquivada'
  if (info.marca_tipo === 'cliente' && ['cancelado', 'cancelado_automaticamente', 'reprovado'].includes(info.cliente_status)) return 'inativa'
  return info.marca_status ?? null
}

export function franquiaDaLinha(info, { presenterBands, defaultBands, gmvMes }) {
  const gmv = numOrNull(info.gmv_declarado) ?? 0
  const condicao = numOrNull(info.condicao_pct)
  if (condicao != null && condicao > 0) return comissaoValorFromPct(gmv, condicao)
  const marca = numOrNull(info.marca_pct)
  if (marca != null && marca > 0) return comissaoValorFromPct(gmv, marca)
  const base = numOrNull(gmvMes) ?? 0
  const pct = faixaPct(presenterBands, base) ?? faixaPct(defaultBands, base)
  if (pct == null || pct <= 0) return null
  return comissaoValorFromPct(gmv, pct)
}

export function motivoRecusaDaLinha(info) {
  if (!info) return MSG_JA_REVISADA
  if (info.conflito_apresentadora === true) return MSG_CONFLITO_APRESENTADORA
  const apresentadoraOk = info.apresentadora_ativa === true
    && info.apresentadora_arquivada !== true
    && info.user_ativo === true
    && info.user_id
  const marcaOk = info.marca_id && marcaOperacional(info) === 'ativa'
    && (info.cliente_id == null || info.cliente_encontrado === true)
  if (!apresentadoraOk || !marcaOk) return MSG_MARCA_INVALIDA
  const tipo = info.marca_tipo === 'afiliada' ? 'afiliado' : 'cliente'
  if ((tipo === 'cliente' && !info.cliente_id) || info.cliente_status === 'inadimplente') return MSG_CLIENTE
  return null
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA
}

function bandsByPresenter(faixas) {
  const map = new Map()
  for (const faixa of faixas ?? []) {
    const id = faixa.apresentadora_id
    if (!map.has(id)) map.set(id, [])
    map.get(id).push(faixa)
  }
  return map
}

function contextoSql() {
  return `/* lote-aprovacao:contexto */
    WITH base AS (
      SELECT s.id, s.apresentadora_id, s.marca_id, s.iniciado_em, s.encerrado_em,
             s.gmv_declarado, s.pedidos_declarados, s.observacao,
             s.live_impressions_declaradas, s.manual_views_declaradas, s.versao,
             a.user_id, a.ativo AS apresentadora_ativa, a.arquivada AS apresentadora_arquivada,
             u.ativo AS user_ativo,
             m.tipo AS marca_tipo, m.status AS marca_status, m.cliente_id,
             m.comissao_franquia_pct AS marca_pct,
             m.comissao_franqueadora_pct AS marca_franqueadora_pct,
             (cl.id IS NOT NULL) AS cliente_encontrado,
             cl.status AS cliente_status,
             mc.id AS marca_condicao_id,
             mc.comissao_franquia_pct AS condicao_pct,
             mc.comissao_franqueadora_pct AS condicao_franqueadora_pct,
             EXISTS (
               SELECT 1 FROM lives l
               WHERE l.tenant_id = s.tenant_id
                 AND a.user_id IS NOT NULL
                 AND l.apresentador_id = a.user_id
                 AND l.uniao_destino_id IS NULL
                 AND l.uniao_desfeita_em IS NULL
                 AND l.status <> 'cancelada'
                 AND l.iniciado_em < s.encerrado_em
                 AND COALESCE(l.encerrado_em, l.previsto_fim, 'infinity'::timestamptz) > s.iniciado_em
             ) AS conflito_apresentadora,
             COALESCE(gmv_mes.gmv, 0) AS gmv_mes
        FROM apresentadora_live_submissoes s
        LEFT JOIN apresentadoras a ON a.id = s.apresentadora_id AND a.tenant_id = s.tenant_id
        LEFT JOIN users u ON u.id = a.user_id AND u.tenant_id = a.tenant_id
        LEFT JOIN marcas m ON m.id = s.marca_id AND m.tenant_id = s.tenant_id
        LEFT JOIN clientes cl ON cl.id = m.cliente_id AND cl.tenant_id = m.tenant_id
        LEFT JOIN LATERAL (
          SELECT c.id, c.comissao_franquia_pct, c.comissao_franqueadora_pct
            FROM marca_condicoes_comerciais c
           WHERE c.tenant_id = s.tenant_id AND c.marca_id = s.marca_id
             AND c.inicio_vigencia <= (s.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date
             AND c.cancelled_at IS NULL
           ORDER BY c.inicio_vigencia DESC
           LIMIT 1
        ) mc ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(va.gmv), 0) AS gmv
            FROM vendas_atribuidas va
           WHERE va.tenant_id = s.tenant_id
             AND va.apresentadora_id = s.apresentadora_id
             AND date_trunc('month', va.data::timestamp) = date_trunc('month', ((s.iniciado_em AT TIME ZONE 'America/Sao_Paulo')::date)::timestamp)
        ) gmv_mes ON true
       WHERE s.tenant_id = $1::uuid AND s.id = ANY($2::uuid[])
    )
    SELECT json_build_object(
      'submissoes', COALESCE((SELECT json_agg(to_jsonb(base)) FROM base), '[]'::json),
      'faixas', COALESCE((
        SELECT json_agg(json_build_object(
          'apresentadora_id', f.apresentadora_id,
          'gmv_inicio', f.gmv_inicio,
          'gmv_fim', f.gmv_fim,
          'comissao_pct', f.comissao_pct
        ))
          FROM apresentadora_comissao_faixas f
         WHERE f.tenant_id = $1::uuid AND f.ativo IS TRUE
           AND f.apresentadora_id IN (SELECT apresentadora_id FROM base WHERE apresentadora_id IS NOT NULL)
      ), '[]'::json),
      'faixas_tenant', COALESCE((
        SELECT json_agg(json_build_object(
          'gmv_inicio', d.gmv_inicio,
          'gmv_fim', d.gmv_fim,
          'comissao_pct', d.comissao_pct
        ))
          FROM tenant_comissao_faixas_default d
         WHERE d.tenant_id = $1::uuid
      ), '[]'::json)
    ) AS payload`
}

function agendaFim(inicio, fim) {
  const start = new Date(inicio)
  const end = fim ? new Date(fim) : null
  if (!Number.isNaN(start.getTime()) && end && !Number.isNaN(end.getTime()) && end > start) return end
  return new Date(start.getTime() + 4 * 60 * 60 * 1000)
}

function scriptGravar(input) {
  const tenant = litUuid(input.tenantId)
  const submission = litUuid(input.submissionId)
  const revisor = litUuid(input.revisorId)
  const apresentadora = litUuid(input.apresentadoraId)
  const user = input.userId ? litUuid(input.userId) : 'NULL'
  const marca = litUuid(input.marcaId)
  const cliente = input.clienteId ? litUuid(input.clienteId) : 'NULL'
  const tipo = input.tipo === 'afiliado' ? litText('afiliado') : litText('cliente')
  const inicio = litTimestamptz(input.iniciadoEm)
  const fim = litTimestamptz(input.encerradoEm)
  const agenda = litTimestamptz(input.agendaFim)
  const gmv = litNumeric(input.gmv)
  const pedidos = litInt(input.pedidos)
  const impressions = litInt(input.impressions)
  const views = litInt(input.views)
  const observacao = input.observacao == null ? 'NULL' : litText(input.observacao)
  const franquia = litNumeric(input.franquia)
  const comissaoApresentadora = litNumeric(input.comissaoApresentadora)
  const comissaoPct = litNumeric(input.comissaoApresentadoraPct)
  const franqueadora = litNumeric(input.franqueadora)
  const condicao = input.marcaCondicaoId ? litUuid(input.marcaCondicaoId) : 'NULL'
  const data = litText(input.data)
  const lockKey = litText(input.lockKey)
  const userClash = input.userId ? `l.apresentador_id = ${user}` : 'FALSE'

  return `/* lote-aprovacao:gravar */
SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0));
CREATE TEMP TABLE _apr_locked ON COMMIT DROP AS
  SELECT * FROM apresentadora_live_submissoes
   WHERE id = ${submission} AND tenant_id = ${tenant}
     AND status = 'pendente' AND arquivamento_status IS NULL
   FOR UPDATE;
CREATE TEMP TABLE _apr_clash ON COMMIT DROP AS
  SELECT l.id FROM lives l
   WHERE EXISTS (SELECT 1 FROM _apr_locked)
     AND l.tenant_id = ${tenant}
     AND ${userClash}
     AND l.uniao_destino_id IS NULL AND l.uniao_desfeita_em IS NULL
     AND l.status <> 'cancelada'
     AND l.iniciado_em < ${fim}
     AND COALESCE(l.encerrado_em, l.previsto_fim, 'infinity'::timestamptz) > ${inicio}
   LIMIT 1;
CREATE TEMP TABLE _apr_agenda ON COMMIT DROP AS
  SELECT ae.id FROM agenda_eventos ae
   WHERE EXISTS (SELECT 1 FROM _apr_locked)
     AND NOT EXISTS (SELECT 1 FROM _apr_clash)
     AND ae.tenant_id = ${tenant} AND ae.tipo = 'live' AND ae.status <> 'cancelado'
     AND ae.live_id IS NULL AND ae.marca_id = ${marca} AND ae.cabine_id IS NULL
     AND ae.data_inicio < ${agenda} AND ae.data_fim > ${inicio}
   ORDER BY ABS(EXTRACT(EPOCH FROM (ae.data_inicio - ${inicio})))
   LIMIT 1;
CREATE TEMP TABLE _apr_live (id uuid) ON COMMIT DROP;
WITH ins AS (
  INSERT INTO lives (
    tenant_id, cabine_id, cliente_id, apresentador_id, gestor_id, status,
    iniciado_em, encerrado_em, fat_gerado, final_orders_count, live_impressions, manual_views,
    resumo, tipo, status_publicacao, origem_dados, marca_id,
    comissao_calculada, comissao_apresentadora_pct, comissao_apresentadora_valor
  )
  SELECT ${tenant}, NULL, ${cliente}, ${user}, ${revisor}, 'encerrada',
         ${inicio}, ${fim}, ${gmv}, ${pedidos}, ${impressions}, ${views},
         ${observacao}, ${tipo}, 'revisado', 'apresentadora', ${marca},
         ${franquia}, ${comissaoPct}, ${comissaoApresentadora}
    FROM _apr_locked
   WHERE NOT EXISTS (SELECT 1 FROM _apr_clash)
     AND NOT EXISTS (SELECT 1 FROM _apr_agenda)
  RETURNING id
)
INSERT INTO _apr_live SELECT id FROM ins;
CREATE TEMP TABLE _apr_agenda_nova (id uuid) ON COMMIT DROP;
WITH ins AS (
  INSERT INTO agenda_eventos (
    tenant_id, tipo, marca_id, cabine_id, apresentadora_id, data_inicio, data_fim,
    status, live_id, observacoes, criado_por
  )
  SELECT ${tenant}, 'live', ${marca}, NULL, ${apresentadora}, ${inicio}, ${agenda},
         'concluido', l.id, COALESCE(${observacao}, 'Live criada automaticamente a partir do registro operacional.'), ${revisor}
    FROM _apr_live l
  RETURNING id
)
INSERT INTO _apr_agenda_nova SELECT id FROM ins;
UPDATE lives l
   SET agenda_evento_id = a.id
  FROM _apr_agenda_nova a, _apr_live n
 WHERE l.id = n.id AND l.tenant_id = ${tenant};
INSERT INTO live_apresentadoras_v2 (tenant_id, live_id, apresentadora_id)
SELECT ${tenant}, l.id, ${apresentadora} FROM _apr_live l
ON CONFLICT (live_id, apresentadora_id) DO NOTHING;
INSERT INTO vendas_atribuidas (
  tenant_id, origem, origem_id, marca_id, apresentadora_id, data,
  gmv, pedidos, comissao_apresentadora, comissao_franquia, comissao_franqueadora,
  status_aprovacao, marca_condicao_id
)
SELECT ${tenant}, 'live', l.id, ${marca}, ${apresentadora}, ${data}::date,
       ${gmv}, ${pedidos}, ${comissaoApresentadora}, ${franquia}, ${franqueadora},
       'pendente_aprovacao', ${condicao}
  FROM _apr_live l;
CREATE TEMP TABLE _apr_done (id uuid) ON COMMIT DROP;
WITH upd AS (
  UPDATE apresentadora_live_submissoes s
     SET status = 'aprovada',
         live_oficial_id = l.id,
         revisado_por = ${revisor},
         revisado_em = NOW(),
         atualizado_em = NOW(),
         live_impressions_oficiais = ${impressions},
         manual_views_oficiais = ${views}
    FROM _apr_live l
   WHERE s.id = ${submission} AND s.tenant_id = ${tenant}
     AND s.status IN ('pendente', 'devolvida')
  RETURNING s.id
)
INSERT INTO _apr_done SELECT id FROM upd;
INSERT INTO apresentadora_live_submissao_historico (tenant_id, submissao_id, versao, acao, ator_id, motivo, snapshot)
SELECT ${tenant}, s.id, s.versao, 'aprovada', ${revisor}, NULL, jsonb_build_object(
  'status', s.status, 'marca_id', s.marca_id, 'marca_descricao', s.marca_descricao,
  'cabine_id', s.cabine_id, 'iniciado_em', s.iniciado_em, 'encerrado_em', s.encerrado_em,
  'observacao', s.observacao, 'gmv_declarado', s.gmv_declarado, 'pedidos_declarados', s.pedidos_declarados,
  'live_impressions_declaradas', s.live_impressions_declaradas, 'manual_views_declaradas', s.manual_views_declaradas,
  'live_impressions_oficiais', s.live_impressions_oficiais, 'manual_views_oficiais', s.manual_views_oficiais,
  'live_oficial_id', s.live_oficial_id, 'motivo_devolucao', s.motivo_devolucao,
  'arquivamento_status', s.arquivamento_status, 'motivo_contestacao', s.motivo_contestacao,
  'revisado_por', s.revisado_por, 'revisado_em', s.revisado_em)
  FROM apresentadora_live_submissoes s
 WHERE s.id = ${submission} AND s.tenant_id = ${tenant}
   AND EXISTS (SELECT 1 FROM _apr_done);
SELECT CASE
         WHEN NOT EXISTS (SELECT 1 FROM _apr_locked) THEN 'missing'
         WHEN EXISTS (SELECT 1 FROM _apr_clash) THEN 'conflict'
         WHEN EXISTS (SELECT 1 FROM _apr_agenda) THEN 'slow'
         WHEN EXISTS (SELECT 1 FROM _apr_done) THEN 'approved'
         ELSE 'invalid'
       END AS outcome,
       (SELECT id FROM _apr_live LIMIT 1) AS live_id;`
}

function lastRows(result) {
  const list = Array.isArray(result) ? result : [result]
  return list[list.length - 1]?.rows ?? []
}

async function gravarLimpa(query, input) {
  const gmv = Number(input.gmv ?? 0)
  if (gmv > 0 && input.franquia === 0) {
    throw new Error('Comissão da franquia não pode ser gravada como 0.')
  }
  const result = await query(scriptGravar(input))
  return lastRows(result)[0] ?? { outcome: 'invalid', live_id: null }
}

async function repararFranquia(query, tenantId, repairs) {
  const positives = repairs.filter((item) => item.franquia != null)
  const nulls = repairs.filter((item) => item.franquia == null).map((item) => item.liveId)
  if (positives.length) {
    const payload = JSON.stringify(positives.map((item) => ({ live_id: item.liveId, valor: item.franquia })))
    await query(
      `/* lote-aprovacao:reparar */
       UPDATE vendas_atribuidas va
          SET comissao_franquia = u.valor
         FROM jsonb_to_recordset($2::jsonb) AS u(live_id uuid, valor numeric)
        WHERE va.tenant_id = $1::uuid AND va.origem = 'live' AND va.origem_id = u.live_id
          AND va.comissao_franquia = 0
          AND (
            SELECT COUNT(*) FROM vendas_atribuidas x
             WHERE x.tenant_id = va.tenant_id AND x.origem = 'live' AND x.origem_id = va.origem_id
               AND x.comissao_franquia = 0
          ) = 1`,
      [tenantId, payload],
    )
    await query(
      `UPDATE lives l
          SET comissao_calculada = u.valor
         FROM jsonb_to_recordset($2::jsonb) AS u(live_id uuid, valor numeric)
        WHERE l.tenant_id = $1::uuid AND l.id = u.live_id AND l.comissao_calculada = 0`,
      [tenantId, payload],
    )
  }
  if (nulls.length) {
    await query(
      `/* lote-aprovacao:reparar */
       UPDATE vendas_atribuidas
          SET comissao_franquia = NULL
        WHERE tenant_id = $1::uuid AND origem = 'live' AND origem_id = ANY($2::uuid[])`,
      [tenantId, nulls],
    )
    await query(
      `UPDATE lives SET comissao_calculada = NULL
        WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`,
      [tenantId, nulls],
    )
  }
}

function pushConflict(buckets, described, reason) {
  const item = { ...described, reason }
  buckets.skipped_conflito.push(item)
  buckets.skipped.push({ ...item, conflito: true })
}

export async function aprovarLoteNaSessao({
  actionable,
  tenantId,
  revisorId,
  recordHistory,
  session,
  approve,
  recalculateMonth = recalcularVendasAtribuidasApresentadora,
  buckets,
}) {
  if (!actionable.length) return
  const loaded = await session.query(contextoSql(), [tenantId, actionable.map((item) => item.row.id)])
  const payload = loaded.rows?.[0]?.payload ?? {}
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload
  const byId = new Map((parsed.submissoes ?? []).map((row) => [row.id, row]))
  const faixas = bandsByPresenter(parsed.faixas ?? [])
  const faixasTenant = parsed.faixas_tenant ?? []
  const aprovadasNoLote = []
  const gmvMes = new Map()
  const lifts = new Map()
  const repairs = []

  for (const item of actionable) {
    const info = byId.get(item.row.id)
    const described = item.described
    const recusa = motivoRecusaDaLinha(info)
    if (recusa === MSG_CONFLITO_APRESENTADORA) {
      pushConflict(buckets, described, recusa)
      continue
    }
    if (recusa) {
      buckets.failed.push({ ...described, error: recusa })
      continue
    }
    const start = new Date(info.iniciado_em).getTime()
    const end = new Date(info.encerrado_em).getTime()
    const chocaLote = info.user_id && aprovadasNoLote.some((prev) => prev.userId === info.user_id && overlaps(prev.start, prev.end, start, end))
    if (chocaLote) {
      pushConflict(buckets, described, MSG_CONFLITO_APRESENTADORA)
      continue
    }

    const mes = saoPauloDateInput(info.iniciado_em)?.slice(0, 7) ?? null
    const gmvBase = gmvMes.has(info.apresentadora_id) ? gmvMes.get(info.apresentadora_id) : numOrNull(info.gmv_mes) ?? 0
    const gmv = numOrNull(info.gmv_declarado) ?? 0
    const presenterBands = [...(faixas.get(info.apresentadora_id) ?? [])].sort((a, b) => numOrNull(b.gmv_inicio) - numOrNull(a.gmv_inicio))
    const defaultBands = [...faixasTenant].sort((a, b) => numOrNull(b.gmv_inicio) - numOrNull(a.gmv_inicio))
    const franquia = franquiaDaLinha(info, { presenterBands, defaultBands, gmvMes: gmvBase + gmv })
    let comissaoApresentadora = 0
    let comissaoApresentadoraPct = 0
    if (info.apresentadora_id) {
      comissaoApresentadoraPct = await resolvePresenterCommissionPct({ query: async () => { throw new Error('faixa já carregada') } }, {
        tenantId,
        apresentadoraId: info.apresentadora_id,
        origem: 'live',
        origemId: info.id,
        data: info.iniciado_em,
        gmv,
        monthlyContext: { gmvExcludingOrigin: gmvBase, presenterBands, defaultBands },
      })
      comissaoApresentadora = gmv * (Number(comissaoApresentadoraPct) / 100)
    }
    const franqueadoraPct = numOrNull(info.condicao_franqueadora_pct) ?? numOrNull(info.marca_franqueadora_pct) ?? 0
    const data = saoPauloDateInput(info.iniciado_em)

    try {
      const outcome = await gravarLimpa(session.query, {
        tenantId,
        submissionId: info.id,
        revisorId,
        apresentadoraId: info.apresentadora_id,
        userId: info.user_id,
        marcaId: info.marca_id,
        clienteId: info.cliente_id,
        tipo: info.marca_tipo === 'afiliada' ? 'afiliado' : 'cliente',
        iniciadoEm: info.iniciado_em,
        encerradoEm: info.encerrado_em,
        agendaFim: agendaFim(info.iniciado_em, info.encerrado_em),
        gmv,
        pedidos: numOrNull(info.pedidos_declarados) ?? 0,
        impressions: numOrNull(info.live_impressions_declaradas),
        views: numOrNull(info.manual_views_declaradas),
        observacao: info.observacao ?? null,
        franquia,
        comissaoApresentadora,
        comissaoApresentadoraPct,
        franqueadora: calcularComissaoFranquia({ gmv, pct: franqueadoraPct }),
        marcaCondicaoId: info.marca_condicao_id ?? null,
        data,
        lockKey: `live-approve:${tenantId}:${info.apresentadora_id}`,
      })

      let liveId = outcome?.live_id ?? null
      if (outcome?.outcome === 'conflict') {
        pushConflict(buckets, described, MSG_CONFLITO_APRESENTADORA)
        continue
      }
      if (outcome?.outcome === 'slow') {
        const slow = await session.transaction((db) => approve(db, {
          tenantId,
          revisorId,
          submissionId: info.id,
          parsed: item.oficial,
          recordHistory,
          deferMonthRecalc: true,
        }))
        liveId = slow.live_oficial_id
      } else if (outcome?.outcome !== 'approved' || !liveId) {
        buckets.failed.push({ ...described, error: outcome?.outcome === 'missing' ? MSG_JA_REVISADA : 'Erro ao aprovar envio.' })
        continue
      }

      buckets.approved.push({ ...described, live_oficial_id: liveId })
      if (info.user_id) aprovadasNoLote.push({ userId: info.user_id, start, end })
      gmvMes.set(info.apresentadora_id, gmvBase + gmv)
      if (info.apresentadora_id && mes) lifts.set(`${info.apresentadora_id}|${mes}`, { apresentadoraId: info.apresentadora_id, mes })
      repairs.push({ liveId, franquia })
    } catch (error) {
      if (isConflitoHorarioError(error)) {
        pushConflict(buckets, described, error.message)
        continue
      }
      buckets.failed.push({ ...described, error: error?.message ?? 'Erro ao aprovar envio.' })
    }
  }

  if (!lifts.size && !repairs.length) return
  try {
    await session.transaction(async (db) => {
      for (const lift of lifts.values()) {
        await db.query('SAVEPOINT batch_retro_lift')
        try {
          await recalculateMonth(db, { tenantId, apresentadoraId: lift.apresentadoraId, mesReferencia: lift.mes })
          await db.query('RELEASE SAVEPOINT batch_retro_lift')
        } catch (error) {
          await db.query('ROLLBACK TO SAVEPOINT batch_retro_lift')
          console.warn(`comissao: retro-lift do lote falhou (apresentadora ${lift.apresentadoraId}):`, error?.message ?? error)
        }
      }
      if (repairs.length) await repararFranquia(db.query, tenantId, repairs)
    })
  } catch (error) {
    console.warn('comissao: fechamento do lote falhou depois das aprovações:', error?.message ?? error)
  }
}

export const __test = { scriptGravar, contextoSql, gravarLimpa }
