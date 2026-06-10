/**
 * Gerador de Relatório Operacional PDF.
 *
 * Função pura: recebe dados prontos, retorna Buffer do PDF.
 * Não consulta banco, não tem efeitos colaterais.
 *
 * @module relatorio_pdf
 */

import PDFDocument from 'pdfkit'

// ---------------------------------------------------------------------------
// Constantes de layout
// ---------------------------------------------------------------------------

const MARGIN       = 50
const PAGE_WIDTH   = 595.28  // A4
const CONTENT_W    = PAGE_WIDTH - MARGIN * 2

const COR_PRIMARIA   = '#E8673C'
const COR_TEXTO      = '#1A1A2E'
const COR_SUBTEXTO   = '#6B7280'
const COR_FUNDO_HDR  = '#F9FAFB'
const COR_LINHA      = '#E5E7EB'
const COR_OK         = '#16A34A'
const COR_ATENCAO    = '#D97706'
const COR_CRITICO    = '#DC2626'
const COR_INCOMPLETO = '#6B7280'
const COR_FDS        = '#7C3AED'

const MESES_PT = [
  '', 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
]

// ---------------------------------------------------------------------------
// Formatadores pt-BR
// ---------------------------------------------------------------------------

function fmtBRL(value) {
  if (value == null) return 'não informado'
  const num = Number(value)
  if (!Number.isFinite(num)) return 'não informado'
  return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function fmtNum(value, decimais = 2) {
  if (value == null) return 'não informado'
  const num = Number(value)
  if (!Number.isFinite(num)) return 'não informado'
  return num.toLocaleString('pt-BR', {
    minimumFractionDigits: decimais,
    maximumFractionDigits: decimais,
  })
}

function fmtPct(value) {
  if (value == null) return 'não informado'
  const num = Number(value)
  if (!Number.isFinite(num)) return 'não informado'
  return `${num.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

function fmtHoras(value) {
  if (value == null) return 'não informado'
  const num = Number(value)
  if (!Number.isFinite(num)) return 'não informado'
  return `${fmtNum(num)}h`
}

function fmtInt(value) {
  if (value == null) return 'não informado'
  const num = Number(value)
  if (!Number.isFinite(num)) return 'não informado'
  return Math.round(num).toLocaleString('pt-BR')
}

function fmtData(isoStr) {
  if (!isoStr) return 'não informado'
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit', month: '2-digit', year: 'numeric',
    }).format(new Date(isoStr))
  } catch {
    return String(isoStr)
  }
}

function corStatus(status) {
  switch (status) {
    case 'ok':               return COR_OK
    case 'atencao':          return COR_ATENCAO
    case 'critico':          return COR_CRITICO
    case 'dados_incompletos':return COR_INCOMPLETO
    default:                 return COR_TEXTO
  }
}

function labelStatus(status) {
  switch (status) {
    case 'ok':               return 'OK'
    case 'atencao':          return 'Atenção'
    case 'critico':          return 'Crítico'
    case 'dados_incompletos':return 'Dados Incompletos'
    default:                 return status ?? 'não informado'
  }
}

// ---------------------------------------------------------------------------
// Sub-desenhistas
// ---------------------------------------------------------------------------

function _desenharCabecalho(doc, { cliente, periodo, geradoEm }) {
  const nomeMes  = MESES_PT[periodo.mes] ?? String(periodo.mes)
  const tituloPeriodo = `${nomeMes} ${periodo.ano}`

  // Barra laranja no topo
  doc.rect(0, 0, PAGE_WIDTH, 8).fill(COR_PRIMARIA)

  // Logo / marca
  doc.moveDown(0.5)
  doc.font('Helvetica-Bold').fontSize(18).fillColor(COR_PRIMARIA)
  doc.text('LiveLab', MARGIN, 20, { continued: false })

  // Título
  doc.font('Helvetica-Bold').fontSize(14).fillColor(COR_TEXTO)
  doc.text('Relatório Operacional', MARGIN, 44)

  // Período e cliente à direita
  doc.font('Helvetica').fontSize(10).fillColor(COR_SUBTEXTO)
  doc.text(tituloPeriodo, PAGE_WIDTH - MARGIN - 120, 44, { width: 120, align: 'right' })

  if (cliente?.nome || cliente?.marca) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(COR_TEXTO)
    doc.text(cliente.nome ?? cliente.marca, MARGIN, 62)
  }

  doc.font('Helvetica').fontSize(9).fillColor(COR_SUBTEXTO)
  doc.text(`Gerado em ${geradoEm}`, PAGE_WIDTH - MARGIN - 160, 62, { width: 160, align: 'right' })

  // Linha divisória
  const y = 82
  doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y).strokeColor(COR_LINHA).lineWidth(1).stroke()

  doc.y = y + 10
}

function _desenharSecaoTitulo(doc, titulo) {
  _garantirEspaco(doc, 28)
  doc.rect(MARGIN, doc.y, CONTENT_W, 20).fill(COR_FUNDO_HDR)
  doc.font('Helvetica-Bold').fontSize(10).fillColor(COR_PRIMARIA)
  doc.text(titulo.toUpperCase(), MARGIN + 8, doc.y - 15)
  doc.y = doc.y + 6
  doc.moveTo(MARGIN, doc.y).lineTo(PAGE_WIDTH - MARGIN, doc.y)
    .strokeColor(COR_LINHA).lineWidth(0.5).stroke()
  doc.y = doc.y + 6
}

function _campoValor(doc, label, valor, { cor, negrito } = {}) {
  _garantirEspaco(doc, 16)
  const startY = doc.y
  doc.font('Helvetica').fontSize(9).fillColor(COR_SUBTEXTO)
  doc.text(label, MARGIN, startY, { continued: false, width: CONTENT_W * 0.55 })
  doc.font(negrito ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
    .fillColor(cor ?? COR_TEXTO)
  doc.text(String(valor ?? 'não informado'), MARGIN + CONTENT_W * 0.55, startY, {
    width: CONTENT_W * 0.45,
    align: 'right',
  })
  doc.y = startY + 14
}

function _desenharConsolidado(doc, { operacional }) {
  _desenharSecaoTitulo(doc, 'Resumo Consolidado do Período')

  const m = operacional.metricas ?? {}
  const c = operacional.config ?? {}

  _campoValor(doc, 'Horas de live realizadas', fmtHoras(m.horas_live))
  _campoValor(doc, 'GMV (faturamento gerado)', fmtBRL(m.gmv), { negrito: true })
  _campoValor(doc, 'GMV por hora', fmtBRL(m.gmv_por_hora))

  const metaLabel = c.meta_gmv_hora != null
    ? `Meta ${fmtBRL(c.meta_gmv_hora)}/h`
    : 'Meta GMV/hora'
  const metaValor = m.pct_meta_hora != null
    ? `${fmtPct(m.pct_meta_hora)} da meta`
    : 'não informado'
  const corMeta = m.pct_meta_hora != null
    ? (m.pct_meta_hora >= 100 ? COR_OK : COR_ATENCAO)
    : COR_SUBTEXTO
  _campoValor(doc, metaLabel, metaValor, { cor: corMeta })

  _campoValor(doc, 'Comissão LiveLab total', fmtBRL(m.comissao_livelab_total))
  _campoValor(doc, 'Comissão apresentadora total', fmtBRL(m.comissao_apresentadora_total))
  _campoValor(doc, 'Comissão LiveLab por hora', fmtBRL(m.comissao_por_hora))

  // Funil
  doc.y += 4
  doc.font('Helvetica-BoldOblique').fontSize(9).fillColor(COR_SUBTEXTO)
  doc.text('Funil de vendas', MARGIN, doc.y)
  doc.y += 2

  const funil = m.funil ?? {}
  _campoValor(doc, '  Views (pico)', fmtInt(funil.views))
  _campoValor(doc, '  Cliques', funil.clicks != null ? fmtInt(funil.clicks) : 'não informado')
  _campoValor(doc, '  Pedidos', fmtInt(funil.pedidos))
}

function _desenharStatus(doc, { operacional }) {
  _desenharSecaoTitulo(doc, 'Diagnóstico do Período')

  const s = operacional.status ?? {}
  const statusStr = labelStatus(s.status)
  const cor = corStatus(s.status)

  _campoValor(doc, 'Status do período', statusStr, { cor, negrito: true })

  if (s.motivos?.length) {
    _garantirEspaco(doc, 14)
    doc.font('Helvetica').fontSize(9).fillColor(COR_SUBTEXTO)
    doc.text('Motivos:', MARGIN, doc.y)
    doc.y += 2
    for (const motivo of s.motivos) {
      _garantirEspaco(doc, 12)
      doc.font('Helvetica').fontSize(9).fillColor(COR_TEXTO)
      doc.text(`• ${motivo}`, MARGIN + 10, doc.y, { width: CONTENT_W - 10 })
      doc.y += 2
    }
  }

  if (s.diagnostico) {
    _campoValor(doc, 'Diagnóstico', s.diagnostico)
  }

  if (s.proxima_acao) {
    _campoValor(doc, 'Próxima ação', s.proxima_acao, { cor: COR_PRIMARIA })
  }
}

function _desenharTabela(doc, { sessoes }) {
  _desenharSecaoTitulo(doc, 'Detalhamento por Sessão')

  if (!sessoes || sessoes.length === 0) {
    _garantirEspaco(doc, 14)
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(COR_SUBTEXTO)
    doc.text('Nenhuma sessão no período.', MARGIN, doc.y)
    doc.y += 14
    return
  }

  // Definição das colunas
  const cols = [
    { titulo: 'Data',        width: 58,  campo: (s) => s.data ?? 'não inf.',     align: 'left'  },
    { titulo: 'Apresent.',   width: 70,  campo: (s) => (s.apresentadora ?? 'não inf.').slice(0, 12), align: 'left' },
    { titulo: 'Horas',       width: 38,  campo: (s) => fmtHoras(s.horas),        align: 'right' },
    { titulo: 'GMV',         width: 62,  campo: (s) => fmtBRL(s.gmv),            align: 'right' },
    { titulo: 'Pedidos',     width: 44,  campo: (s) => fmtInt(s.pedidos),        align: 'right' },
    { titulo: 'GMV/h',       width: 60,  campo: (s) => fmtBRL(s.gmv_por_hora),   align: 'right' },
    { titulo: 'Com.LL',      width: 60,  campo: (s) => fmtBRL(s.comissao_livelab), align: 'right' },
    { titulo: 'Com.Apr.',    width: 60,  campo: (s) => fmtBRL(s.comissao_apresentadora), align: 'right' },
    { titulo: 'Status',      width: 54,  campo: (s) => labelStatus(s.status_operacional), align: 'center' },
  ]

  _desenharHeaderTabela(doc, cols)

  for (const sessao of sessoes) {
    _desenharLinhaTabela(doc, sessao, cols)
  }
}

function _desenharHeaderTabela(doc, cols) {
  _garantirEspaco(doc, 18)
  const startY = doc.y
  doc.rect(MARGIN, startY, CONTENT_W, 16).fill(COR_FUNDO_HDR)

  let x = MARGIN + 4
  for (const col of cols) {
    doc.font('Helvetica-Bold').fontSize(7).fillColor(COR_TEXTO)
    doc.text(col.titulo, x, startY + 4, { width: col.width - 4, align: col.align })
    x += col.width
  }

  doc.y = startY + 17
  doc.moveTo(MARGIN, doc.y).lineTo(PAGE_WIDTH - MARGIN, doc.y)
    .strokeColor(COR_LINHA).lineWidth(0.5).stroke()
  doc.y += 1
}

function _desenharLinhaTabela(doc, sessao, cols) {
  const ROW_H = 14
  _garantirEspaco(doc, ROW_H + 2)

  const startY = doc.y
  const isFds  = sessao.fim_de_semana === true

  if (isFds) {
    doc.rect(MARGIN, startY, CONTENT_W, ROW_H).fill('#FEF3F2').stroke()
  }

  let x = MARGIN + 4
  for (const col of cols) {
    let texto = col.campo(sessao)
    // Marcar fim de semana na coluna data
    if (col.titulo === 'Data' && isFds) {
      texto = `${texto}★`
    }

    const corCelula = col.titulo === 'Status'
      ? corStatus(sessao.status_operacional)
      : COR_TEXTO

    doc.font(col.titulo === 'Status' ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(7)
      .fillColor(corCelula)
    doc.text(texto, x, startY + 3, { width: col.width - 4, align: col.align })
    x += col.width
  }

  doc.y = startY + ROW_H
  doc.moveTo(MARGIN, doc.y).lineTo(PAGE_WIDTH - MARGIN, doc.y)
    .strokeColor(COR_LINHA).lineWidth(0.3).stroke()
  doc.y += 1

  // Nota de fim de semana (taxa diferenciada)
  if (isFds && sessao.comissao_apresentadora_pct != null) {
    _garantirEspaco(doc, 10)
    doc.font('Helvetica-Oblique').fontSize(6.5).fillColor(COR_FDS)
    doc.text(
      `  ★ fim de semana ${fmtPct(sessao.comissao_apresentadora_pct)} com. apr.`,
      MARGIN + 4, doc.y,
      { width: CONTENT_W - 8 },
    )
    doc.y += 9
  }
}

function _desenharRodape(doc) {
  const range = doc.bufferedPageRange()
  const totalPages = range.count

  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(range.start + i)

    const pageNum = i + 1
    const y = doc.page.height - 30

    doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y)
      .strokeColor(COR_LINHA).lineWidth(0.5).stroke()

    doc.font('Helvetica').fontSize(8).fillColor(COR_SUBTEXTO)
    doc.text('LiveLab · Relatório Operacional', MARGIN, y + 6,
      { width: CONTENT_W * 0.6, align: 'left' })
    doc.text(`${pageNum} / ${totalPages}`, MARGIN, y + 6,
      { width: CONTENT_W, align: 'right' })
  }
}

/**
 * Garante espaço na página; adiciona nova página se necessário.
 */
function _garantirEspaco(doc, needed) {
  if (doc.y + needed > doc.page.height - 60) {
    doc.addPage()
  }
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * Gera o relatório operacional como Buffer PDF.
 *
 * @param {object} params
 * @param {{ nome?: string, marca?: string }} params.cliente   - Dados do cliente
 * @param {{ mes: number, ano: number }}     params.periodo    - Período do relatório
 * @param {object}                           params.operacional - Payload do /v1/cliente/operacional
 * @param {{ sessoes: object[] }}            params.sessoes     - Payload do /v1/cliente/sessoes
 * @returns {Promise<Buffer>}
 */
export async function gerarRelatorioOperacionalPdf({ cliente, periodo, operacional, sessoes }) {
  const geradoEm = new Intl.DateTimeFormat('pt-BR', {
    timeZone:    'America/Sao_Paulo',
    day:  '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date())

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size:    'A4',
      margins: { top: 10, bottom: 40, left: MARGIN, right: MARGIN },
      bufferPages: true,
      info: {
        Title:    'Relatório Operacional LiveLab',
        Author:   'LiveLab',
        Subject:  `${MESES_PT[periodo.mes] ?? periodo.mes} ${periodo.ano}`,
        Creator:  'LiveLab PDF Service',
      },
    })

    const chunks = []
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('end',  () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    // Página 1
    _desenharCabecalho(doc, { cliente, periodo, geradoEm })
    _desenharConsolidado(doc, { operacional })
    _desenharStatus(doc, { operacional })
    _desenharTabela(doc, { sessoes: sessoes?.sessoes ?? sessoes ?? [] })

    // Rodapé em todas as páginas (after flush)
    _desenharRodape(doc)

    doc.end()
  })
}
