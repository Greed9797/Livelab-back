export function mergeWatchedIntervals(existing = [], incoming = []) {
  const ranges = [...existing, ...incoming].map(([start, end]) => [Number(start), Number(end)])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged = []
  for (const [start, end] of ranges) {
    const previous = merged.at(-1)
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end)
    else merged.push([start, end])
  }
  return merged
}

export function watchedPercent(intervals, durationSeconds) {
  if (!durationSeconds) return 0
  const watched = intervals.reduce((total, [start, end]) => total + end - start, 0)
  return Math.min(100, watched / durationSeconds * 100)
}

export function videoSource(provider, input, explicitLibraryId) {
  if (provider === 'youtube') {
    let id = input
    if (/^https?:\/\//i.test(input)) {
      let url
      try { url = new URL(input) } catch { return null }
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
      const host = url.hostname.toLowerCase().replace(/^www\./, '')
      if (host === 'youtu.be') id = url.pathname.slice(1)
      else if (host === 'youtube.com' || host === 'm.youtube.com') {
        id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/)?.[1]
      } else if (host === 'youtube-nocookie.com') id = url.pathname.match(/^\/embed\/([^/]+)/)?.[1]
      else return null
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id ?? '') ? { provider, id, libraryId: null, url: `https://www.youtube-nocookie.com/embed/${id}` } : null
  }
  if (provider === 'panda') {
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
    let id = input
    let libraryId = explicitLibraryId
    if (/^https?:\/\//i.test(input)) {
      let url
      try { url = new URL(input) } catch { return null }
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
      const host = url.hostname.match(/^player-([A-Za-z0-9_-]+)\.tv\.pandavideo\.com\.br$/i)
      if (!host || !/^\/embed\/?$/.test(url.pathname)) return null
      id = url.searchParams.get('v')
      if (libraryId && libraryId !== host[1]) return null
      libraryId = host[1]
    }
    if (!(new RegExp(`^${uuid}$`, 'i')).test(id ?? '') || !/^[A-Za-z0-9_-]{1,128}$/.test(libraryId ?? '')) return null
    return { provider, id, libraryId, url: `https://player-${libraryId}.tv.pandavideo.com.br/embed/?v=${id}` }
  }
  return null
}
