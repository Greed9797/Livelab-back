const SAO_PAULO_TZ = 'America/Sao_Paulo'
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

function toNum(v) {
  if (v == null) return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function recordedCount(value) {
  if (value == null) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function liveVisualizacoes(live) {
  const manual = recordedCount(live?.manual_views)
  if (manual != null) return manual
  return recordedCount(live?.final_peak_viewers)
}

function liveImpressoes(live) {
  return recordedCount(live?.live_impressions)
}

function addRecorded(total, value) {
  if (value == null) return total
  return (total ?? 0) + value
}

function formatCount(value) {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(value)
}

function countFragment(value, singular, plural) {
  if (value == null) return null
  const n = Math.round(Number(value))
  return `${formatCount(n)} ${n === 1 ? singular : plural}`
}

export function formatMoneyBRL(value) {
  const n = toNum(value)
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
    .format(n)
    .replace(/\u00a0/g, ' ')
}

export function formatMinsToHours(mins) {
  const mTotal = Math.max(0, Math.round(toNum(mins)))
  const h = Math.floor(mTotal / 60)
  const m = mTotal % 60
  return `${h}h ${String(m).padStart(2, '0')}min`
}

export function formatSaoPauloDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(DATE_ONLY_RE.test(String(dateStr)) ? `${dateStr}T12:00:00-03:00` : dateStr)
  if (Number.isNaN(d.getTime())) return String(dateStr)

  const weekdayStr = new Intl.DateTimeFormat('pt-BR', {
    timeZone: SAO_PAULO_TZ,
    weekday: 'long',
  }).format(d)

  const dateFormatted = new Intl.DateTimeFormat('pt-BR', {
    timeZone: SAO_PAULO_TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d)

  const weekdayCapitalized = weekdayStr.charAt(0).toUpperCase() + weekdayStr.slice(1)
  return `${weekdayCapitalized}, ${dateFormatted}`
}

export function formatSaoPauloTimestamp(date) {
  const d = date instanceof Date ? date : new Date(date ?? Date.now())
  if (Number.isNaN(d.getTime())) return ''

  const dateParts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: SAO_PAULO_TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)

  // format: "DD/MM/YYYY, HH:mm" -> "DD/MM/YYYY às HH:mm"
  return dateParts.replace(', ', ' às ')
}

const RESUMO_SEPARATOR = '━━━━━━━━━━━━'

function liveGmv(live) {
  return toNum(live.gmv ?? live.ads_gmv ?? live.manual_gmv ?? live.fat_gerado)
}

function isLiveIncludedInSubtotal(live) {
  return live.registro_tipo !== 'submissao'
}

export function sumGmvResumoSubtotal(lives) {
  let total = 0
  for (const live of lives) {
    if (!isLiveIncludedInSubtotal(live)) continue
    total += liveGmv(live)
  }
  return Math.round(total * 100) / 100
}

function acumuladoMesLabel(emConciliacao, hasPendentes) {
  if (emConciliacao) return '*Acumulado do mês (em conciliação):*'
  if (hasPendentes) return '*Acumulado do mês (provisório):*'
  return '*Acumulado do mês:*'
}

export function buildResumoDia({ data, lives = [], livesMes = undefined, now = new Date() }) {
  const pendentes = lives.filter(live => live.registro_tipo === 'submissao' && live.revisao_status === 'pendente')
  const emConciliacao = pendentes.some(live => live.em_conciliacao)
  lives = lives.filter(isLiveIncludedInSubtotal)
  const totalLives = lives.length
  let totalGmv = 0
  let totalPedidos = 0
  let totalMinutos = 0

  const marcasMap = new Map()
  const apresentadorasMap = new Map()

  for (const live of lives) {
    const liveGmvValue = liveGmv(live)
    const livePedidos = toNum(live.pedidos ?? live.manual_orders ?? live.final_orders_count)

    let liveMins = 0
    if (live.iniciado_em && (live.encerrado_em || live.previsto_fim)) {
      const start = new Date(live.iniciado_em)
      const end = new Date(live.encerrado_em || live.previsto_fim)
      if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end > start) {
        liveMins = Math.min(1440, Math.floor((end.getTime() - start.getTime()) / 60000))
      }
    }

    totalGmv += liveGmvValue
    totalPedidos += livePedidos
    totalMinutos += liveMins

    // Agrupamento por Marca
    const marcaNome = (live.marca_nome || live.cliente_nome || 'Sem marca').trim()
    const marcaKey = marcaNome.toLowerCase()
    if (!marcasMap.has(marcaKey)) {
      marcasMap.set(marcaKey, {
        marca_id: live.marca_id || null,
        nome: marcaNome,
        gmv: 0,
        pedidos: 0,
        minutos: 0,
        lives_count: 0,
        visualizacoes: null,
        impressoes: null,
      })
    }
    const marcaObj = marcasMap.get(marcaKey)
    marcaObj.gmv += liveGmvValue
    marcaObj.pedidos += livePedidos
    marcaObj.minutos += liveMins
    marcaObj.lives_count += 1
    marcaObj.visualizacoes = addRecorded(marcaObj.visualizacoes, liveVisualizacoes(live))
    marcaObj.impressoes = addRecorded(marcaObj.impressoes, liveImpressoes(live))

    // Agrupamento por Apresentadora
    const hasRateioV2 = Array.isArray(live.apresentadoras) && live.apresentadoras.length > 0
    if (hasRateioV2) {
      for (const p of live.apresentadoras) {
        const pNome = (p.nome || 'Sem apresentadora').trim()
        const pKey = pNome.toLowerCase()
        if (!apresentadorasMap.has(pKey)) {
          apresentadorasMap.set(pKey, {
            apresentadora_id: p.apresentadora_id || null,
            nome: pNome,
            gmv: 0,
            minutos: 0,
            lives_count: 0,
          })
        }
        const apObj = apresentadorasMap.get(pKey)

        let pGmv = 0
        if (p.gmv != null) {
          pGmv = toNum(p.gmv)
        } else if (p.percentual != null) {
          pGmv = (liveGmvValue * toNum(p.percentual)) / 100
        } else if (p.papel === 'principal') {
          pGmv = liveGmvValue
        }

        let pMins = 0
        if (p.segundos != null && toNum(p.segundos) > 0) {
          pMins = Math.round(toNum(p.segundos) / 60)
        } else if (p.percentual != null) {
          pMins = Math.round((liveMins * toNum(p.percentual)) / 100)
        } else if (p.papel === 'principal') {
          pMins = liveMins
        }

        apObj.gmv += pGmv
        apObj.minutos += pMins
        apObj.lives_count += 1
      }
    } else {
      const pNome = (live.apresentadora_nome || live.apresentador_nome || 'Sem apresentadora').trim()
      const pKey = pNome.toLowerCase()
      if (!apresentadorasMap.has(pKey)) {
        apresentadorasMap.set(pKey, {
          apresentadora_id: live.apresentadora_id || null,
          nome: pNome,
          gmv: 0,
          minutos: 0,
          lives_count: 0,
        })
      }
      const apObj = apresentadorasMap.get(pKey)
      apObj.gmv += liveGmvValue
      apObj.minutos += liveMins
      apObj.lives_count += 1
    }
  }

  const totalHoras = totalMinutos / 60
  const totalGmvPorHora = totalHoras > 0 ? Math.round((totalGmv / totalHoras) * 100) / 100 : 0

  const marcas = [...marcasMap.values()]
    .map((m) => {
      const horas = m.minutos / 60
      const gmvPorHora = horas > 0 ? Math.round((m.gmv / horas) * 100) / 100 : 0
      return {
        ...m,
        gmv: Math.round(m.gmv * 100) / 100,
        horas: Math.round(horas * 100) / 100,
        horas_formatadas: formatMinsToHours(m.minutos),
        gmv_por_hora: gmvPorHora,
        visualizacoes: m.visualizacoes == null ? null : Math.round(m.visualizacoes),
        impressoes: m.impressoes == null ? null : Math.round(m.impressoes),
      }
    })
    .sort((a, b) => b.gmv - a.gmv || b.minutos - a.minutos || a.nome.localeCompare(b.nome))

  const apresentadoras = [...apresentadorasMap.values()]
    .map((a) => {
      const horas = a.minutos / 60
      const gmvPorHora = horas > 0 ? Math.round((a.gmv / horas) * 100) / 100 : 0
      return {
        ...a,
        gmv: Math.round(a.gmv * 100) / 100,
        horas: Math.round(horas * 100) / 100,
        horas_formatadas: formatMinsToHours(a.minutos),
        gmv_por_hora: gmvPorHora,
      }
    })
    .sort((a, b) => b.gmv - a.gmv || b.minutos - a.minutos || a.nome.localeCompare(b.nome))

  const dateFormatted = formatSaoPauloDate(data)
  const timestampFormatted = formatSaoPauloTimestamp(now)

  const acumuladoMesGmv = livesMes === undefined
    ? undefined
    : sumGmvResumoSubtotal(livesMes)

  // Montagem do texto para WhatsApp (Opção 2 - Mais arejado, alinhado à esquerda sem bullets)
  const separator = RESUMO_SEPARATOR
  const lines = [
    '📊 *RESUMO DO DIA — LIVES*',
    `📅 *Data:* ${dateFormatted}`,
    `🕒 *Consolidado em:* ${timestampFormatted}`,
    '',
    separator,
    '📈 *TOTAIS DO DIA*',
  ]

  if (totalLives === 0) {
    lines.push('Nenhuma live registrada neste dia.')
    lines.push(separator)
  } else {
    lines.push(`💰 *${emConciliacao ? 'Subtotal (em conciliação)' : pendentes.length ? 'GMV provisório' : 'GMV Total'}:* ${formatMoneyBRL(totalGmv)}`)
    lines.push(`⚡ *GMV/h:* ${formatMoneyBRL(totalGmvPorHora)}/h`)
    lines.push(`⏱️ *Tempo no Ar:* ${formatMinsToHours(totalMinutos)} (${totalLives} ${totalLives === 1 ? 'live' : 'lives'})`)
    if (acumuladoMesGmv !== undefined) {
      lines.push(`${acumuladoMesLabel(emConciliacao, pendentes.length > 0)} ${formatMoneyBRL(acumuladoMesGmv)}`)
    }
    lines.push('')

    lines.push(separator)
    lines.push('🏷️ *POR MARCA*')
    for (const m of marcas) {
      lines.push(`*${m.nome}*`)
      lines.push(`${formatMoneyBRL(m.gmv)} · ${m.horas_formatadas} · ${formatMoneyBRL(m.gmv_por_hora)}/h`)
      lines.push('')
    }
    if (lines[lines.length - 1] === '') lines.pop()

    lines.push(separator)
    lines.push('🎤 *POR APRESENTADORA*')
    for (const a of apresentadoras) {
      lines.push(`*${a.nome}*`)
      lines.push(`${formatMoneyBRL(a.gmv)} · ${a.horas_formatadas} · ${formatMoneyBRL(a.gmv_por_hora)}/h`)
      lines.push('')
    }
    if (lines[lines.length - 1] === '') lines.pop()
    lines.push(separator)
  }

  if (pendentes.length) {
    lines.push('', '*APRESENTADORA · Pendente aprovação*', 'Sem comissão antes da validação pela gestão.')
    for (const live of pendentes) lines.push(`${live.marca_nome ?? 'Marca'} · ${live.apresentadora_nome ?? 'Apresentadora'}: ${formatMoneyBRL(live.gmv)}${live.em_conciliacao ? ' — em conciliação; não somado ao subtotal' : ' — incluído no provisório'}`)
    if (emConciliacao) lines.push('Total consolidado indisponível até conferir os possíveis vínculos.')
  }
  const textoWhatsapp = lines.join('\n')

  return {
    data,
    data_formatada: dateFormatted,
    consolidado_em: (now instanceof Date ? now : new Date()).toISOString(),
    consolidado_em_formatado: timestampFormatted,
    totais: {
      em_conciliacao: emConciliacao,
      pendente_aprovacao: pendentes.length > 0,
      total_provisorio: emConciliacao ? null : Math.round(totalGmv * 100) / 100,
      gmv_pendente_aprovacao: Math.round(pendentes.reduce((sum, live) => sum + toNum(live.gmv), 0) * 100) / 100,
      gmv: Math.round(totalGmv * 100) / 100,
      pedidos: totalPedidos,
      minutos: totalMinutos,
      horas: Math.round(totalHoras * 100) / 100,
      horas_formatadas: formatMinsToHours(totalMinutos),
      gmv_por_hora: totalGmvPorHora,
      lives_count: totalLives,
      acumulado_mes: acumuladoMesGmv ?? null,
    },
    marcas,
    apresentadoras,
    texto_whatsapp: textoWhatsapp,
  }
}
