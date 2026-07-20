import { notify } from '../services/mailer.js'
import { scanPorTenant } from './tenant_scan.js'

export async function cleanupOrphanContracts(app) {
  const expirationDays = Number(process.env.CONTRACT_EXPIRATION_DAYS ?? 5)

  // Este CTE ESCREVE cross-tenant (UPDATE contratos + UPDATE clientes + INSERT
  // contrato_eventos). Sob RLS, rodar via app.db.query não só deixaria de achar
  // linhas: o WITH CHECK das policies de escrita rejeitaria (ou filtraria) as
  // mutações silenciosamente. scanPorTenant roda o statement inteiro dentro de
  // uma transação por tenant, então SELECT e as três escritas acontecem todos
  // no contexto do tenant certo, e cada tenant commita isoladamente.
  // Sem LIMIT: nada muda de semântica ao particionar por tenant.
  const cancelados = await scanPorTenant(
    app,
    `WITH expired AS (
       SELECT id, tenant_id, cliente_id
       FROM contratos
       WHERE status = 'reprovado'
         AND reviewed_at IS NOT NULL
         AND reviewed_at <= NOW() - ($1::text || ' days')::interval
         AND cancelado_automaticamente_em IS NULL
     ), updated_contratos AS (
       UPDATE contratos c
       SET status = 'cancelado_automaticamente',
           cancelado_automaticamente_em = NOW(),
           cancelado_em = NOW()
       FROM expired e
       WHERE c.id = e.id
       RETURNING c.id, c.tenant_id, c.cliente_id
     ), updated_clientes AS (
       UPDATE clientes cl
       SET status = 'cancelado_automaticamente',
           atualizado_em = NOW()
       FROM updated_contratos uc
       WHERE cl.id = uc.cliente_id
       RETURNING cl.id
     )
     INSERT INTO contrato_eventos (
       tenant_id,
       contrato_id,
       tipo_evento,
       actor_papel,
       payload_json
     )
      SELECT
        uc.tenant_id,
        uc.id,
        'contrato_cancelado_automaticamente',
        'system',
        jsonb_build_object('reason', 'prazo expirado sem decisão do franqueado')
      FROM updated_contratos uc
      RETURNING contrato_id, tenant_id`,
    [String(expirationDays)],
    '[cleanup contratos orfaos]',
  )

  const total = cancelados.length
  if (total > 0) {
    app.log.info({ total, expirationDays }, 'Contratos órfãos cancelados automaticamente')

    // F1: notifica franqueado de cada contrato cancelado (fire-and-forget).
    ;(async () => {
      try {
        const ids = cancelados.map(r => r.contrato_id)
        if (ids.length === 0) return
        // Também sob RLS (contratos + clientes). Cada tenant enxerga só os seus
        // ids; a união reconstrói a lista completa.
        const rows = await scanPorTenant(
          app,
          `SELECT c.id AS contrato_id, c.tenant_id, cl.nome AS cliente_nome, cl.email AS cliente_email,
                  t.email_contato AS tenant_email, t.notif_email_ativo, t.notif_contrato
           FROM contratos c
           JOIN clientes cl ON cl.id = c.cliente_id
           JOIN tenants t ON t.id = c.tenant_id
           WHERE c.id = ANY($1::uuid[])`,
          [ids],
          '[cleanup contratos orfaos notify]',
        )
        for (const r of rows) {
          const settings = {
            notif_email_ativo: r.notif_email_ativo,
            notif_contrato: r.notif_contrato,
          }
          const vars = {
            cliente_nome: r.cliente_nome,
            score: '—',
            risco: '—',
            motivo: 'Prazo expirado sem decisão do franqueado.',
          }
          if (r.tenant_email) {
            await notify({
              app, tenantId: r.tenant_id, to: r.tenant_email,
              template: 'contrato_reprovado', refId: r.contrato_id,
              settings, settingsKey: 'notif_contrato', dedupe: true, vars,
            })
          }
        }
      } catch (err) {
        app.log.error({ err }, 'mailer: falha ao notificar contratos cancelados automaticamente')
      }
    })()
  }

  return total
}
