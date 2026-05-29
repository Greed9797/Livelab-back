import { z } from 'zod'
import { READ_CLIENTES, WRITE_APRESENTADORAS, WRITE_CLIENTES, WRITE_CONFIGURACOES } from '../config/role_groups.js'
import { uploadTenantImage } from '../lib/image_upload.js'

const folderSchema = z.object({
  folder: z.enum(['apresentadoras', 'clientes', 'marcas', 'logos']).optional().default('logos'),
})

export async function uploadsRoutes(app) {
  const allowedRoles = Array.from(new Set([
    ...WRITE_APRESENTADORAS,
    ...WRITE_CLIENTES,
    ...WRITE_CONFIGURACOES,
    ...READ_CLIENTES,
  ]))

  app.post('/v1/uploads/image', {
    preHandler: [app.authenticate, app.requirePapel(allowedRoles)],
  }, async (request, reply) => {
    const parsed = folderSchema.safeParse(request.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message })
    return uploadTenantImage(request, reply, { folder: parsed.data.folder })
  })
}
