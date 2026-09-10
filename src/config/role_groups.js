// Grupos de papéis por domínio — fonte da verdade pra requirePapel.
// Inclui os 6 papéis novos da migration 064 (Tier 1+2+3).
// gerente_regional (Tier 4) entra na Fase C separada.
//
// Convenção:
//   READ_X  = quem pode GET no domínio X
//   WRITE_X = quem pode POST/PATCH/DELETE no domínio X
//
// Master + franqueado + gerente sempre têm acesso a todos domínios da
// unidade (papel administrativo padrão). Papéis novos abrem APENAS o que
// a matriz aprovada permite.

// ─── Papéis administrativos base ─────────────────────────────────────
const ADMIN = ['franqueador_master', 'franqueado', 'gerente']

// Papel das chaves de API (migration 138). Não pertence a ninguém na tabela
// `users`: vive na coluna `papel` de `api_keys` e chega ao request pelo plugin
// de auth. Entra só em lives, marcas, apresentadoras e nas leituras
// correspondentes — nunca em financeiro, usuários ou configurações.
const AUTOMACAO = 'automacao'
const ADMIN_COMERCIAL = [...ADMIN, 'gerente_comercial']

// ─── FINANCEIRO ──────────────────────────────────────────────────────
export const READ_FINANCEIRO = [...ADMIN, 'financeiro', 'financeiro_readonly', 'auditor']
export const WRITE_FINANCEIRO = [...ADMIN, 'financeiro']

// ─── BOLETOS ─────────────────────────────────────────────────────────
export const READ_BOLETOS = [
  ...ADMIN,
  'financeiro', 'financeiro_readonly', 'auditor', 'suporte',
]
export const WRITE_BOLETOS = [...ADMIN, 'financeiro']

// ─── CONTRATOS ───────────────────────────────────────────────────────
export const READ_CONTRATOS = [
  ...ADMIN, 'auditor', 'financeiro_readonly', 'comercial_readonly',
]
export const WRITE_CONTRATOS = [...ADMIN]

// ─── CLIENTES ────────────────────────────────────────────────────────
export const READ_CLIENTES = [
  ...ADMIN_COMERCIAL,
  'operacional', 'auditor', 'suporte', 'produtor_live', 'marketing', 'comercial_readonly',
]
export const WRITE_CLIENTES = [...ADMIN_COMERCIAL]

// ─── LEADS / CRM ─────────────────────────────────────────────────────
export const READ_LEADS = [
  ...ADMIN_COMERCIAL,
  'auditor', 'suporte', 'marketing', 'comercial_readonly',
]
export const WRITE_LEADS = [...ADMIN_COMERCIAL, 'marketing']

// ─── CABINES / OPERAÇÃO ──────────────────────────────────────────────
// A automação entra aqui porque a listagem e o detalhe de LIVES são guardados
// por READ_CABINES, não por READ_LIVES (ver cabineRoleAccess em
// routes/lives.js). Sem isso a chave levava 403 na leitura que a própria rota de
// importação promete. Isso não abre /v1/cabines para ela: a allowlist do plugin
// de auth não tem esse caminho, e allowlist e papel precisam concordar.
export const READ_CABINES = [
  ...ADMIN, 'operacional', 'apresentador', 'apresentadora',
  'auditor', 'suporte', 'produtor_live', 'marketing', 'comercial_readonly',
  AUTOMACAO,
]
export const WRITE_CABINES = [...ADMIN, 'operacional', 'produtor_live']

// ─── LIVES ───────────────────────────────────────────────────────────
export const READ_LIVES = [
  ...ADMIN, 'operacional', 'apresentador', 'apresentadora',
  'auditor', 'suporte', 'produtor_live', 'marketing', 'comercial_readonly',
  AUTOMACAO,
]
export const WRITE_LIVES = [
  ...ADMIN, 'operacional', 'apresentador', 'apresentadora', 'produtor_live', AUTOMACAO,
]

// ─── APRESENTADORAS ──────────────────────────────────────────────────
export const READ_APRESENTADORAS = [
  ...ADMIN, 'operacional',
  'auditor', 'suporte', 'produtor_live', 'marketing', 'comercial_readonly',
  AUTOMACAO,
]
export const WRITE_APRESENTADORAS = [...ADMIN, 'operacional', 'produtor_live', AUTOMACAO]

// ─── SOLICITAÇÕES (reservas de cabine pelo cliente) ──────────────────
export const READ_SOLICITACOES = [
  ...ADMIN, 'auditor', 'suporte', 'produtor_live', 'comercial_readonly',
]
export const WRITE_SOLICITACOES = [...ADMIN, 'produtor_live']

// ─── ANALYTICS ───────────────────────────────────────────────────────
export const READ_ANALYTICS = [
  ...ADMIN,
  'auditor', 'financeiro_readonly', 'suporte', 'produtor_live',
  'marketing', 'comercial_readonly',
  AUTOMACAO,
]

// ─── CONTEÚDO / MARCAS / AGENDA / VÍDEOS ─────────────────────────────
// Marcas herdavam CLIENTES inteiro. A automação precisa cadastrar marca sem
// enxergar a carteira de clientes, então os dois deixam de ser o mesmo array:
// quem lia cliente continua lendo marca, e só a chave entra a mais.
export const READ_MARCAS = [...READ_CLIENTES, AUTOMACAO]
export const WRITE_MARCAS = [...WRITE_CLIENTES, AUTOMACAO]

export const READ_AGENDA = [
  ...ADMIN, 'operacional', 'apresentador', 'apresentadora',
  'auditor', 'suporte', 'produtor_live', 'marketing', 'comercial_readonly',
]
export const WRITE_AGENDA = [...ADMIN, 'operacional', 'produtor_live']

export const READ_VIDEOS = READ_AGENDA
export const WRITE_VIDEOS = WRITE_AGENDA

export const READ_VENDAS_ATRIBUIDAS = [
  ...ADMIN,
  'financeiro', 'financeiro_readonly', 'auditor', 'suporte',
  'produtor_live', 'marketing', 'comercial_readonly',
]
export const WRITE_VENDAS_ATRIBUIDAS = [
  ...ADMIN, 'financeiro', 'produtor_live',
]

export const READ_COMISSOES = [
  ...ADMIN, 'financeiro', 'financeiro_readonly',
  'auditor', 'produtor_live', 'marketing', 'comercial_readonly',
  AUTOMACAO,
]

// ─── CONFIGURAÇÕES / USUÁRIOS ────────────────────────────────────────
export const READ_CONFIGURACOES = [...ADMIN, 'auditor']
export const WRITE_CONFIGURACOES = [...ADMIN]
export const READ_USUARIOS = [...ADMIN, 'auditor']
export const WRITE_USUARIOS = ['franqueador_master', 'franqueado']

// ─── AUDIT LOG ───────────────────────────────────────────────────────
export const READ_AUDIT_LOG = ['franqueador_master', 'franqueado', 'auditor']

// ─── CLIENTE_NOTAS (novo, Fase B inclui) ─────────────────────────────
export const READ_CLIENTE_NOTAS = READ_CLIENTES
export const WRITE_CLIENTE_NOTAS = [
  ...ADMIN_COMERCIAL, 'suporte', 'marketing',
]
