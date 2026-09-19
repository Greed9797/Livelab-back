# src/lib/errors.js

- AppError · class · L12-L20 — class AppError extends Error
- constructor · method · L13-L19 — constructor(message, { statusCode = 500, sentryTag = 'app_error', reportable = false } = {})
- ValidationError · class · L22-L27 — class ValidationError extends AppError
- constructor · method · L23-L26 — constructor(message = 'Dados inválidos', details = null)
- AuthError · class · L29-L33 — class AuthError extends AppError
- constructor · method · L30-L32 — constructor(message = 'Não autenticado')
- RBACError · class · L35-L39 — class RBACError extends AppError
- constructor · method · L36-L38 — constructor(message = 'Acesso não autorizado')
- RateLimitError · class · L41-L45 — class RateLimitError extends AppError
- constructor · method · L42-L44 — constructor(message = 'Muitas requisições. Tente novamente em breve.')
- WebhookReplayError · class · L47-L52 — class WebhookReplayError extends AppError
- constructor · method · L48-L51 — constructor(message = 'Webhook replay detectado')
