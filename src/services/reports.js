// src/services/reports.js
// Geração de relatórios CSV (puro Node) e PDF (via pdfkit).
// Mantemos as funções puras: recebem rows/data prontos e devolvem string ou Buffer.
//
// Inclui:
//   buildClientePDFHtml  — relatório mensal legado (F2)
//   buildRelatorioOperacionalPdf — painel operacional do cliente (Fase 8)

import PDFDocument from 'pdfkit'

// ─── Helpers ─────────────────────────────────────────────────────────

function toNum(v) {
  if (v == null) return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function fmtBRL(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(toNum(value))
}

function fmtDate(value) {
  if (!value) return ''
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(d)
}

function fmtDateTime(value) {
  if (!value) return ''
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(d)
}

// CSV escaping per RFC 4180 — quote if contains comma/quote/newline; double up quotes.
function csvCell(value) {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (/[",\n\r;]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function csvRow(cells) {
  return cells.map(csvCell).join(',')
}

function buildCSV(headers, rows) {
  // BOM UTF-8 pra Excel reconhecer encoding com acentos
  const lines = ['﻿' + csvRow(headers)]
  for (const r of rows) lines.push(csvRow(r))
  return lines.join('\r\n')
}

// ─── CSVs ────────────────────────────────────────────────────────────

/**
 * Gera CSV de financeiro. Espera rows com colunas:
 *   data, cliente, apresentador, cabine, gmv, comissao, duracao_min
 */
export function buildFinanceiroCSV(rows) {
  const headers = [
    'data',
    'cliente',
    'apresentador',
    'cabine',
    'gmv',
    'comissao',
    'duracao_min',
  ]
  const list = (rows ?? []).map((r) => [
    fmtDate(r.data),
    r.cliente ?? '',
    r.apresentador ?? '',
    r.cabine ?? '',
    toNum(r.gmv).toFixed(2).replace('.', ','),
    toNum(r.comissao).toFixed(2).replace('.', ','),
    Math.round(toNum(r.duracao_min)),
  ])
  return buildCSV(headers, list)
}

/**
 * Gera CSV de boletos. Espera rows com colunas:
 *   id, cliente, valor, vencimento, status, pago_em
 */
export function buildBoletosCSV(rows) {
  const headers = ['id', 'cliente', 'valor', 'vencimento', 'status', 'pago_em']
  const list = (rows ?? []).map((r) => [
    r.id ?? '',
    r.cliente ?? '',
    toNum(r.valor).toFixed(2).replace('.', ','),
    fmtDate(r.vencimento),
    r.status ?? '',
    r.pago_em ? fmtDateTime(r.pago_em) : '',
  ])
  return buildCSV(headers, list)
}

// ─── PDF Cliente ─────────────────────────────────────────────────────

/**
 * Gera PDF mensal do cliente. Recebe data:
 * {
 *   cliente:        { nome, nicho? },
 *   periodo:        'YYYY-MM',
 *   kpis: {
 *     lives_realizadas, gmv_total, gmv_medio,
 *     horas_realizadas, horas_contratadas,
 *   },
 *   lives: [{ data, apresentador, gmv, duracao_min }, ...]   (max 30 renderizadas)
 *   proximas_lives: [{ data_inicio, hora_inicio, apresentador }, ...]
 * }
 *
 * Retorna Promise<Buffer> com o PDF binário.
 */
export function buildClientePDFHtml(data) {
  // Nome mantido por compatibilidade com a especificação F2; gera Buffer PDF nativo.
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 48,
        info: {
          Title: `Relatório ${data?.cliente?.nome ?? 'Cliente'} — ${data?.periodo ?? ''}`,
          Author: 'LiveShop SaaS',
        },
      })

      const chunks = []
      doc.on('data', (c) => chunks.push(c))
      doc.on('error', reject)
      doc.on('end', () => resolve(Buffer.concat(chunks)))

      const cliente = data?.cliente ?? { nome: 'Cliente' }
      const periodo = data?.periodo ?? ''
      const kpis = data?.kpis ?? {}
      const lives = Array.isArray(data?.lives) ? data.lives.slice(0, 30) : []
      const proximas = Array.isArray(data?.proximas_lives) ? data.proximas_lives.slice(0, 10) : []

      // ─── Header ──────────────────────────────────────────
      doc
        .fillColor('#E8673C')
        .fontSize(10)
        .text('LIVESHOP — RELATÓRIO MENSAL', { align: 'left' })
      doc.moveDown(0.2)
      doc
        .fillColor('#111111')
        .fontSize(20)
        .text(cliente.nome ?? 'Cliente', { continued: false })
      doc
        .fillColor('#555555')
        .fontSize(11)
        .text(`Período: ${periodo}${cliente.nicho ? `  ·  Nicho: ${cliente.nicho}` : ''}`)
      doc.moveDown(0.6)
      doc
        .strokeColor('#E5E5E5')
        .lineWidth(1)
        .moveTo(48, doc.y)
        .lineTo(547, doc.y)
        .stroke()
      doc.moveDown(0.8)

      // ─── KPIs grid 2x2 ────────────────────────────────────
      const livesRealizadas = Math.round(toNum(kpis.lives_realizadas))
      const gmvTotal = toNum(kpis.gmv_total)
      const gmvMedio = toNum(kpis.gmv_medio)
      const horasRealizadas = toNum(kpis.horas_realizadas)
      const horasContratadas = toNum(kpis.horas_contratadas)

      const cells = [
        { label: 'LIVES REALIZADAS', value: String(livesRealizadas) },
        { label: 'GMV TOTAL', value: fmtBRL(gmvTotal) },
        { label: 'GMV MÉDIO POR LIVE', value: fmtBRL(gmvMedio) },
        {
          label: 'HORAS REALIZADAS / CONTRATADAS',
          value: `${horasRealizadas.toFixed(1)}h / ${horasContratadas.toFixed(1)}h`,
        },
      ]

      const gridStartY = doc.y
      const cellWidth = 245
      const cellHeight = 70
      cells.forEach((c, i) => {
        const col = i % 2
        const row = Math.floor(i / 2)
        const x = 48 + col * (cellWidth + 10)
        const y = gridStartY + row * (cellHeight + 10)
        doc
          .roundedRect(x, y, cellWidth, cellHeight, 6)
          .fillAndStroke('#FAFAF7', '#E5E5E5')
        doc
          .fillColor('#888888')
          .fontSize(8)
          .text(c.label, x + 14, y + 14, { width: cellWidth - 28 })
        doc
          .fillColor('#111111')
          .fontSize(18)
          .text(c.value, x + 14, y + 32, { width: cellWidth - 28 })
      })

      doc.y = gridStartY + 2 * (cellHeight + 10) + 8

      // ─── Tabela de lives ─────────────────────────────────
      doc
        .fillColor('#111111')
        .fontSize(13)
        .text('Lives no período', 48, doc.y)
      doc.moveDown(0.4)

      const colX = { data: 48, apres: 140, gmv: 360, dur: 470 }
      const headerY = doc.y
      doc.fontSize(9).fillColor('#555555')
      doc.text('Data', colX.data, headerY)
      doc.text('Apresentador', colX.apres, headerY)
      doc.text('GMV', colX.gmv, headerY, { width: 90, align: 'right' })
      doc.text('Duração', colX.dur, headerY, { width: 80, align: 'right' })
      doc.moveDown(0.3)
      doc
        .strokeColor('#E5E5E5')
        .lineWidth(0.5)
        .moveTo(48, doc.y)
        .lineTo(547, doc.y)
        .stroke()
      doc.moveDown(0.3)

      doc.fillColor('#111111').fontSize(9)
      if (lives.length === 0) {
        doc.fillColor('#888888').text('Nenhuma live no período.', 48)
        doc.moveDown(0.5)
      } else {
        for (const l of lives) {
          if (doc.y > 740) {
            doc.addPage()
          }
          const rowY = doc.y
          doc.fillColor('#111111').fontSize(9)
          doc.text(fmtDate(l.data), colX.data, rowY, { width: 86 })
          doc.text(String(l.apresentador ?? '—'), colX.apres, rowY, { width: 210 })
          doc.text(fmtBRL(l.gmv), colX.gmv, rowY, { width: 90, align: 'right' })
          doc.text(`${Math.round(toNum(l.duracao_min))} min`, colX.dur, rowY, {
            width: 80,
            align: 'right',
          })
          doc.moveDown(0.6)
        }
      }

      // ─── Próximas lives ──────────────────────────────────
      if (proximas.length > 0) {
        doc.moveDown(0.5)
        if (doc.y > 700) doc.addPage()
        doc
          .fillColor('#111111')
          .fontSize(13)
          .text('Próximas lives agendadas', 48)
        doc.moveDown(0.4)
        doc.fontSize(9).fillColor('#111111')
        for (const p of proximas) {
          if (doc.y > 760) doc.addPage()
          const linha = `${fmtDate(p.data_inicio)} ${p.hora_inicio ?? ''}  ·  ${p.apresentador ?? '—'}`
          doc.text(linha, 48)
          doc.moveDown(0.3)
        }
      }

      // ─── Footer ──────────────────────────────────────────
      const geradoEm = new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date())
      const range = doc.bufferedPageRange()
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i)
        doc
          .fillColor('#888888')
          .fontSize(8)
          .text(
            `LiveShop SaaS  ·  Gerado em ${geradoEm}  ·  Página ${i + 1} de ${range.count}`,
            48,
            800,
            { align: 'center', width: 499 }
          )
      }

      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}

