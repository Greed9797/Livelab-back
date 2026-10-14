import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

const destination = process.argv[2]
if (!destination) throw new Error('Informe o arquivo de destino; não use stdout para segredos')
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const secrets = {
  MCP_COOKIE_KEYS: JSON.stringify([randomBytes(48).toString('base64url')]),
  MCP_STORAGE_KEY: randomBytes(32).toString('base64'),
  MCP_JWKS: JSON.stringify({ keys: [{ ...privateKey.export({ format: 'jwk' }), kid: randomBytes(12).toString('hex'), alg: 'RS256', use: 'sig' }] }),
}
await writeFile(destination, JSON.stringify(secrets, null, 2), { mode: 0o600, flag: 'wx' })
process.stderr.write('Arquivo de segredos criado com permissão 0600. Os valores não foram impressos.\n')
