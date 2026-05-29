// src/services/reports.js
// Geração de relatórios CSV (puro Node) e PDF (via pdfkit).
// Mantemos as funções puras: recebem rows/data prontos e devolvem string ou Buffer.

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
