import Fastify from 'fastify'
import { execFile, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { ROTAS_API_KEY, chaveAlcancaRota } from '../src/plugins/auth.js'

// A CLI roda de verdade (python3 + stdlib) contra um Fastify que ecoa o que recebeu.
const CLI = new URL('../cli/livelab.py', import.meta.url).pathname
const temPython = spawnSync('python3', ['--version']).status === 0
const CHAVE = 'llk_teste_nao_pode_vazar_em_lugar_nenhum'
const UUID = '66666666-6666-4666-8666-666666666666'

let app
let base
let recebidas = []
const dir = mkdtempSync(join(tmpdir(), 'livelab-cli-'))

beforeAll(async () => {
  app = Fastify()
  app.all('/v1/*', async (req, reply) => {
    recebidas.push({ method: req.method, url: req.url, headers: req.headers, body: req.body ?? null })
    if (req.url.startsWith('/v1/proibida')) return reply.code(403).send({ error: 'Forbidden' })
    if (req.url.startsWith('/v1/quebrada')) return reply.code(500).send({ error: 'boom' })
    return { ok: true, method: req.method, url: req.url }
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  base = `http://127.0.0.1:${app.server.address().port}`
})
afterAll(() => app.close())
beforeEach(() => { recebidas = [] })

// spawnSync travaria o event loop que serve o Fastify falso — a CLI ficaria
// esperando uma resposta que nunca sai. Por isso execFile assíncrono.
function cli(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    execFile('python3', [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, LIVELAB_API_KEY: CHAVE, LIVELAB_API_URL: base, ...env },
    }, (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr }))
  })
}
const ultima = () => recebidas[recebidas.length - 1]

