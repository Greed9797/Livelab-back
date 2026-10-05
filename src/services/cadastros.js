// Cadastro unificado (Marca + Cliente). A MARCA é a entidade; id público = marca_id.
// A ficha em `clientes` é o complemento comercial 1:1 opcional da marca tipo='cliente'.
//
// Nada aqui mexe em dinheiro: condições comerciais continuam em
// /v1/marcas/:id/condicoes (versionadas, com vigência e confirmação), e nenhum
// caminho toca receita_titulos. Ver migration 174 e docs/financeiro.md §1.
//
// Todas as queries filtram tenant_id explicitamente (o papel do Supabase tem
// bypass de RLS — ADR 0003).
import { z } from 'zod'
import { ensureClienteMarca } from './client-brand.js'
import { cadastroColsSql, cadastroFromSql, cadastroMetricasMesJoinSql, cadastroStatusSql, CAMPOS_FICHA_SENSIVEIS } from '../lib/cadastro-sql.js'
import { buildConfiguracaoComercial, MARCA_NOME_DUPLICADA } from '../routes/marcas.js'
import { CLIENTE_STATUS_VIVOS } from '../routes/clientes.js'
import { tiktokUsernameField, updateCanonicalTikTokUsername } from '../lib/tiktok-username.js'
import { resolveMonthRange } from '../lib/operacional.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/
export const TIPOS_CADASTRO = ['cliente', 'afiliada', 'propria', 'parceira']
const STATUS_MARCA = ['ativa', 'inativa', 'pausada', 'arquivada']
const CAMPOS_FINANCEIROS = ['comissao_franquia_pct', 'comissao_franqueadora_pct', 'valor_fixo_minimo', 'tipo_cobranca']
// Campos que só existem na ficha (clientes). Em marca sem ficha → 400.
const CAMPOS_FICHA = ['celular', 'email', 'cpf', 'cnpj', 'razao_social', 'nicho', 'fat_anual', 'cidade', 'estado', 'cep', 'vende_tiktok']
// Campos que só existem na marca.
const CAMPOS_MARCA = ['marketplace_url', 'cor', 'data_inicio', 'data_fim', 'observacoes']

export class CadastroError extends Error {
  constructor(statusCode, code, message, extra = {}) {
    super(message)
    this.statusCode = statusCode
    this.code = code
    Object.assign(this, extra)
  }
}

const dataField = z.string().regex(DATA_RE, 'data deve ser YYYY-MM-DD').nullable().optional()
const textoOpcional = z.string().nullable().optional()

const camposComuns = {
  tiktok_username: tiktokUsernameField,
  site: textoOpcional,
  marketplace_url: textoOpcional,
  logo_url: z.string().max(100 * 1024, 'Imagem muito grande. Máximo 100 KB.')
    .regex(/^(https?:\/\/|\/|data:image\/(png|jpeg|webp|gif);base64,)/, 'Logo inválida.')
    .nullable().optional(),
  cor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'cor deve ser hex #rrggbb').nullable().optional(),
  data_inicio: dataField,
  data_fim: dataField,
  observacoes: textoOpcional,
}

const camposFicha = {
  celular: z.string().optional(),
  email: z.string().optional(),
  cpf: z.string().optional(),
  cnpj: z.string().optional(),
  razao_social: z.string().optional(),
  nicho: z.string().optional(),
  fat_anual: z.number().optional(),
  cidade: z.string().optional(),
  estado: z.string().optional(),
  cep: z.string().optional(),
  vende_tiktok: z.boolean().optional(),
}

export const criarCadastroSchema = z.object({
  nome: z.string().trim().min(1, 'nome é obrigatório'),
  tipo: z.enum(TIPOS_CADASTRO).default('cliente'),
  status: z.enum(STATUS_MARCA).optional(),
  ...camposComuns,
  ...camposFicha,
}).refine((d) => d.tipo !== 'cliente' || Boolean(d.celular && d.celular.trim()), {
  message: 'celular é obrigatório para cadastro tipo cliente',
})

export const atualizarCadastroSchema = z.object({
  nome: z.string().trim().min(1).optional(),
  status: z.enum(STATUS_MARCA).optional(),
  status_comercial: z.enum([...CLIENTE_STATUS_VIVOS, 'ganho']).optional(),
  ...camposComuns,
  ...camposFicha,
})

