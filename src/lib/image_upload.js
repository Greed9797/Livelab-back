import crypto from 'node:crypto'

export const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

// O mimetype declarado no multipart é controlado pelo cliente — confiar nele
// permite subir executável/SVG-com-script rotulado como image/png. Confere a
// assinatura binária real do arquivo.
function sniffImageMime(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif'
  return null
}

export async function uploadTenantImage(request, reply, { folder = 'uploads', maxBytes = 5 * 1024 * 1024 } = {}) {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY
  if (!supabaseUrl || !supabaseKey) {
    return reply.code(503).send({ error: 'Armazenamento de imagens não configurado no servidor.' })
  }

  const data = await request.file()
  if (!data) return reply.code(400).send({ error: 'Nenhum arquivo enviado.' })
  if (!ALLOWED_IMAGE_MIME.includes(data.mimetype)) {
    return reply.code(400).send({ error: 'Formato não suportado. Use JPEG, PNG, WebP ou GIF.' })
  }

  const chunks = []
  for await (const chunk of data.file) chunks.push(chunk)
  const buffer = Buffer.concat(chunks)
  if (buffer.length > maxBytes) {
    return reply.code(400).send({ error: `Imagem muito grande. Máximo ${Math.round(maxBytes / 1024 / 1024)} MB.` })
  }

  // Fonte da verdade é a assinatura binária, não o mimetype declarado.
  const realMime = sniffImageMime(buffer)
  if (!realMime || !ALLOWED_IMAGE_MIME.includes(realMime)) {
    return reply.code(400).send({ error: 'Arquivo não é uma imagem válida. Use JPEG, PNG, WebP ou GIF.' })
  }

  const tenantId = request.user?.tenant_id ?? 'public'
  const ext = realMime.split('/')[1].replace('jpeg', 'jpg')
  const safeFolder = String(folder).replace(/[^a-z0-9/_-]/gi, '').replace(/^\/+|\/+$/g, '') || 'uploads'
  const filename = `${safeFolder}/${tenantId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`
  const bucket = 'tenant-assets'

  const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${filename}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': realMime,
      'x-upsert': 'true',
    },
    body: buffer,
  })

  if (!uploadRes.ok) {
    const err = await uploadRes.text().catch(() => '')
    request.log.error({ err }, 'Supabase Storage upload failed')
    return reply.code(500).send({ error: 'Falha ao salvar imagem. Tente novamente.' })
  }

  return {
    url: `${supabaseUrl}/storage/v1/object/public/${bucket}/${filename}`,
    content_type: realMime,
    size: buffer.length,
  }
}