describe.skipIf(!temPython)('cli/livelab.py', () => {
  it('sem LIVELAB_API_KEY sai com 2 e diz o que falta', async () => {
    const r = await cli(['api', 'GET', '/v1/lives'], { env: { LIVELAB_API_KEY: '' } })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('LIVELAB_API_KEY não definida')
    expect(recebidas).toHaveLength(0)
  })

  it('api GET monta a query, manda a chave no header e imprime o body no stdout', async () => {
    const r = await cli(['api', 'GET', '/v1/lives', '-q', 'data_inicio=2026-09-01', '-q', 'status=encerrada'])
    expect(r.status).toBe(0)
    expect(ultima().url).toBe('/v1/lives?data_inicio=2026-09-01&status=encerrada')
    expect(ultima().headers['x-api-key']).toBe(CHAVE)
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, method: 'GET', url: '/v1/lives?data_inicio=2026-09-01&status=encerrada' })
  })

  it('api POST -d manda o body como application/json', async () => {
    const r = await cli(['api', 'POST', '/v1/marcas', '-d', '{"nome":"Marca X","tipo":"afiliada"}'])
    expect(r.status).toBe(0)
    expect(ultima().method).toBe('POST')
    expect(ultima().headers['content-type']).toBe('application/json')
    expect(ultima().body).toEqual({ nome: 'Marca X', tipo: 'afiliada' })
  })

  it('api PATCH -f lê o body de arquivo', async () => {
    const arquivo = join(dir, 'corpo.json')
    writeFileSync(arquivo, '{"observacoes":"via cli"}')
    const r = await cli(['api', 'PATCH', `/v1/lives/${UUID}`, '-f', arquivo])
    expect(r.status).toBe(0)
    expect(ultima().method).toBe('PATCH')
    expect(ultima().url).toBe(`/v1/lives/${UUID}`)
    expect(ultima().body).toEqual({ observacoes: 'via cli' })
  })

  it('rota sem /v1 na frente ganha o prefixo', async () => {
    const r = await cli(['api', 'GET', 'lives'])
    expect(r.status).toBe(0)
    expect(ultima().url).toBe('/v1/lives')
  })

  it('ingest manda filename, content_base64 e os campos; --preview troca a rota', async () => {
    const csv = 'MARCA,Start time\nHAAG,46170\n'
    const arquivo = join(dir, 'relatorio.csv')
    writeFileSync(arquivo, csv)

    const r = await cli(['ingest', arquivo, '--marca-id', UUID, '--apresentadora-id', UUID, '--criar-lives'])
    expect(r.status).toBe(0)
    expect(ultima().url).toBe('/v1/analytics/imports/ingest')
    expect(ultima().body.filename).toBe('relatorio.csv')
    expect(Buffer.from(ultima().body.content_base64, 'base64').toString()).toBe(csv)
    expect(ultima().body).toMatchObject({ marca_id: UUID, apresentadora_id: UUID, criar_lives: true })

    const p = await cli(['ingest', arquivo, '--preview'])
    expect(p.status).toBe(0)
    expect(ultima().url).toBe('/v1/analytics/imports/preview')
    expect(ultima().body).not.toHaveProperty('criar_lives')
    expect(ultima().body).not.toHaveProperty('marca_id')
  })

  it('ingest recusa arquivo acima de 5 MB antes de mandar, com saída 2', async () => {
    const arquivo = join(dir, 'grande.csv')
    writeFileSync(arquivo, Buffer.alloc(5 * 1024 * 1024 + 1, 0x41))
    const r = await cli(['ingest', arquivo])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('teto')
    expect(recebidas).toHaveLength(0)
  })

  it('status fora de 2xx sai com 1 e imprime {"status","error"} no stderr', async () => {
    const r = await cli(['api', 'GET', '/v1/quebrada'])
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(JSON.parse(r.stderr.trim())).toEqual({ status: 500, error: { error: 'boom' } })
  })

  it('403 acrescenta a dica de olhar as rotas liberadas', async () => {
    const r = await cli(['api', 'POST', '/v1/proibida'])
    expect(r.status).toBe(1)
    const [linha1, linha2] = r.stderr.trim().split('\n')
    expect(JSON.parse(linha1)).toEqual({ status: 403, error: { error: 'Forbidden' } })
    expect(linha2).toBe('rota não liberada para chave de API — veja: livelab rotas')
  })

  it('erro de rede sai com 3', async () => {
    const r = await cli(['api', 'GET', '/v1/lives'], { env: { LIVELAB_API_URL: 'http://127.0.0.1:1' } })
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('erro de rede')
  })

  it('rotas lista só o que a allowlist libera, incluindo POST /v1/lives/manual', async () => {
    const r = await cli(['rotas'])
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^POST\s+\/v1\/lives\/manual\s/m)
    const linhas = r.stdout.trim().split('\n')
    expect(linhas.length).toBeGreaterThanOrEqual(10)
    for (const linha of linhas) {
      const [metodo, rota] = linha.trim().split(/\s+/)
      expect(chaveAlcancaRota(metodo, rota.replace(':id', UUID)), linha).toBe(true)
    }
    // e a volta: toda entrada da allowlist tem pelo menos uma linha na CLI
    const listadas = linhas.map((l) => l.trim().split(/\s+/).slice(0, 2))
    for (const [metodo, rota] of ROTAS_API_KEY) {
      const alguma = listadas.some(([m, r]) => m === metodo && r.replace(':id', UUID).startsWith(rota))
      expect(alguma, `${metodo} ${rota} sem linha em 'livelab rotas'`).toBe(true)
    }
  })

  it('--verbose mostra método, URL e status, e a chave nunca aparece', async () => {
    const ok = await cli(['--verbose', 'api', 'GET', '/v1/lives'])
    expect(ok.status).toBe(0)
    expect(ok.stderr).toContain(`GET ${base}/v1/lives -> 200`)
    const recusado = await cli(['api', 'POST', '/v1/proibida', '--verbose'])
    for (const saida of [ok.stdout, ok.stderr, recusado.stdout, recusado.stderr]) {
      expect(saida).not.toContain(CHAVE)
    }
  })

  it('--help lista os comandos e cada comando explica seus campos', async () => {
    const geral = await cli(['--help'])
    expect(geral.status).toBe(0)
    for (const c of ['api', 'ingest', 'rotas']) expect(geral.stdout).toContain(c)
    const ing = await cli(['ingest', '--help'])
    expect(ing.status).toBe(0)
    for (const f of ['--marca-id', '--apresentadora-id', '--criar-lives', '--preview']) expect(ing.stdout).toContain(f)
  })

  it('comandos nomeados traduzem para método e rota e delegam ao mesmo caminho', async () => {
    const criar = await cli(['lives', 'criar', '-d', '{"cabine_id":"x","data":"2026-09-01"}'])
    expect(criar.status).toBe(0)
    expect(ultima()).toMatchObject({ method: 'POST', url: '/v1/lives/manual', body: { cabine_id: 'x', data: '2026-09-01' } })

    const editar = await cli(['marcas', 'editar', UUID, '-d', '{"status":"pausada"}'])
    expect(editar.status).toBe(0)
    expect(ultima()).toMatchObject({ method: 'PATCH', url: `/v1/marcas/${UUID}`, body: { status: 'pausada' } })

    const lista = await cli(['lives', 'list', '-q', 'status=encerrada'])
    expect(lista.status).toBe(0)
    expect(ultima()).toMatchObject({ method: 'GET', url: '/v1/lives?status=encerrada' })

    const lote = await cli(['imports', 'get', UUID])
    expect(lote.status).toBe(0)
    expect(ultima()).toMatchObject({ method: 'GET', url: `/v1/analytics/imports/${UUID}` })

    const semId = await cli(['lives', 'get'])
    expect(semId.status).toBe(2)
    expect(semId.stderr).toContain('precisa do id')
  })

  it('--help de cada comando nomeado descreve os campos do body', async () => {
    const r = await cli(['marcas', '--help'])
    expect(r.status).toBe(0)
    for (const campo of ['nome', 'tipo', 'cliente_id', 'comissao_franquia_pct']) expect(r.stdout).toContain(campo)
    const l = await cli(['lives', '--help'])
    for (const campo of ['/v1/lives/manual', 'hora_inicio', 'fat_gerado', 'ads_gmv']) expect(l.stdout).toContain(campo)
  })
})