export const promoverSchema = z.object({
  cliente_id: z.string().uuid().optional(),
  celular: z.string().optional(),
  email: z.string().optional(),
  cnpj: z.string().optional(),
  razao_social: z.string().optional(),
  data_inicio: z.string().regex(DATA_RE, 'data deve ser YYYY-MM-DD').optional(),
  confirmar_retroativo: z.boolean().optional(),
})

function camposFinanceiros(body) {
  return Object.keys(body ?? {}).filter((k) => CAMPOS_FINANCEIROS.includes(k))
}

function rejeitarFinanceiro(body) {
  const campos = camposFinanceiros(body)
  if (campos.length > 0) {
    throw new CadastroError(409, 'USE_MARCA_CONDITION_ENDPOINT',
      'Alterações financeiras exigem uma nova condição comercial com vigência e confirmação (/v1/marcas/:id/condicoes)',
      { campos })
  }
}

const num = (v) => (v == null ? 0 : Number(v))

/** Linha do banco → contrato público do cadastro. */
export function mapCadastroRow(row, { ocultarFicha = false } = {}) {
  if (!row) return null
  const {
    comercial_condicao_id, comercial_fixo_mensal, comercial_comissao_franquia_pct,
    comercial_tipo_cobranca, comercial_fixo_confirmado, comercial_comissao_confirmada,
    comercial_origem, gmv_mes, lives_mes, videos_mes, ...rest
  } = row
  const out = {
    ...rest,
    gmv_mes: num(gmv_mes),
    lives_mes: num(lives_mes),
    videos_mes: num(videos_mes),
    configuracao_comercial: buildConfiguracaoComercial({
      tipo: row.tipo,
      condicao: comercial_condicao_id ? {
        fixo_mensal: comercial_fixo_mensal,
        comissao_franquia_pct: comercial_comissao_franquia_pct,
        tipo_cobranca: comercial_tipo_cobranca,
        fixo_confirmado: comercial_fixo_confirmado,
        comissao_confirmada: comercial_comissao_confirmada,
        origem: comercial_origem,
      } : null,
    }),
  }
  // A chave de API (bot de lives) lê o cadastro para casar marca, mas não enxerga
  // a carteira de clientes (contato/faturamento) — mesma regra de READ_MARCAS.
  if (ocultarFicha) for (const campo of CAMPOS_FICHA_SENSIVEIS) out[campo] = null
  return out
}

/**
 * Aceita marca_id OU cliente_id (da ficha) e devolve o marca_id do cadastro.
 * Cliente → sua marca tipo='cliente' preferida (mesma ordem de ensureClienteMarca).
 */
export async function resolverCadastroId(db, { tenantId, id }) {
  if (!UUID_RE.test(String(id ?? ''))) return null
  const marca = await db.query(
    'SELECT id FROM marcas WHERE id = $1::uuid AND tenant_id = $2::uuid',
    [id, tenantId],
  )
  if (marca.rows[0]) return marca.rows[0].id
  const viaCliente = await db.query(
    `SELECT m.id
       FROM marcas m
       JOIN clientes c ON c.id = m.cliente_id AND c.tenant_id = m.tenant_id
      WHERE c.id = $1::uuid AND c.tenant_id = $2::uuid AND m.tenant_id = $2::uuid
        AND m.tipo = 'cliente'
      ORDER BY (m.status = 'ativa') DESC, m.atualizado_em DESC NULLS LAST, m.criado_em ASC
      LIMIT 1`,
    [id, tenantId],
  )
  return viaCliente.rows[0]?.id ?? null
}

