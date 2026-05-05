// Constantes centralizadas de política de segurança.
// S-05: evita inconsistência de bcrypt rounds e password strength entre arquivos.

export const SECURITY = {
  BCRYPT_ROUNDS: 12,
  PASSWORD_MIN_LENGTH: 8,
  // Pelo menos 1 letra (maiúscula ou minúscula) + 1 número, mínimo 8 chars.
  // Mais permissivo que regex completa pra não bloquear senhas legítimas em pt-BR.
  PASSWORD_REGEX: /^(?=.*[A-Za-z])(?=.*\d).{8,}$/,
  PASSWORD_HINT: 'Mínimo 8 caracteres, com letra e número.',
}
