// Service Mailer — envio de e-mails transacionais via Resend.
// Doc: https://resend.com/docs
//
// Env vars necessárias:
//   RESEND_API_KEY  — chave secreta do Resend (re_xxx)
//   EMAIL_FROM      — remetente padrão (ex: noreply@grupolivelab.com.br)
//
// Comportamento:
//   - Se RESEND_API_KEY ausente: log warning e no-op (NÃO lança).
//     Garante que hooks fire-and-forget não quebrem a app em dev sem config.
//   - Sempre grava em notification_log (sucesso ou erro), inclusive no skip.
//   - Idempotência: callers devem checar notification_log via hasSent() antes
//     de enviar duplicata pra mesmo (tipo, ref_id).

import { Resend } from 'resend'
import * as Sentry from '@sentry/node'

let _resendClient = null

// Mascara PII (email) pra breadcrumb: a***@b.com
function _maskEmail(email) {
  if (!email || typeof email !== 'string') return null
  const [user, domain] = email.split('@')
  if (!domain) return '***'
  const head = user.slice(0, 1)
  return `${head}***@${domain}`
}

function _emailBreadcrumb(level, template, to, extra = {}) {
  if (!process.env.SENTRY_DSN) return
  try {
    Sentry.addBreadcrumb({
      category: 'email',
      message: level === 'error' ? 'email.failed' : 'email.sent',
      level: level === 'error' ? 'error' : 'info',
      data: { template, to_masked: _maskEmail(to), ...extra },
    })
  } catch {
    // breadcrumb nunca pode quebrar fluxo
  }
}

function _client() {
  if (!process.env.RESEND_API_KEY) return null
  if (!_resendClient) _resendClient = new Resend(process.env.RESEND_API_KEY)
  return _resendClient
}

function _from() {
  return process.env.EMAIL_FROM ?? 'noreply@grupolivelab.com.br'
}

/**
 * Loga uma tentativa de notificação (sucesso ou erro) usando pool com tenant_id setado.
 * Cai silenciosamente se a tabela ainda não existe (env sem migration).
 */
