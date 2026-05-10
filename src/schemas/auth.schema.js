import { z } from 'zod'

export const loginSchema = z.object({
  email: z.string().email('Email inválido'),
  senha: z.string().min(8, 'Senha mínima 8 caracteres'),
})

export const refreshSchema = z.object({
  refresh_token: z.string().min(1, 'Refresh token obrigatório'),
})

// F4: recuperação de senha + convite.
export const esqueciSenhaSchema = z.object({
  email: z.string().email('Email inválido'),
})

export const redefinirSenhaSchema = z.object({
  token: z.string().min(32, 'Token inválido'),
  nova_senha: z.string().min(8, 'Senha mínima 8 caracteres'),
})

export const aceitarConviteSchema = z.object({
  token: z.string().min(32, 'Token inválido'),
  nova_senha: z.string().min(8, 'Senha mínima 8 caracteres'),
})
