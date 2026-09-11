const SAO_PAULO_TZ = 'America/Sao_Paulo'
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

function toNum(v) {
  if (v == null) return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
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

export function buildResumoDia({ data, lives = [], now = new Date() }) {
  const totalLives = lives.length
  let totalGmv = 0
  let totalPedidos = 0
  let totalMinutos = 0

  const marcasMap = new Map()
  const apresentadorasMap = new Map()

  for (const live of lives) {
    const liveGmv = toNum(live.gmv ?? live.ads_gmv ?? live.manual_gmv ?? live.fat_gerado)
    const livePedidos = toNum(live.pedidos ?? live.manual_orders ?? live.final_orders_count)

    let liveMins = 0
    if (live.iniciado_em && (live.encerrado_em || live.previsto_fim)) {
      const start = new Date(live.iniciado_em)
      const end = new Date(live.encerrado_em || live.previsto_fim)
      if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end > start) {
        liveMins = Math.min(1440, Math.floor((end.getTime() - start.getTime()) / 60000))
      }
    }

    totalGmv += liveGmv
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
      })
    }
    const marcaObj = marcasMap.get(marcaKey)
    marcaObj.gmv += liveGmv
    marcaObj.pedidos += livePedidos
    marcaObj.minutos += liveMins
    marcaObj.lives_count += 1

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
          pGmv = (liveGmv * toNum(p.percentual)) / 100
        } else if (p.papel === 'principal') {
          pGmv = liveGmv
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
      apObj.gmv += liveGmv
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

  // Montagem do texto para WhatsApp (Opção 2 - Mais arejado, alinhado à esquerda sem bullets)
  const separator = '━━━━━━━━━━━━━━━━━━━━'
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
    lines.push(`💰 *GMV Total:* ${formatMoneyBRL(totalGmv)}`)
    lines.push(`⚡ *GMV/h:* ${formatMoneyBRL(totalGmvPorHora)}/h`)
    lines.push(`🛒 *Vendas:* ${totalPedidos} ${totalPedidos === 1 ? 'pedido' : 'pedidos'}`)
    lines.push(`⏱️ *Tempo no Ar:* ${formatMinsToHours(totalMinutos)} (${totalLives} ${totalLives === 1 ? 'live' : 'lives'})`)
    lines.push('')

    lines.push(separator)
    lines.push('🏷️ *POR MARCA*')
    for (const m of marcas) {
      lines.push(`*${m.nome}*`)
      const pedidosStr = `${m.pedidos} ${m.pedidos === 1 ? 'pedido' : 'pedidos'}`
      lines.push(`${formatMoneyBRL(m.gmv)} · ${m.horas_formatadas} · ${formatMoneyBRL(m.gmv_por_hora)}/h · ${pedidosStr}`)
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

  const textoWhatsapp = lines.join('\n')

  return {
    data,
    data_formatada: dateFormatted,
    consolidado_em: (now instanceof Date ? now : new Date()).toISOString(),
    consolidado_em_formatado: timestampFormatted,
    totais: {
      gmv: Math.round(totalGmv * 100) / 100,
      pedidos: totalPedidos,
      minutos: totalMinutos,
      horas: Math.round(totalHoras * 100) / 100,
      horas_formatadas: formatMinsToHours(totalMinutos),
      gmv_por_hora: totalGmvPorHora,
      lives_count: totalLives,
    },
    marcas,
    apresentadoras,
    texto_whatsapp: textoWhatsapp,
  }
}