async function _logNotification(pool, { tenantId, tipo, refId, destinatario, assunto, enviadoEm, erro }) {
  if (!pool || !tenantId) return
  let client
  try {
    client = await pool.connect()
    await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId])
    await client.query(
      `INSERT INTO notification_log (tenant_id, tipo, ref_id, destinatario, assunto, enviado_em, erro)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, tipo, refId ?? null, destinatario, assunto ?? null, enviadoEm ?? null, erro ?? null]
    )
  } catch (err) {
    // Não propaga — log de notificação não pode quebrar fluxo principal.
    // eslint-disable-next-line no-console
    console.warn('[mailer] falha ao gravar notification_log:', err.message)
  } finally {
    if (client) client.release()
  }
}

/**
 * Verifica se já existe notificação enviada com sucesso para (tenant, tipo, refId).
 * Usado pra idempotência em jobs (ex: boleto vencido só notifica 1x).
 */
export async function hasSent(pool, { tenantId, tipo, refId }) {
  if (!pool || !tenantId || !tipo || !refId) return false
  let client
  try {
    client = await pool.connect()
    await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId])
    const { rows } = await client.query(
      `SELECT 1 FROM notification_log
       WHERE tenant_id = $1 AND tipo = $2 AND ref_id = $3 AND enviado_em IS NOT NULL
       LIMIT 1`,
      [tenantId, tipo, refId]
    )
    return rows.length > 0
  } catch {
    return false
  } finally {
    if (client) client.release()
  }
}

/**
 * Envia e-mail via Resend. Sempre grava notification_log.
 * @param {Object} params
 * @param {string} params.to            — destinatário
 * @param {string} params.subject       — assunto
 * @param {string} params.html          — corpo HTML
 * @param {string} params.tenantId      — tenant pra RLS no log
 * @param {string} params.tipo          — chave do template (ex: 'live_encerrada')
 * @param {string=} params.refId        — id da entidade relacionada (live, boleto, contrato)
 * @param {Object=} params.pool         — pg.Pool pra gravar log (default app.db.pool quando chamado via app)
 * @returns {Promise<{ok: boolean, skipped?: boolean, id?: string, error?: string}>}
 */
export async function sendEmail({ to, subject, html, tenantId, tipo, refId, pool }) {
  if (!to || !subject || !html) {
    return { ok: false, error: 'parâmetros obrigatórios faltando (to/subject/html)' }
  }

  const client = _client()

  // Sem RESEND_API_KEY: degrada silenciosamente.
  if (!client) {
    // eslint-disable-next-line no-console
    console.warn(`[mailer] RESEND_API_KEY ausente, skip envio tipo=${tipo} para=${to}`)
    await _logNotification(pool, {
      tenantId, tipo, refId, destinatario: to, assunto: subject,
      enviadoEm: null, erro: 'skipped: RESEND_API_KEY ausente',
    })
    return { ok: false, skipped: true }
  }

  try {
    const result = await client.emails.send({
      from: _from(),
      to: [to],
      subject,
      html,
    })

    if (result?.error) {
      const errMsg = String(result.error?.message ?? result.error)
      await _logNotification(pool, {
        tenantId, tipo, refId, destinatario: to, assunto: subject,
        enviadoEm: null, erro: errMsg,
      })
      _emailBreadcrumb('error', tipo, to, { reason: 'provider_error' })
      return { ok: false, error: errMsg }
    }

    await _logNotification(pool, {
      tenantId, tipo, refId, destinatario: to, assunto: subject,
      enviadoEm: new Date(), erro: null,
    })
    _emailBreadcrumb('info', tipo, to)
    return { ok: true, id: result?.data?.id }
  } catch (err) {
    const errMsg = err?.message ?? String(err)
    await _logNotification(pool, {
      tenantId, tipo, refId, destinatario: to, assunto: subject,
      enviadoEm: null, erro: errMsg,
    })
    _emailBreadcrumb('error', tipo, to, { reason: 'exception' })
    return { ok: false, error: errMsg }
  }
}

// ────────────────────── Templates ──────────────────────
// Cada template recebe vars e retorna { subject, html }.
// HTML simples com inline CSS (compat Gmail/Outlook). Sem dep externa.

const _baseStyle = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #f5f5f5;
  color: #1a1a1a;
  line-height: 1.5;
  padding: 24px;
`

const _cardStyle = `
  background: #ffffff;
  border-radius: 8px;
  padding: 24px;
  max-width: 560px;
  margin: 0 auto;
  border: 1px solid #e5e5e5;
`

const _btnStyle = `
  display: inline-block;
  background: #E8673C;
  color: #ffffff !important;
  padding: 12px 24px;
  text-decoration: none;
  border-radius: 6px;
  font-weight: 600;
`

function _wrap(title, bodyHtml) {
  return `<!doctype html>
<html><body style="margin:0;${_baseStyle}">
  <div style="${_cardStyle}">
    <h2 style="margin:0 0 16px;color:#E8673C;font-size:20px;">${title}</h2>
    ${bodyHtml}
    <hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0;">
    <p style="font-size:12px;color:#777;margin:0;">
      LiveShop SaaS — Grupo LiveLab<br>
      Esta é uma notificação automática.
    </p>
  </div>
</body></html>`
}

function _money(v) {
  const n = Number(v ?? 0)
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function _fmtDate(d) {
  if (!d) return '—'
  const dt = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(dt.getTime())) return '—'
  return dt.toLocaleDateString('pt-BR')
}

const _templates = {
  live_encerrada: (vars) => ({
    subject: `Live encerrada — ${_money(vars.gmv)} em vendas`,
    html: _wrap('Live encerrada com sucesso', `
      <p>Olá,</p>
      <p>Uma live foi encerrada agora. Veja o resumo:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>GMV total</b></td>
            <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${_money(vars.gmv)}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Pedidos</b></td>
            <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${vars.qtd_pedidos ?? 0}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Viewers</b></td>
            <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${vars.viewers ?? 0}</td></tr>
        <tr><td style="padding:8px;"><b>Duração</b></td>
            <td style="padding:8px;text-align:right;">${vars.duracao ?? '—'}</td></tr>
      </table>
      <p>Acesse o painel para mais detalhes.</p>
    `),
  }),

  boleto_vencido: (vars) => ({
    subject: `Boleto vencido — ${_money(vars.valor)}`,
    html: _wrap('Boleto em atraso', `
      <p>Olá <b>${vars.cliente_nome ?? 'Cliente'}</b>,</p>
      <p>Identificamos que um boleto está em atraso:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Valor</b></td>
            <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${_money(vars.valor)}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Vencimento</b></td>
            <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${_fmtDate(vars.vencimento)}</td></tr>
        <tr><td style="padding:8px;"><b>Descrição</b></td>
            <td style="padding:8px;text-align:right;">${vars.descricao ?? '—'}</td></tr>
      </table>
      ${vars.url ? `<p style="text-align:center;margin:24px 0;">
        <a href="${vars.url}" style="${_btnStyle}">Pagar boleto</a></p>` : ''}
      <p>Para evitar bloqueio dos serviços, regularize o pagamento o quanto antes.</p>
    `),
  }),

  contrato_aprovado: (vars) => ({
    subject: `Contrato aprovado — ${vars.cliente_nome ?? ''}`,
    html: _wrap('Contrato aprovado', `
      <p>Olá,</p>
      <p>O contrato do cliente <b>${vars.cliente_nome ?? '—'}</b> foi <b style="color:#10b981;">APROVADO</b>.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Score</b></td>
            <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${vars.score ?? '—'}</td></tr>
        <tr><td style="padding:8px;"><b>Risco</b></td>
            <td style="padding:8px;text-align:right;">${vars.risco ?? '—'}</td></tr>
      </table>
      <p>O contrato já está ativo no sistema.</p>
    `),
  }),

  contrato_reprovado: (vars) => ({
    subject: `Contrato reprovado — ${vars.cliente_nome ?? ''}`,
    html: _wrap('Contrato reprovado', `
      <p>Olá,</p>
      <p>O contrato do cliente <b>${vars.cliente_nome ?? '—'}</b> foi <b style="color:#ef4444;">REPROVADO</b>.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Score</b></td>
            <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${vars.score ?? '—'}</td></tr>
        <tr><td style="padding:8px;"><b>Risco</b></td>
            <td style="padding:8px;text-align:right;">${vars.risco ?? '—'}</td></tr>
        ${vars.motivo ? `<tr><td style="padding:8px;"><b>Motivo</b></td>
            <td style="padding:8px;text-align:right;">${vars.motivo}</td></tr>` : ''}
      </table>
      <p>O processo pode ser revisado pelo backoffice ou via "Assumir risco".</p>
    `),
  }),

  boleto_pago: (vars) => ({
    subject: `Pagamento confirmado — ${_money(vars.valor)} recebido`,
    html: _wrap('Pagamento confirmado', `
      <p>Olá <b>${vars.cliente_nome ?? 'Cliente'}</b>,</p>
      <p>Confirmamos o recebimento do seu pagamento. Veja os detalhes:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Valor pago</b></td>
            <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;color:#10b981;font-weight:600;">${_money(vars.valor)}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Vencimento</b></td>
            <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${_fmtDate(vars.vencimento)}</td></tr>
        <tr><td style="padding:8px;"><b>Data do pagamento</b></td>
            <td style="padding:8px;text-align:right;">${_fmtDate(vars.pago_em)}</td></tr>
      </table>
      <p>Obrigado pelo pagamento. Seus serviços continuam ativos.</p>
    `),
  }),

  recuperacao_senha: (vars) => ({
    subject: 'Redefinir sua senha — LiveShop',
    html: _wrap('Redefinir sua senha', `
      <p>Olá ${vars.nome ? `<b>${vars.nome}</b>` : ''},</p>
      <p>Recebemos uma solicitação para redefinir a senha da sua conta no LiveShop.
         Se foi você, clique no botão abaixo para criar uma nova senha:</p>
      <p style="text-align:center;margin:24px 0;">
        <a href="${vars.link}" style="${_btnStyle}">Redefinir senha</a>
      </p>
      <p style="font-size:12.5px;color:#555;">
        Este link expira em <b>1 hora</b> e só pode ser usado uma vez.
      </p>
      <p style="font-size:12.5px;color:#555;">
        Se você não solicitou essa redefinição, ignore este e-mail —
        sua senha continua a mesma.
      </p>
      <p style="font-size:11px;color:#888;word-break:break-all;margin-top:18px;">
        Caso o botão não funcione, copie e cole no navegador:<br>
        ${vars.link}
      </p>
    `),
  }),

  convite_usuario: (vars) => ({
    subject: `Você foi convidado para ${vars.tenant_nome ?? 'LiveShop'}`,
    html: _wrap('Bem-vindo ao LiveShop', `
      <p>Olá <b>${vars.nome ?? ''}</b>,</p>
      <p>Você foi convidado para acessar a plataforma
         <b>${vars.tenant_nome ?? 'LiveShop'}</b> com o papel
         <b>${vars.papel_label ?? '—'}</b>.</p>
      <p>Para começar, defina sua senha de acesso clicando no botão abaixo:</p>
      <p style="text-align:center;margin:24px 0;">
        <a href="${vars.link}" style="${_btnStyle}">Definir minha senha</a>
      </p>
      <p style="font-size:12.5px;color:#555;">
        Este convite expira em <b>72 horas</b>.
        Se expirar, peça um novo ao administrador da sua unidade.
      </p>
      <p style="font-size:11px;color:#888;word-break:break-all;margin-top:18px;">
        Caso o botão não funcione, copie e cole no navegador:<br>
        ${vars.link}
      </p>
    `),
  }),

  lead_novo_inbound: (vars) => ({
    subject: `Novo lead recebido — ${vars.nome ?? ''}`,
    html: _wrap('Novo lead inbound', `
      <p>Olá,</p>
      <p>Um novo lead chegou via formulário público:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Nome</b></td>
            <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${vars.nome ?? '—'}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>Cidade</b></td>
            <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${vars.cidade ?? '—'}/${vars.estado ?? '—'}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>E-mail</b></td>
            <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${vars.email ?? '—'}</td></tr>
        <tr><td style="padding:8px;border-bottom:1px solid #eee;"><b>WhatsApp</b></td>
            <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${vars.whatsapp ?? '—'}</td></tr>
        <tr><td style="padding:8px;"><b>Origem</b></td>
            <td style="padding:8px;text-align:right;">${vars.origem ?? 'inbound'}</td></tr>
      </table>
      <p>Acesse o CRM para iniciar o atendimento.</p>
    `),
  }),
}

/**
 * Renderiza template e retorna { subject, html }.
 * @param {string} name — chave em _templates
 * @param {Object} vars — variáveis do template
 */
export function renderTemplate(name, vars = {}) {
  const tpl = _templates[name]
  if (!tpl) throw new Error(`[mailer] template desconhecido: ${name}`)
  return tpl(vars)
}

/**
 * Helper de alto nível: renderiza template + envia.
 * Checa flag de notificação do tenant antes (se settings vier).
 *
 * @param {Object} args
 * @param {Object} args.app             — instância Fastify (pra app.db.pool e app.log)
 * @param {string} args.tenantId
 * @param {string} args.to
 * @param {string} args.template        — nome do template
 * @param {Object} args.vars
 * @param {string=} args.refId
 * @param {Object=} args.settings       — flags do tenant ({notif_email_ativo, notif_<x>})
 * @param {string=} args.settingsKey    — chave da flag específica (ex: 'notif_live_meta')
 * @param {boolean=} args.dedupe        — se true, checa hasSent antes
 */
export async function notify(args) {
  const { app, tenantId, to, template, vars = {}, refId, settings, settingsKey, dedupe } = args
  if (!to) {
    app?.log?.warn?.({ template, tenantId }, '[mailer] notify chamado sem destinatário')
    return { ok: false, skipped: true, error: 'sem destinatário' }
  }

  // Respeita flags do tenant.
  if (settings) {
    if (settings.notif_email_ativo === false) {
      return { ok: false, skipped: true, error: 'notif_email_ativo=false' }
    }
    if (settingsKey && settings[settingsKey] === false) {
      return { ok: false, skipped: true, error: `${settingsKey}=false` }
    }
  }

  const pool = app?.db?.pool

  if (dedupe && refId) {
    const already = await hasSent(pool, { tenantId, tipo: template, refId })
    if (already) return { ok: false, skipped: true, error: 'já enviado (dedupe)' }
  }

  const { subject, html } = renderTemplate(template, vars)
  return sendEmail({ to, subject, html, tenantId, tipo: template, refId, pool })
}
