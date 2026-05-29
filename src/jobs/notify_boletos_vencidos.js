// F1: notifica clientes sobre boletos vencidos.
// Roda 1x ao dia (cron 02:30 SP), depois do job que marca boletos como 'vencido'.
// Idempotente: usa notification_log.ref_id pra evitar enviar 2x pro mesmo boleto.

import { notify } from '../services/mailer.js'

/**
 * Para cada boleto com status='vencido', envia email — uma única vez.
 * Não diário: dedupe via notification_log (ref_id = boleto.id, tipo = 'boleto_vencido').
 */
export async function notifyBoletosVencidos(app) {
  // Busca boletos vencidos que ainda não foram notificados.
  // LEFT JOIN com notification_log filtrando enviados com sucesso.
  const { rows } = await app.db.query(
    `SELECT b.id, b.tenant_id, b.cliente_id, b.valor, b.vencimento, b.tipo,
            b.gateway_url, c.nome AS cliente_nome, c.email AS cliente_email,
            t.email_contato AS tenant_email,
            t.notif_email_ativo, t.notif_boleto_vencido
     FROM boletos b
     JOIN clientes c ON c.id = b.cliente_id
     JOIN tenants t ON t.id = b.tenant_id
     WHERE b.status = 'vencido'
       AND NOT EXISTS (
         SELECT 1 FROM notification_log n
         WHERE n.ref_id = b.id
           AND n.tipo = 'boleto_vencido'
           AND n.enviado_em IS NOT NULL
       )
     LIMIT 200`,
  )

  let enviados = 0
  let erros = 0
  for (const b of rows) {
    if (!b.cliente_email) continue
    if (b.notif_email_ativo === false) continue
    if (b.notif_boleto_vencido === false) continue

    const result = await notify({
      app,
      tenantId: b.tenant_id,
      to: b.cliente_email,
      template: 'boleto_vencido',
      refId: b.id,
      settings: {
        notif_email_ativo: b.notif_email_ativo,
        notif_boleto_vencido: b.notif_boleto_vencido,
      },
      settingsKey: 'notif_boleto_vencido',
      // dedupe na query SQL é mais robusto que o helper, mas mantemos por segurança
      dedupe: true,
      vars: {
        cliente_nome: b.cliente_nome,
        valor: Number(b.valor ?? 0),
        vencimento: b.vencimento,
        descricao: b.tipo ?? 'Royalties',
        url: b.gateway_url,
      },
    })
    if (result.ok) enviados++
    else if (!result.skipped) erros++
  }

  if (rows.length > 0) {
    app.log.info({ candidatos: rows.length, enviados, erros }, '[notify_boletos_vencidos] ciclo concluído')
  }
  return { candidatos: rows.length, enviados, erros }
}
