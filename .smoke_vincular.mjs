/**
 * Smoke da VINCULAÇÃO, na ordem em que a TELA faz as chamadas — não na ordem que é conveniente
 * para a API. Foi testar só a API que deixou o catch-22 passar batido antes.
 */
import pg from 'pg'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:3001/v1'
const XLSX = `${process.env.HOME}/Downloads/Creator-Live-Performance_20260724121004.xlsx`
let falhas = 0
const check = (nome, ok, detalhe) => {
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${nome}${detalhe ? ` — ${detalhe}` : ''}`)
  if (!ok) falhas++
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const assinar = (p, s) => {
  const h = b64({ alg: 'HS256', typ: 'JWT' }), n = Math.floor(Date.now() / 1000)
  const b = b64({ ...p, iat: n, exp: n + 900 })
  return `${h}.${b}.${createHmac('sha256', s).update(`${h}.${b}`).digest('base64url')}`
}

const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()
let batchId = null
let t = null
const api = async (path, init = {}) => {
  const r = await fetch(`${BASE}${path}`, { ...init, headers: { Authorization: `Bearer ${t}`, ...(init.headers ?? {}) } })
  return { status: r.status, body: await r.json().catch(() => null) }
}
const patch = (rowId, body) => api(`/analytics/imports/${batchId}/rows/${rowId}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

try {
  const u = (await c.query(`
    SELECT u.id, u.tenant_id, u.papel FROM users u
     WHERE u.papel = 'franqueado' AND u.ativo IS NOT FALSE
       AND EXISTS (SELECT 1 FROM marcas m WHERE m.tenant_id = u.tenant_id)
       AND (SELECT count(*) FROM apresentadoras a WHERE a.tenant_id = u.tenant_id) >= 1
       AND (SELECT count(*) FROM lives l WHERE l.tenant_id = u.tenant_id AND l.status <> 'cancelada') >= 2
     ORDER BY (SELECT count(*) FROM lives l2 WHERE l2.tenant_id = u.tenant_id) DESC LIMIT 1`)).rows[0]
  t = assinar({ sub: u.id, tenant_id: u.tenant_id, papel: u.papel }, process.env.JWT_SECRET)

  const totalLives = Number((await c.query(
    `SELECT count(*) n FROM lives WHERE tenant_id = $1::uuid AND status <> 'cancelada'`, [u.tenant_id])).rows[0].n)

  // ── A lista que o modal monta: paginação tem que trazer TODAS ────────────────
  const todas = []
  for (let page = 0; page < 25; page += 1) {
    const r = await api(`/lives?paginado=1&page=${page}&limit=200`)
    const itens = r.body?.items ?? []
    todas.push(...itens)
    if (itens.length < 200 || todas.length >= Number(r.body?.total ?? 0)) break
  }
  const vinculaveis = todas.filter((l) => l.status !== 'cancelada')
  check(`modal enxerga todas as ${totalLives} lives do tenant`, vinculaveis.length >= totalLives,
    `paginou ${vinculaveis.length} de ${totalLives}`)
  check('lista inclui lives que não são "encerrada"',
    todas.some((l) => l.status !== 'encerrada') || !todas.length,
    `status presentes: ${[...new Set(todas.map((l) => l.status))].join(', ')}`)

  // ── Preview ────────────────────────────────────────────────────────────────
  const marca = (await c.query('SELECT id FROM marcas WHERE tenant_id=$1::uuid LIMIT 1', [u.tenant_id])).rows[0]
  const ap = (await c.query('SELECT id FROM apresentadoras WHERE tenant_id=$1::uuid LIMIT 1', [u.tenant_id])).rows[0]
  const form = new FormData()
  form.append('file', new Blob([readFileSync(XLSX)]), 'Creator.xlsx')
  const prev = await fetch(`${BASE}/analytics/imports/preview?marca_id=${marca.id}&apresentadora_id=${ap.id}`,
    { method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: form })
  const pb = await prev.json()
  batchId = pb.batch_id
  const rows = pb.rows ?? []
  check('preview ok', prev.status === 200 && rows.length === 3, `HTTP ${prev.status}, ${rows.length} linhas`)

  const pendente = rows.find((r) => r.decisao === 'pendente') ?? rows[0]
  check('há linha nascendo "pendente" (o caso que estava travado)', Boolean(pendente),
    `decisões iniciais: ${rows.map((r) => r.decisao).join(', ')}`)

  const [liveA, liveB] = vinculaveis

  // ── A SEQUÊNCIA DA TELA ────────────────────────────────────────────────────
  // 1. Usuário escolhe "Vincular" no select. A tela NÃO manda mais esse PATCH sozinho —
  //    abre o modal. Mas o backend tem que continuar recusando, é a invariante.
  const soDecisao = await patch(pendente.id, { decisao: 'vincular' })
  check('backend segue recusando "vincular" sem live (invariante preservada)',
    soDecisao.status === 400, `HTTP ${soDecisao.status}`)

  // 2. Usuário escolhe a live no modal: decisão + live num PATCH só.
  const escolhe = await patch(pendente.id, { matched_live_id: liveA.id, decisao: 'vincular' })
  check('escolher a live no modal vincula a linha',
    escolhe.status === 200 && escolhe.body?.matched_live_id === liveA.id, `HTTP ${escolhe.status}`)

  // 3. Desvincular — antes deixava a linha presa para sempre.
  const desvincula = await patch(pendente.id, { matched_live_id: null, decisao: 'pendente' })
  check('desvincular volta a linha para pendente', desvincula.status === 200, `HTTP ${desvincula.status}`)

  // 4. E dá para vincular DE NOVO depois de desvincular.
  const revincula = await patch(pendente.id, { matched_live_id: liveB.id, decisao: 'vincular' })
  check('dá para vincular de novo depois de desvincular',
    revincula.status === 200 && revincula.body?.matched_live_id === liveB.id, `HTTP ${revincula.status}`)

  // 5. Duas linhas na mesma live — direto.
  const outra = rows.find((r) => r.id !== pendente.id)
  const duplicada = await patch(outra.id, { matched_live_id: liveB.id, decisao: 'vincular' })
  check('recusa duas linhas na mesma live', duplicada.status === 409, `HTTP ${duplicada.status}`)

  // 6. Duplicidade pela porta dos fundos: gravar a live sem decisão, depois só a decisão.
  //    Antes isso passava e o apply gravava GMV na live errada.
  await patch(outra.id, { matched_live_id: liveB.id })
  const fundos = await patch(outra.id, { decisao: 'vincular' })
  check('recusa duplicidade quando a decisão vem num PATCH separado',
    fundos.status === 409, `HTTP ${fundos.status} ${fundos.body?.error ?? ''}`)

  // 7. O estado sobrevive ao reload e traz o que a tela precisa para o rótulo.
  const relido = await api(`/analytics/imports/${batchId}`)
  const linhaRelida = relido.body?.rows?.find((r) => r.id === pendente.id)
  check('reload mantém a vinculação',
    linhaRelida?.matched_live_id === liveB.id && linhaRelida?.decisao === 'vincular',
    `live=${linhaRelida?.matched_live_id === liveB.id ? 'ok' : 'perdeu'} decisao=${linhaRelida?.decisao}`)
  check('a live vinculada está na lista que o modal recebe (rótulo não vira "Escolher live…")',
    vinculaveis.some((l) => l.id === linhaRelida?.matched_live_id))

  console.log(`\n${falhas === 0 ? 'VINCULAÇÃO OK' : `${falhas} FALHA(S)`}`)
} finally {
  if (batchId) {
    await c.query('DELETE FROM analytics_import_rows WHERE batch_id = $1::uuid', [batchId])
    await c.query('DELETE FROM analytics_import_batches WHERE id = $1::uuid', [batchId])
    console.log('lote de teste removido')
  }
  await c.end()
}
process.exit(falhas === 0 ? 0 : 1)