export async function listarCadastros(db, {
  tenantId, tipo = null, status = null, q = null, geraReceita = null, incluirSistema = true, ocultarFicha = false,
} = {}) {
  const values = [tenantId]
  const filters = ['m.tenant_id = $1::uuid']
  const push = (v) => `$${values.push(v)}`
  if (status === 'all') {
    // sem filtro
  } else if (status) {
    filters.push(`${cadastroStatusSql()} = ${push(String(status))}`)
  } else {
    filters.push(`${cadastroStatusSql()} NOT IN ('inativa', 'arquivada')`)
  }
  if (tipo && tipo !== 'all') filters.push(`m.tipo = ${push(String(tipo))}`)
  if (q && String(q).trim()) {
    const p = push(`%${String(q).trim()}%`)
    filters.push(`(m.nome ILIKE ${p} OR c.nome ILIKE ${p} OR c.razao_social ILIKE ${p})`)
  }
  if (geraReceita === true) filters.push(`(m.tipo = 'cliente' AND COALESCE(m.sistema, false) = false)`)
  if (geraReceita === false) filters.push(`NOT (m.tipo = 'cliente' AND COALESCE(m.sistema, false) = false)`)
  if (!incluirSistema) filters.push('COALESCE(m.sistema, false) = false')

  const { startDate, endDate } = resolveMonthRange({})
  const s = push(startDate)
  const e = push(endDate)
  const result = await db.query(
    `SELECT ${cadastroColsSql()},
            COALESCE(mtr.gmv_mes, 0) AS gmv_mes,
            COALESCE(mtr.lives_mes, 0) AS lives_mes,
            COALESCE(mtr.videos_mes, 0) AS videos_mes
       ${cadastroFromSql('$1')}
       ${cadastroMetricasMesJoinSql('$1', s, e)}
      WHERE ${filters.join(' AND ')}
      ORDER BY ${cadastroStatusSql()} = 'ativa' DESC, (m.tipo = 'cliente') DESC, m.nome ASC`,
    values,
  )
  return result.rows.map((row) => mapCadastroRow(row, { ocultarFicha }))
}

export async function obterCadastro(db, { tenantId, id, ocultarFicha = false }) {
  const marcaId = await resolverCadastroId(db, { tenantId, id })
  if (!marcaId) return null
  const { startDate, endDate } = resolveMonthRange({})
  const result = await db.query(
    `SELECT ${cadastroColsSql()},
            COALESCE(mtr.gmv_mes, 0) AS gmv_mes,
            COALESCE(mtr.lives_mes, 0) AS lives_mes,
            COALESCE(mtr.videos_mes, 0) AS videos_mes
       ${cadastroFromSql('$1')}
       ${cadastroMetricasMesJoinSql('$1', '$3', '$4')}
      WHERE m.tenant_id = $1::uuid AND m.id = $2::uuid`,
    [tenantId, marcaId, startDate, endDate],
  )
  return mapCadastroRow(result.rows[0], { ocultarFicha })
}

async function nomeJaExiste(db, { tenantId, nome, ignoreId = null }) {
  const r = await db.query(
    `SELECT 1 FROM marcas
      WHERE tenant_id = $1::uuid AND lower(nome) = lower($2)
        AND ($3::uuid IS NULL OR id <> $3::uuid)
      LIMIT 1`,
    [tenantId, nome, ignoreId],
  )
  return Boolean(r.rows[0])
}

async function transacao(db, fn) {
  await db.query('BEGIN')
  try {
    const out = await fn()
    await db.query('COMMIT')
    return out
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    if (err?.code === '23505' && err?.constraint === 'uniq_marca_nome_por_tenant') {
      throw new CadastroError(409, 'MARCA_NOME_DUPLICADA', MARCA_NOME_DUPLICADA)
    }
    if (err?.code === '23505' && err?.constraint === 'uniq_marca_cliente_por_tenant') {
      throw new CadastroError(409, 'CLIENTE_JA_TEM_MARCA', 'Este cliente já possui um cadastro tipo cliente.')
    }
    throw err
  }
}

/**
 * Cria um cadastro. tipo='cliente' cria a ficha + a marca espelho (ensureClienteMarca,
 * ponto único de criação); os demais tipos criam só a marca (mesmo INSERT do
 * POST /v1/marcas, com a condição baseline legado_nao_verificado).
 */
