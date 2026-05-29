// src/routes/cep.js
// Resolve CEP → cidade/estado/coords. Nominatim NÃO indexa CEPs brasileiros
// confiavelmente, então fazemos 1) ViaCEP para cidade+estado+logradouro e
// 2) Nominatim com city=+state= como fallback para obter coordenadas.

export async function cepRoutes(app) {
  app.get('/v1/cep/:cep', { preHandler: app.authenticate }, async (request, reply) => {
    const cep = request.params.cep.replace(/\D/g, '')
    if (cep.length !== 8) {
      return reply.code(400).send({ error: 'CEP deve ter 8 dígitos' })
    }

    const { logradouro, cidade, estado } = await _fetchViaCep(cep)
    const { lat, lng } = await _geocode({ cidade, estado, logradouro })

    return { cep, logradouro, cidade, estado, lat, lng }
  })
}

// ─── Helpers exportados para reuso em outros routes (ex.: clientes.js) ───

export async function _fetchViaCep(cep) {
  try {
    const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return {}
    const data = await res.json()
    if (data.erro) return {}
    return {
      logradouro: data.logradouro || null,
      cidade: data.localidade || null,
      estado: data.uf || null,
    }
  } catch {
    return {}
  }
}

export async function _geocode({ cidade, estado, logradouro }) {
  // Nominatim com cidade+estado (funciona em 99% dos casos)
  if (!cidade || !estado) return { lat: null, lng: null }

  const tryQuery = async (qs) => {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?${qs}&format=json&limit=1`,
        {
          headers: { 'User-Agent': 'LiveShopSaaS/1.0 contact@liveshop.com.br' },
          signal: AbortSignal.timeout(5000),
        }
      )
      if (!res.ok) return null
      const data = await res.json()
      if (!Array.isArray(data) || data.length === 0) return null
      const lat = parseFloat(data[0].lat)
      const lng = parseFloat(data[0].lon)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
      return { lat, lng }
    } catch {
      return null
    }
  }

  // Tentativa 1: logradouro + cidade + estado (mais preciso)
  if (logradouro) {
    const q = `street=${encodeURIComponent(logradouro)}&city=${encodeURIComponent(cidade)}&state=${encodeURIComponent(estado)}&country=BR`
    const r = await tryQuery(q)
    if (r) return r
  }

  // Tentativa 2: cidade + estado (sempre resolve para grande maioria)
  const q2 = `city=${encodeURIComponent(cidade)}&state=${encodeURIComponent(estado)}&country=BR`
  const r2 = await tryQuery(q2)
  if (r2) return r2

  return { lat: null, lng: null }
}

/**
 * Resolve coordenadas a partir de um CEP (8 dígitos).
 * Usado pelo POST/PATCH de clientes quando o frontend só envia CEP.
 */
export async function resolveCepToGeo(cep) {
  const clean = (cep || '').replace(/\D/g, '')
  if (clean.length !== 8) return {}
  const { logradouro, cidade, estado } = await _fetchViaCep(clean)
  const { lat, lng } = await _geocode({ cidade, estado, logradouro })
  return { cep: clean, logradouro, cidade, estado, lat, lng }
}
