import { calcularComissoesDaLive } from './commission-engine.js'
import { calcularComissaoApresentadora } from './comissao.js'
import { comissaoValorFromPct, resolveComissaoPctSemCabine } from '../lib/comissao-sem-cabine.js'
import { seedRateioPlanejado } from '../lib/agenda-turnos.js'
import { syncAgendaEventForLive } from '../lib/live-agenda-sync.js'
import { recalcularVendasAtribuidasApresentadora } from '../routes/vendas_atribuidas.js'
import { saoPauloDateInput } from '../lib/timezone.js'
import { marcaStatusOperacionalSql } from '../lib/entity-status.js'

// Materializa um relato APROVADO dentro da transação do revisor. Não aceita
// A identidade vem da submissão bloqueada; os valores oficiais foram conferidos
// pelo gestor. Os mesmos helpers do registro manual mantêm agenda/rateio/comissão.
export async function criarLiveOficialDaSubmissao(db, { tenantId, revisorId, submissao, oficial }) {
  const cabineId = oficial.cabine_id ?? null

  const refs = cabineId
    ? await db.query(`SELECT m.cliente_id, m.tipo, a.user_id, a.comissao_pct AS apresentadora_pct,
        cl.status AS cliente_status, ct.comissao_pct AS contrato_pct
      FROM marcas m JOIN apresentadoras a ON a.id=$3::uuid AND a.tenant_id=m.tenant_id
      JOIN cabines c ON c.id=$4::uuid AND c.tenant_id=m.tenant_id AND c.ativo IS DISTINCT FROM FALSE
      JOIN users u ON u.id=a.user_id AND u.tenant_id=a.tenant_id AND u.ativo IS TRUE
      LEFT JOIN clientes cl ON cl.id=m.cliente_id AND cl.tenant_id=m.tenant_id
      LEFT JOIN contratos ct ON ct.id=c.contrato_id AND ct.tenant_id=c.tenant_id AND ct.status='ativo'
      WHERE m.id=$2::uuid AND m.tenant_id=$1::uuid AND ${marcaStatusOperacionalSql('m', 'cl')}='ativa'
        AND a.ativo IS TRUE AND a.arquivada IS DISTINCT FROM TRUE
        AND (m.cliente_id IS NULL OR cl.id IS NOT NULL)
        AND (c.contrato_id IS NULL OR EXISTS (SELECT 1 FROM contratos x WHERE x.id=c.contrato_id AND x.tenant_id=c.tenant_id))
      FOR UPDATE OF c`, [tenantId, oficial.marca_id, submissao.apresentadora_id, cabineId])
    : await db.query(`SELECT m.cliente_id, m.tipo, a.user_id, a.comissao_pct AS apresentadora_pct,
        cl.status AS cliente_status, NULL::numeric AS contrato_pct
      FROM marcas m JOIN apresentadoras a ON a.id=$3::uuid AND a.tenant_id=m.tenant_id
      JOIN users u ON u.id=a.user_id AND u.tenant_id=a.tenant_id AND u.ativo IS TRUE
      LEFT JOIN clientes cl ON cl.id=m.cliente_id AND cl.tenant_id=m.tenant_id
      WHERE m.id=$2::uuid AND m.tenant_id=$1::uuid AND ${marcaStatusOperacionalSql('m', 'cl')}='ativa'
        AND a.ativo IS TRUE AND a.arquivada IS DISTINCT FROM TRUE
        AND (m.cliente_id IS NULL OR cl.id IS NOT NULL)
      FOR UPDATE OF m`, [tenantId, oficial.marca_id, submissao.apresentadora_id])

  const ref = refs.rows[0]
  if (!ref) {
    const error = new Error(cabineId
      ? 'Marca, cabine ou apresentadora não é válida para esta unidade.'
      : 'Marca ou apresentadora não é válida para esta unidade.')
    error.statusCode = 422
    throw error
  }
  const tipo = ref.tipo === 'afiliada' ? 'afiliado' : 'cliente'
  if ((tipo === 'cliente' && !ref.cliente_id) || ref.cliente_status === 'inadimplente') {
    const error = new Error('Confira o vínculo e a situação do cliente antes de aprovar.')
    error.statusCode = 422
    throw error
  }

  const gmv = Number(oficial.gmv_oficial)
  const pedidos = Number(oficial.pedidos_oficiais)

  if (cabineId) {
    const conflict = await db.query(`SELECT id FROM lives WHERE tenant_id=$1::uuid AND cabine_id=$2::uuid
      AND uniao_destino_id IS NULL AND uniao_desfeita_em IS NULL
      AND status <> 'cancelada' AND iniciado_em < $4::timestamptz
      AND COALESCE(encerrado_em,previsto_fim,'infinity'::timestamptz) > $3::timestamptz LIMIT 1`,
    [tenantId, cabineId, oficial.iniciado_em, oficial.encerrado_em])
    if (conflict.rows[0]) {
      const error = new Error('Já existe uma live nesse horário e cabine. Confira o registro e use Vincular live existente.')
      error.statusCode = 409
      throw error
    }
  } else if (ref.user_id) {
    const conflict = await db.query(`SELECT id FROM lives WHERE tenant_id=$1::uuid AND apresentador_id=$2::uuid
      AND uniao_destino_id IS NULL AND uniao_desfeita_em IS NULL
      AND status <> 'cancelada' AND iniciado_em < $4::timestamptz
      AND COALESCE(encerrado_em,previsto_fim,'infinity'::timestamptz) > $3::timestamptz LIMIT 1`,
    [tenantId, ref.user_id, oficial.iniciado_em, oficial.encerrado_em])
    if (conflict.rows[0]) {
      const error = new Error('Já existe uma live oficial desta apresentadora neste horário. Confira o registro e use Vincular live existente.')
      error.statusCode = 409
      throw error
    }
  }

  let comissaoFranquia = null
  if (cabineId) {
    const pctContrato = ref.contrato_pct == null ? null : Number(ref.contrato_pct)
    comissaoFranquia = pctContrato == null ? null : gmv * (pctContrato / 100)
  } else {
    const pct = await resolveComissaoPctSemCabine(db, {
      tenantId,
      marcaId: oficial.marca_id,
      apresentadoraId: submissao.apresentadora_id,
      gmv,
      data: saoPauloDateInput(oficial.iniciado_em),
    })
    comissaoFranquia = comissaoValorFromPct(gmv, pct)
  }

  const snapshot = calcularComissaoApresentadora({
    fatGerado: gmv,
    apresentadoraPct: ref.apresentadora_pct == null ? null : Number(ref.apresentadora_pct),
    iniciadoEm: oficial.iniciado_em,
    temApresentadora: true,
  })
  const created = await db.query(`INSERT INTO lives (tenant_id,cabine_id,cliente_id,apresentador_id,gestor_id,status,iniciado_em,encerrado_em,fat_gerado,final_orders_count,live_impressions,manual_views,resumo,tipo,status_publicacao,origem_dados,marca_id,comissao_calculada,comissao_apresentadora_pct,comissao_apresentadora_valor)
    VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'encerrada',$6::timestamptz,$7::timestamptz,$8::numeric,$9::int,$10::bigint,$11::int,$12,$14,'revisado','apresentadora',$13::uuid,$15,$16,$17) RETURNING id`,
  [tenantId, cabineId, ref.cliente_id, ref.user_id, revisorId, oficial.iniciado_em, oficial.encerrado_em, gmv, pedidos, oficial.live_impressions_oficiais ?? null, oficial.manual_views_oficiais ?? null, submissao.observacao ?? null, oficial.marca_id, tipo, comissaoFranquia, snapshot.pct, snapshot.valor])
  const liveId = created.rows[0].id
  const agendaId = await syncAgendaEventForLive(db, {
    tenantId,
    liveId,
    cabineId,
    marcaId: oficial.marca_id,
    apresentadoraId: submissao.apresentadora_id,
    dataInicio: oficial.iniciado_em,
    dataFim: oficial.encerrado_em,
    status: 'encerrada',
    observacoes: submissao.observacao,
    criadoPor: revisorId,
  })
  await seedRateioPlanejado(db, {
    tenantId,
    liveId,
    agendaEventoId: agendaId,
    apresentadoraFallbackId: submissao.apresentadora_id,
    apresentadoraConfirmadaId: submissao.apresentadora_id,
  })
  const sales = await calcularComissoesDaLive(db, { liveId, tenantId, gmv, pedidos, retroLift: false })
  for (const apresentadoraId of new Set(sales.map(row => row.apresentadora_id).filter(Boolean))) {
    await recalcularVendasAtribuidasApresentadora(db, {
      tenantId,
      apresentadoraId,
      mesReferencia: saoPauloDateInput(oficial.iniciado_em).slice(0, 7),
    })
  }
  return liveId
}
