// Custom error classes — usadas para distinguir tipos no setErrorHandler
// e enriquecer Sentry com tags específicas (sem capturar 4xx esperados).
//
// Cada classe carrega:
//   - statusCode: HTTP a ser respondido
//   - sentryTag: string usada como `scope.setTag('error_class', ...)` em Sentry
//   - reportable: se true, captureException é chamado mesmo em status < 500
//
// Filosofia: ValidationError/AuthError/RBACError/RateLimitError NÃO sobem pra
// Sentry (são esperados em produção); WebhookReplayError SOBE (indica ataque).

export class AppError extends Error {
  constructor(message, { statusCode = 500, sentryTag = 'app_error', reportable = false } = {}) {
    super(message)
    this.name = this.constructor.name
    this.statusCode = statusCode
    this.sentryTag = sentryTag
    this.reportable = reportable
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Dados inválidos', details = null) {
    super(message, { statusCode: 400, sentryTag: 'validation', reportable: false })
    this.details = details
  }
}

export class AuthError extends AppError {
  constructor(message = 'Não autenticado') {
    super(message, { statusCode: 401, sentryTag: 'auth', reportable: false })
  }
}

export class RBACError extends AppError {
  constructor(message = 'Acesso não autorizado') {
    super(message, { statusCode: 403, sentryTag: 'rbac', reportable: false })
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Muitas requisições. Tente novamente em breve.') {
    super(message, { statusCode: 429, sentryTag: 'rate_limit', reportable: false })
  }
}

export class WebhookReplayError extends AppError {
  constructor(message = 'Webhook replay detectado') {
    // 409 + reportable=true porque indica ou bug ou ataque — sempre vai pra Sentry
    super(message, { statusCode: 409, sentryTag: 'webhook_replay', reportable: true })
  }
}

// Códigos de erro de negócio padronizados
// Uso: throw new AppError('Mensagem', { statusCode: 409, code: BizError.CABINE_JA_AO_VIVO })
export const BizError = {
  // Cabines
  CABINE_NAO_ENCONTRADA: 'CABINE_NAO_ENCONTRADA',
  CABINE_EM_MANUTENCAO: 'CABINE_EM_MANUTENCAO',
  CABINE_JA_AO_VIVO: 'CABINE_JA_AO_VIVO',
  CABINE_INDISPONIVEL: 'CABINE_INDISPONIVEL',
  AGENDA_CONFLITO: 'AGENDA_CONFLITO',

  // Lives
  LIVE_SEM_APRESENTADOR: 'LIVE_SEM_APRESENTADOR',
  LIVE_SEM_CABINE: 'LIVE_SEM_CABINE',
  CLIENTE_REQUIRED: 'CLIENTE_REQUIRED',
  NO_APPROVED_REQUEST: 'NO_APPROVED_REQUEST',
  LIVE_JA_ENCERRADA: 'LIVE_JA_ENCERRADA',

  // Clientes / Contratos
  CLIENTE_INADIMPLENTE: 'CLIENTE_INADIMPLENTE',
  CONTRATO_INATIVO: 'CONTRATO_INATIVO',
  CLIENTE_NAO_ENCONTRADO: 'CLIENTE_NAO_ENCONTRADO',

  // Tenants / Auth
  TENANT_FORBIDDEN: 'TENANT_FORBIDDEN',
  DADOS_RASCUNHO: 'DADOS_RASCUNHO',
  PERMISSAO_NEGADA: 'PERMISSAO_NEGADA',
}
