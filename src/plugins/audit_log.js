// Plugin de audit log — registra ações críticas em tabela `audit_log`.
// Uso: `await app.audit.log(request, { action, entity_type, entity_id, metadata })`
//
// PII redacted automaticamente em metadata via beforeWrite.

import fp from 'fastify-plugin'

const SENSITIVE_KEYS = /^(senha|password|token|authorization|secret|api.?key|cpf|cnpj|cvv|cartao|card|credit)$/i

function scrub(obj, depth = 0) {
  if (obj == null || depth > 4) return obj
  if (Array.isArray(obj)) return obj.map((v) => scrub(v, depth + 1))
  if (typeof obj !== 'object') return obj
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE_KEYS.test(k) ? '[redacted]' : scrub(v, depth + 1)
  }
  return out
}

async function auditLogPlugin(app) {
  app.decorate('audit', {
    /**
     * Registra ação no audit_log.
     * @param {FastifyRequest} request — para extrair user_id, tenant_id, ip, ua
     * @param {{action: string, entity_type?: string, entity_id?: string, metadata?: object}} info
     */
    async log(request, info) {
      try {
        const tenantId = request.user?.tenant_id ?? null
        const userId = request.user?.sub ?? null
        const ip =
          request.headers['x-forwarded-for']?.split(',')[0]?.trim() ??
          request.socket?.remoteAddress ??
          null
        const ua = request.headers['user-agent']?.slice(0, 500) ?? null

        const metadata = scrub(info.metadata ?? {})

        await app.db.query(
          `INSERT INTO audit_log
             (tenant_id, user_id, action, entity_type, entity_id, metadata, ip, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
          [
            tenantId,
            userId,
            info.action,
            info.entity_type ?? null,
            info.entity_id ?? null,
            JSON.stringify(metadata),
            ip,
            ua,
          ],
        )
      } catch (err) {
        // Audit log nunca pode quebrar fluxo da request.
        // Loga + continua.
        request.log.warn({ err, info }, '[audit] log falhou — request prossegue')
      }
    },
  })
}

export default fp(auditLogPlugin, { name: 'audit-log' })
export { auditLogPlugin }