// ---------------------------------------------------------------------------
// PDF Operacional do Cliente (Painel — Fase 8)
// ---------------------------------------------------------------------------

const _OP_MARGIN      = 50
const _OP_PAGE_WIDTH  = 595.28  // A4
const _OP_CONTENT_W   = _OP_PAGE_WIDTH - _OP_MARGIN * 2

const _COR_PRIMARIA   = '#E8673C'
const _COR_TEXTO      = '#1A1A2E'
const _COR_SUBTEXTO   = '#6B7280'
const _COR_FUNDO_HDR  = '#F9FAFB'
const _COR_LINHA      = '#E5E7EB'
const _COR_OK         = '#16A34A'
const _COR_ATENCAO    = '#D97706'
const _COR_CRITICO    = '#DC2626'
const _COR_INCOMPLETO = '#6B7280'
const _COR_FDS        = '#7C3AED'

const _MESES_PT = [
  '', 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
]

function _opFmtBRL(value) {
  if (value == null) return 'não informado'
  const num = Number(value)
  if (!Number.isFinite(num)) return 'não informado'
  return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function _opFmtNum(value, decimais = 2) {
  if (value == null) return 'não informado'
  const num = Number(value)
  if (!Number.isFinite(num)) return 'não informado'
  return num.toLocaleString('pt-BR', {
    minimumFractionDigits: decimais,
    maximumFractionDigits: decimais,
  })
}

function _opFmtPct(value) {
  if (value == null) return 'não informado'
  const num = Number(value)
  if (!Number.isFinite(num)) return 'não informado'
  return `${num.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

function _opFmtHoras(value) {
  if (value == null) return 'não informado'
  const num = Number(value)
  if (!Number.isFinite(num)) return 'não informado'
  return `${_opFmtNum(num)}h`
}

function _opFmtInt(value) {
  if (value == null) return 'não informado'
  const num = Number(value)
  if (!Number.isFinite(num)) return 'não informado'
  return Math.round(num).toLocaleString('pt-BR')
}

function _opFmtData(isoStr) {
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

function _opCorStatus(status) {
  switch (status) {
    case 'ok':               return _COR_OK
    case 'atencao':          return _COR_ATENCAO
    case 'critico':          return _COR_CRITICO
    case 'dados_incompletos':return _COR_INCOMPLETO
    default:                 return _COR_TEXTO
  }
}

function _opLabelStatus(status) {
  switch (status) {
    case 'ok':               return 'OK'
    case 'atencao':          return 'Atenção'
    case 'critico':          return 'Crítico'
    case 'dados_incompletos':return 'Dados Incompletos'
    default:                 return status ?? 'não informado'
  }
}

function _opGarantirEspaco(doc, needed) {
  if (doc.y + needed > doc.page.height - 60) {
    doc.addPage()
  }
}

function _opDesenharCabecalho(doc, { cliente, periodo, geradoEm }) {
  const nomeMes = _MESES_PT[periodo.mes] ?? periodo.mes
  const nomeCliente = cliente?.nome ?? 'Cliente'

  doc.rect(0, 0, _OP_PAGE_WIDTH, 70).fill(_COR_PRIMARIA)
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#FFFFFF')
  doc.text('RELATÓRIO OPERACIONAL', _OP_MARGIN, 18, { width: _OP_CONTENT_W })
  doc.font('Helvetica').fontSize(10).fillColor('#FFFFFF')
  doc.text(`${nomeMes} ${periodo.ano}  ·  ${nomeCliente}`, _OP_MARGIN, 38, { width: _OP_CONTENT_W })

  doc.font('Helvetica').fontSize(7).fillColor(_COR_SUBTEXTO)
  doc.text(`Gerado em ${geradoEm}`, _OP_MARGIN, 58, { width: _OP_CONTENT_W, align: 'right' })

  doc.y = 84
}

function _opDesenharSecaoTitulo(doc, titulo) {
  _opGarantirEspaco(doc, 22)
  doc.font('Helvetica-Bold').fontSize(10).fillColor(_COR_TEXTO)
  doc.text(titulo, _OP_MARGIN, doc.y)
  doc.moveTo(_OP_MARGIN, doc.y + 1).lineTo(_OP_PAGE_WIDTH - _OP_MARGIN, doc.y + 1)
    .strokeColor(_COR_LINHA).lineWidth(0.5).stroke()
  doc.y += 8
}

function _opDesenharConsolidado(doc, { operacional }) {
  _opDesenharSecaoTitulo(doc, 'Resumo do Período')

  const m = operacional?.metricas ?? {}
  const c = operacional?.config   ?? {}

  const items = [
    { label: 'Horas de Live',           value: _opFmtHoras(m.horas_live) },
    { label: 'GMV Total',               value: _opFmtBRL(m.gmv) },
    { label: 'GMV / Hora',              value: _opFmtBRL(m.gmv_por_hora) },
    { label: '% da Meta GMV/h',         value: m.pct_meta_hora != null ? _opFmtPct(m.pct_meta_hora) : 'não informado' },
    { label: 'Comissão LiveLab',        value: _opFmtBRL(m.comissao_livelab_total) },
    { label: 'Com. Apresentadora',      value: _opFmtBRL(m.comissao_apresentadora_total) },
    { label: 'Visualizações',           value: _opFmtInt(m.funil?.views) },
    { label: 'Cliques',                 value: _opFmtInt(m.funil?.clicks) },
    { label: 'Pedidos',                 value: _opFmtInt(m.funil?.pedidos) },
    { label: 'Meta GMV/h Config.',      value: _opFmtBRL(c.meta_gmv_hora) },
  ]

  const colW = _OP_CONTENT_W / 2 - 8
  let x = _OP_MARGIN
  let startY = doc.y

  items.forEach((item, idx) => {
    const col = idx % 2
    const row = Math.floor(idx / 2)
    if (col === 0 && row > 0) {
      _opGarantirEspaco(doc, 18)
    }
    const y = startY + row * 18
    x = _OP_MARGIN + col * (colW + 16)
    doc.font('Helvetica').fontSize(8).fillColor(_COR_SUBTEXTO)
    doc.text(item.label + ':', x, y, { width: 110, continued: true })
    doc.font('Helvetica-Bold').fillColor(_COR_TEXTO)
    doc.text(' ' + item.value, { width: colW - 114 })
  })

  doc.y = startY + Math.ceil(items.length / 2) * 18 + 6
}

function _opDesenharStatus(doc, { operacional }) {
  const s = operacional?.status
  if (!s) return

  _opDesenharSecaoTitulo(doc, 'Status Operacional do Período')

  const cor = _opCorStatus(s.status)
  doc.font('Helvetica-Bold').fontSize(11).fillColor(cor)
  doc.text(_opLabelStatus(s.status), _OP_MARGIN, doc.y)
  doc.y += 2

  if (Array.isArray(s.motivos) && s.motivos.length > 0) {
    doc.font('Helvetica').fontSize(8).fillColor(_COR_TEXTO)
    for (const m of s.motivos) {
      _opGarantirEspaco(doc, 12)
      doc.text(`• ${m}`, _OP_MARGIN + 8, doc.y, { width: _OP_CONTENT_W - 8 })
    }
  }

  if (s.diagnostico) {
    _opGarantirEspaco(doc, 14)
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(_COR_SUBTEXTO)
    doc.text(`Diagnóstico: ${s.diagnostico}`, _OP_MARGIN + 8, doc.y, { width: _OP_CONTENT_W - 8 })
  }

  if (s.proxima_acao) {
    _opGarantirEspaco(doc, 14)
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(_COR_SUBTEXTO)
    doc.text(`Próxima ação: ${s.proxima_acao}`, _OP_MARGIN + 8, doc.y, { width: _OP_CONTENT_W - 8 })
  }

  doc.y += 8
}

function _opDesenharTabela(doc, { sessoes }) {
  _opDesenharSecaoTitulo(doc, 'Detalhamento por Sessão')

  if (!sessoes || sessoes.length === 0) {
    _opGarantirEspaco(doc, 14)
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(_COR_SUBTEXTO)
    doc.text('Nenhuma sessão no período.', _OP_MARGIN, doc.y)
    doc.y += 14
    return
  }

  const cols = [
    { titulo: 'Data',         width: 52,  campo: (s) => s.data ?? 'não inf.', align: 'left' },
    { titulo: 'Apresentadora',width: 90,  campo: (s) => s.apresentadora ?? '—', align: 'left' },
    { titulo: 'Horas',        width: 38,  campo: (s) => _opFmtHoras(s.horas), align: 'right' },
    { titulo: 'GMV',          width: 70,  campo: (s) => _opFmtBRL(s.gmv), align: 'right' },
    { titulo: 'Pedidos',      width: 44,  campo: (s) => _opFmtInt(s.pedidos), align: 'right' },
    { titulo: 'GMV/h',        width: 58,  campo: (s) => _opFmtBRL(s.gmv_por_hora), align: 'right' },
    { titulo: 'Com.LL',       width: 60,  campo: (s) => _opFmtBRL(s.comissao_livelab), align: 'right' },
    { titulo: 'Com.Apr.',     width: 60,  campo: (s) => _opFmtBRL(s.comissao_apresentadora), align: 'right' },
    { titulo: 'Status',       width: 54,  campo: (s) => _opLabelStatus(s.status_operacional), align: 'center' },
  ]

  _opDesenharHeaderTabela(doc, cols)

  for (const sessao of sessoes) {
    _opDesenharLinhaTabela(doc, sessao, cols)
  }
}

function _opDesenharHeaderTabela(doc, cols) {
  _opGarantirEspaco(doc, 18)
  const startY = doc.y
  doc.rect(_OP_MARGIN, startY, _OP_CONTENT_W, 16).fill(_COR_FUNDO_HDR)

  let x = _OP_MARGIN + 4
  for (const col of cols) {
    doc.font('Helvetica-Bold').fontSize(7).fillColor(_COR_TEXTO)
    doc.text(col.titulo, x, startY + 4, { width: col.width - 4, align: col.align })
    x += col.width
  }

  doc.y = startY + 17
  doc.moveTo(_OP_MARGIN, doc.y).lineTo(_OP_PAGE_WIDTH - _OP_MARGIN, doc.y)
    .strokeColor(_COR_LINHA).lineWidth(0.5).stroke()
  doc.y += 1
}

function _opDesenharLinhaTabela(doc, sessao, cols) {
  const ROW_H = 14
  _opGarantirEspaco(doc, ROW_H + 2)

  const startY = doc.y
  const isFds  = sessao.fim_de_semana === true

  if (isFds) {
    doc.rect(_OP_MARGIN, startY, _OP_CONTENT_W, ROW_H).fill('#FEF3F2').stroke()
  }

  let x = _OP_MARGIN + 4
  for (const col of cols) {
    let texto = col.campo(sessao)
    if (col.titulo === 'Data' && isFds) {
      texto = `${texto}★`
    }

    const corCelula = col.titulo === 'Status'
      ? _opCorStatus(sessao.status_operacional)
      : _COR_TEXTO

    doc.font(col.titulo === 'Status' ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(7)
      .fillColor(corCelula)
    doc.text(texto, x, startY + 3, { width: col.width - 4, align: col.align })
    x += col.width
  }

  doc.y = startY + ROW_H
  doc.moveTo(_OP_MARGIN, doc.y).lineTo(_OP_PAGE_WIDTH - _OP_MARGIN, doc.y)
    .strokeColor(_COR_LINHA).lineWidth(0.3).stroke()
  doc.y += 1

  // Anotação de fim de semana com % de comissão
  if (isFds && sessao.comissao_apresentadora_pct != null) {
    _opGarantirEspaco(doc, 10)
    doc.font('Helvetica-Oblique').fontSize(6.5).fillColor(_COR_FDS)
    doc.text(
      `  ★ fim de semana ${_opFmtPct(sessao.comissao_apresentadora_pct)} com. apr.`,
      _OP_MARGIN + 4, doc.y,
      { width: _OP_CONTENT_W - 8 },
    )
    doc.y += 9
  }
}

function _opDesenharRodape(doc) {
  const range = doc.bufferedPageRange()
  const totalPages = range.count

  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(range.start + i)

    const pageNum = i + 1
    const y = doc.page.height - 30

    doc.moveTo(_OP_MARGIN, y).lineTo(_OP_PAGE_WIDTH - _OP_MARGIN, y)
      .strokeColor(_COR_LINHA).lineWidth(0.5).stroke()

    doc.font('Helvetica').fontSize(7).fillColor(_COR_SUBTEXTO)
    doc.text('LiveLab — Painel Operacional', _OP_MARGIN, y + 6, { width: _OP_CONTENT_W / 2 })
    doc.text(
      `Página ${pageNum} de ${totalPages}`,
      _OP_MARGIN, y + 6,
      { width: _OP_CONTENT_W, align: 'right' },
    )
  }
}

/**
 * Gera o relatório operacional do cliente como Buffer PDF.
 *
 * Função pura: recebe dados prontos, retorna Promise<Buffer>.
 * Não consulta banco, sem efeitos colaterais.
 *
 * @param {object} params
 * @param {{ nome?: string }} params.cliente       - Dados do cliente
 * @param {{ mes: number, ano: number }} params.periodo - Período do relatório
 * @param {object} params.operacional              - Payload de /v1/cliente/operacional
 * @param {{ sessoes: object[] }} params.sessoes   - Payload de /v1/cliente/sessoes
 * @returns {Promise<Buffer>}
 */
export async function buildRelatorioOperacionalPdf({ cliente, periodo, operacional, sessoes }) {
  const geradoEm = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date())

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size:    'A4',
      margins: { top: 10, bottom: 40, left: _OP_MARGIN, right: _OP_MARGIN },
      bufferPages: true,
      info: {
        Title:   'Relatório Operacional LiveLab',
        Author:  'LiveLab',
        Subject: `${_MESES_PT[periodo.mes] ?? periodo.mes} ${periodo.ano}`,
        Creator: 'LiveLab PDF Service',
      },
    })

    const chunks = []
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('end',  () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    _opDesenharCabecalho(doc, { cliente, periodo, geradoEm })
    _opDesenharConsolidado(doc, { operacional })
    _opDesenharStatus(doc, { operacional })
    _opDesenharTabela(doc, { sessoes: sessoes?.sessoes ?? sessoes ?? [] })
    _opDesenharRodape(doc)

    doc.end()
  })
}
