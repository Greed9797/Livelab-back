import crypto from 'node:crypto'

export const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

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

  const tenantId = request.user?.tenant_id ?? 'public'
  const ext = data.mimetype.split('/')[1].replace('jpeg', 'jpg')
  const safeFolder = String(folder).replace(/[^a-z0-9/_-]/gi, '').replace(/^\/+|\/+$/g, '') || 'uploads'
  const filename = `${safeFolder}/${tenantId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`
  const bucket = 'tenant-assets'

  const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${filename}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': data.mimetype,
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
    content_type: data.mimetype,
    size: buffer.length,
  }
}