export async function criarCadastro(db, { tenantId, dados, origem = 'manual' }) {
  rejeitarFinanceiro(dados)
  const parsed = criarCadastroSchema.safeParse(dados ?? {})
  if (!parsed.success) throw new CadastroError(400, 'CADASTRO_INVALIDO', parsed.error.issues[0].message)
  const d = parsed.data
  if (d.tipo !== 'cliente') {
    const fichaEnviada = CAMPOS_FICHA.filter((k) => d[k] !== undefined)
    if (fichaEnviada.length > 0) {
      throw new CadastroError(400, 'CAMPO_FICHA_SEM_CLIENTE',
        `Campos de ficha (${fichaEnviada.join(', ')}) só existem em cadastro tipo cliente.`, { campos: fichaEnviada })
    }
  }

  const marcaId = await transacao(db, async () => {
    if (await nomeJaExiste(db, { tenantId, nome: d.nome })) {
      throw new CadastroError(409, 'MARCA_NOME_DUPLICADA', MARCA_NOME_DUPLICADA)
    }
    if (d.tipo === 'cliente') {
      const cliente = await db.query(
        `INSERT INTO clientes (tenant_id, nome, celular, cpf, cnpj, razao_social, email,
           fat_anual, nicho, site, vende_tiktok, cep, cidade, estado, tiktok_username, logo_url, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'ativo')
         RETURNING id`,
        [tenantId, d.nome, d.celular, d.cpf ?? null, d.cnpj ?? null, d.razao_social ?? null, d.email ?? null,
          d.fat_anual ?? 0, d.nicho ?? null, d.site ?? null, d.vende_tiktok ?? false,
          d.cep ?? null, d.cidade ?? null, d.estado ?? null, d.tiktok_username ?? null, d.logo_url ?? null],
      )
      const id = await ensureClienteMarca(db, { tenantId, clienteId: cliente.rows[0].id, origem })
      if (!id) throw new CadastroError(409, 'CLIENTE_MARCA_SYNC_CONFLICT', 'Não foi possível criar a marca do cliente.')
      await db.query(
        `UPDATE marcas SET
           marketplace_url = COALESCE($3, marketplace_url),
           cor = COALESCE($4, cor),
           data_inicio = COALESCE($5::date, data_inicio),
           data_fim = COALESCE($6::date, data_fim),
           observacoes = COALESCE($7, observacoes),
           status = COALESCE($8, status),
           atualizado_em = NOW()
         WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [id, tenantId, d.marketplace_url ?? null, d.cor ?? null, d.data_inicio ?? null, d.data_fim ?? null,
          d.observacoes ?? null, d.status ?? null],
      )
      return id
    }
    const inserted = await db.query(
      `WITH nova_marca AS (
         INSERT INTO marcas (
           tenant_id, cliente_id, nome, tipo, status, tiktok_username, site,
           marketplace_url, observacoes, logo_url, cor, data_inicio, data_fim, origem_dados
         )
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *
       ), baseline AS (
         INSERT INTO marca_condicoes_comerciais (
           tenant_id, marca_id, inicio_vigencia, fixo_mensal,
           comissao_franquia_pct, comissao_franqueadora_pct, tipo_cobranca, origem, motivo
         )
         SELECT tenant_id, id, DATE '1900-01-01', valor_fixo_minimo,
                comissao_franquia_pct, comissao_franqueadora_pct, tipo_cobranca,
                'legado_nao_verificado', 'Condição criada junto com o cadastro.'
           FROM nova_marca
         ON CONFLICT (tenant_id, marca_id, inicio_vigencia) WHERE cancelled_at IS NULL DO NOTHING
       )
       SELECT id FROM nova_marca`,
      [tenantId, d.nome, d.tipo, d.status ?? 'ativa', d.tiktok_username ?? null, d.site ?? null,
        d.marketplace_url ?? null, d.observacoes ?? null, d.logo_url ?? null, d.cor ?? null,
        d.data_inicio ?? null, d.data_fim ?? null, origem],
    )
    return inserted.rows[0].id
  })
  return obterCadastro(db, { tenantId, id: marcaId })
}

function setClause(updates, offset) {
  const keys = Object.keys(updates)
  return {
    sql: keys.map((k, i) => `${k} = $${i + offset}`).join(', '),
    values: keys.map((k) => updates[k]),
  }
}

/**
 * Atualiza um cadastro roteando cada campo à tabela certa, com as mesmas regras
 * dos PATCH de /v1/clientes e /v1/marcas:
 *  - nome: marca (checagem de nome único) e, se houver ficha, cliente;
 *  - campos de ficha: só cadastro tipo cliente (senão 400);
 *  - site/logo: ficha + marca espelho; sem ficha, só marca;
 *  - tiktok_username: fonte canônica (updateCanonicalTikTokUsername);
 *  - status (operacional) só em cadastro sem ficha; status_comercial só com ficha,
 *    com a mesma cascata do PATCH /v1/clientes (cancelado → marca inativa,
 *    arquivado → arquivada, ativo → reativa);
 *  - tipo/cliente_id: 409 (use POST /v1/cadastros/:id/promover-cliente);
 *  - campos financeiros: 409 (use /v1/marcas/:id/condicoes).
 */
export async function atualizarCadastro(db, { tenantId, id, dados }) {
  rejeitarFinanceiro(dados)
  if (dados && (Object.hasOwn(dados, 'tipo') || Object.hasOwn(dados, 'cliente_id'))) {
    throw new CadastroError(409, 'USE_PROMOVER_CLIENTE',
      'Tipo e vínculo de cliente não mudam por edição. Use POST /v1/cadastros/:id/promover-cliente.')
  }
  const parsed = atualizarCadastroSchema.safeParse(dados ?? {})
  if (!parsed.success) throw new CadastroError(400, 'CADASTRO_INVALIDO', parsed.error.issues[0].message)
  const d = { ...parsed.data }
  if (Object.keys(d).length === 0) throw new CadastroError(400, 'CADASTRO_SEM_CAMPOS', 'Nenhum campo para atualizar')

  const marcaId = await resolverCadastroId(db, { tenantId, id })
  if (!marcaId) throw new CadastroError(404, 'CADASTRO_NAO_ENCONTRADO', 'Cadastro não encontrado')

  await transacao(db, async () => {
    const marcaQ = await db.query(
      `SELECT id, nome, tipo, cliente_id, COALESCE(sistema, false) AS sistema
         FROM marcas WHERE id = $1::uuid AND tenant_id = $2::uuid FOR UPDATE`,
      [marcaId, tenantId],
    )
    const marca = marcaQ.rows[0]
    if (!marca) throw new CadastroError(404, 'CADASTRO_NAO_ENCONTRADO', 'Cadastro não encontrado')
    if (marca.sistema) throw new CadastroError(409, 'CADASTRO_SISTEMA', 'A marca do sistema não pode ser editada.')
    const clienteId = marca.tipo === 'cliente' ? marca.cliente_id : null
    if (clienteId) {
      await db.query('SELECT id FROM clientes WHERE id = $1::uuid AND tenant_id = $2::uuid FOR UPDATE', [clienteId, tenantId])
    }

    const fichaUpd = {}
    const marcaUpd = {}
    for (const k of CAMPOS_FICHA) if (d[k] !== undefined) fichaUpd[k] = d[k]
    for (const k of CAMPOS_MARCA) if (d[k] !== undefined) marcaUpd[k] = d[k]
    if (Object.keys(fichaUpd).length > 0 && !clienteId) {
      throw new CadastroError(400, 'CAMPO_FICHA_SEM_CLIENTE',
        `Campos de ficha (${Object.keys(fichaUpd).join(', ')}) só existem em cadastro tipo cliente.`,
        { campos: Object.keys(fichaUpd) })
    }
    if (d.status !== undefined) {
      if (clienteId) {
        throw new CadastroError(409, 'USE_STATUS_COMERCIAL',
          'O status de um cadastro tipo cliente segue a ficha. Envie status_comercial.')
      }
      marcaUpd.status = d.status
    }
    if (d.status_comercial !== undefined && !clienteId) {
      throw new CadastroError(400, 'CAMPO_FICHA_SEM_CLIENTE', 'status_comercial só existe em cadastro tipo cliente.')
    }
    if (d.site !== undefined) {
      marcaUpd.site = d.site
      if (clienteId) fichaUpd.site = d.site
    }
    if (d.logo_url !== undefined) {
      marcaUpd.logo_url = d.logo_url
      if (clienteId) fichaUpd.logo_url = d.logo_url
    }
    if (d.nome !== undefined && d.nome !== marca.nome) {
      if (await nomeJaExiste(db, { tenantId, nome: d.nome, ignoreId: marca.id })) {
        throw new CadastroError(409, 'MARCA_NOME_DUPLICADA', MARCA_NOME_DUPLICADA)
      }
      marcaUpd.nome = d.nome
      if (clienteId) fichaUpd.nome = d.nome
    }

    let statusComercial = d.status_comercial
    if (statusComercial === 'ganho') {
      statusComercial = 'onboarding'
      fichaUpd.onboarding_step = 1
    }
    if (statusComercial !== undefined) fichaUpd.status = statusComercial

    if (Object.keys(fichaUpd).length > 0) {
      const { sql, values } = setClause(fichaUpd, 3)
      await db.query(
        `UPDATE clientes SET ${sql}, atualizado_em = NOW() WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [clienteId, tenantId, ...values],
      )
    }
    if (Object.keys(marcaUpd).length > 0) {
      const { sql, values } = setClause(marcaUpd, 3)
      await db.query(
        `UPDATE marcas SET ${sql}, atualizado_em = NOW() WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [marca.id, tenantId, ...values],
      )
    }
    if (d.tiktok_username !== undefined) {
      await updateCanonicalTikTokUsername(db, { tenantId, marcaId: marca.id, username: d.tiktok_username })
    }
    if (clienteId && statusComercial !== undefined) {
      // Mesma cascata do PATCH /v1/clientes/:id.
      await ensureClienteMarca(db, { tenantId, clienteId, activateExisting: statusComercial === 'ativo' })
      if (['cancelado', 'cancelado_automaticamente'].includes(statusComercial)) {
        await db.query(
          `UPDATE marcas SET status = 'inativa', atualizado_em = NOW()
            WHERE cliente_id = $1::uuid AND tenant_id = $2::uuid AND tipo = 'cliente'`,
          [clienteId, tenantId],
        )
      } else if (statusComercial === 'arquivado') {
        await db.query(
          `UPDATE marcas SET status = 'arquivada', atualizado_em = NOW()
            WHERE cliente_id = $1::uuid AND tenant_id = $2::uuid AND tipo = 'cliente'`,
          [clienteId, tenantId],
        )
      }
    }
  })
  return obterCadastro(db, { tenantId, id: marcaId })
}

/**
 * Promove uma marca afiliada/própria/parceira a cliente: cria a ficha (ou vincula
 * `cliente_id` de uma ficha sem marca tipo cliente) e vira tipo='cliente'.
 *
 * Proteção de dinheiro: a partir daqui a marca GERA RECEITA (marcaGeraReceitaSql).
 * O fixo por vigência começa em data_inicio (preenchida com a data informada ou
 * hoje, se estava vazia). A comissão usa a condição vigente na data de cada live —
 * se já houver condição com % ou fixo > 0 vigente ANTES de data_inicio, GMV antigo
 * viraria comissão retroativa: 409 PROMOCAO_CONDICAO_RETROATIVA até o usuário
 * confirmar (confirmar_retroativo: true) ou ajustar as condições.
 */
export async function promoverACliente(db, { tenantId, id, dados }) {
  const parsed = promoverSchema.safeParse(dados ?? {})
  if (!parsed.success) throw new CadastroError(400, 'CADASTRO_INVALIDO', parsed.error.issues[0].message)
  const d = parsed.data
  const marcaId = await resolverCadastroId(db, { tenantId, id })
  if (!marcaId) throw new CadastroError(404, 'CADASTRO_NAO_ENCONTRADO', 'Cadastro não encontrado')

  const resultado = await transacao(db, async () => {
    const marcaQ = await db.query(
      `SELECT id, nome, tipo, cliente_id, COALESCE(sistema, false) AS sistema, site, logo_url,
              tiktok_username, data_inicio
         FROM marcas WHERE id = $1::uuid AND tenant_id = $2::uuid FOR UPDATE`,
      [marcaId, tenantId],
    )
    const marca = marcaQ.rows[0]
    if (!marca) throw new CadastroError(404, 'CADASTRO_NAO_ENCONTRADO', 'Cadastro não encontrado')
    if (marca.sistema) throw new CadastroError(409, 'CADASTRO_SISTEMA', 'A marca do sistema não pode virar cliente.')
    if (marca.tipo === 'cliente') throw new CadastroError(409, 'CADASTRO_JA_E_CLIENTE', 'Este cadastro já é cliente.')

    const hojeQ = await db.query(`SELECT (NOW() AT TIME ZONE 'America/Sao_Paulo')::date::text AS hoje`)
    const dataInicio = d.data_inicio ?? marca.data_inicio ?? hojeQ.rows[0].hoje

    const retro = await db.query(
      `SELECT id, inicio_vigencia::text AS inicio_vigencia, fixo_mensal, comissao_franquia_pct
         FROM marca_condicoes_comerciais
        WHERE tenant_id = $1::uuid AND marca_id = $2::uuid AND cancelled_at IS NULL
          AND inicio_vigencia < $3::date
          AND (COALESCE(comissao_franquia_pct, 0) > 0 OR COALESCE(fixo_mensal, 0) > 0)
        ORDER BY inicio_vigencia`,
      [tenantId, marca.id, dataInicio],
    )
    if (retro.rows.length > 0 && d.confirmar_retroativo !== true) {
      throw new CadastroError(409, 'PROMOCAO_CONDICAO_RETROATIVA',
        'Há condição comercial com fixo ou % vigente antes do início do contrato: GMV anterior viraria receita. '
        + 'Ajuste as condições em /v1/marcas/:id/condicoes ou reenvie com confirmar_retroativo: true.',
        { condicoes: retro.rows, data_inicio: dataInicio })
    }

    let clienteId = d.cliente_id ?? null
    if (clienteId) {
      const cli = await db.query(
        `SELECT c.id, c.tiktok_username,
                EXISTS (SELECT 1 FROM marcas m2 WHERE m2.tenant_id = c.tenant_id AND m2.cliente_id = c.id AND m2.tipo = 'cliente') AS tem_marca
           FROM clientes c
          WHERE c.id = $1::uuid AND c.tenant_id = $2::uuid AND c.deleted_at IS NULL
          FOR UPDATE`,
        [clienteId, tenantId],
      )
      if (!cli.rows[0]) throw new CadastroError(404, 'CLIENTE_NAO_ENCONTRADO', 'Cliente não encontrado')
      if (cli.rows[0].tem_marca) {
        throw new CadastroError(409, 'CLIENTE_JA_TEM_MARCA', 'Este cliente já possui um cadastro tipo cliente.')
      }
      if (!cli.rows[0].tiktok_username && marca.tiktok_username) {
        await db.query(
          'UPDATE clientes SET tiktok_username = $3, atualizado_em = NOW() WHERE id = $1::uuid AND tenant_id = $2::uuid',
          [clienteId, tenantId, marca.tiktok_username],
        )
      }
    } else {
      if (!d.celular || !d.celular.trim()) {
        throw new CadastroError(400, 'CADASTRO_INVALIDO', 'celular é obrigatório para promover a cliente')
      }
      const novo = await db.query(
        `INSERT INTO clientes (tenant_id, nome, celular, email, cnpj, razao_social, site, logo_url, tiktok_username, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ativo')
         RETURNING id`,
        [tenantId, marca.nome, d.celular, d.email ?? null, d.cnpj ?? null, d.razao_social ?? null,
          marca.site ?? null, marca.logo_url ?? null, marca.tiktok_username ?? null],
      )
      clienteId = novo.rows[0].id
    }

    // @ canônico passa a ser o da ficha (migration 103): marca tipo cliente fica NULL.
    await db.query(
      `UPDATE marcas
          SET tipo = 'cliente', cliente_id = $3::uuid,
              data_inicio = COALESCE(data_inicio, $4::date),
              tiktok_username = NULL,
              atualizado_em = NOW()
        WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      [marca.id, tenantId, clienteId, dataInicio],
    )
    await db.query(
      `UPDATE lives
          SET cliente_id = $3::uuid
        WHERE tenant_id = $1::uuid
          AND marca_id = $2::uuid
          AND cliente_id IS NULL`,
      [tenantId, marca.id, clienteId],
    )
    // Garante a condição baseline (idempotente; reaproveita a marca recém-promovida).
    await ensureClienteMarca(db, { tenantId, clienteId })
    return { clienteId, tipoAnterior: marca.tipo, dataInicio, retroativo: retro.rows.length > 0 }
  })
  const cadastro = await obterCadastro(db, { tenantId, id: marcaId })
  return { cadastro, ...resultado }
}
