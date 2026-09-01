/**
 * Turnos de apresentadora (revezamento) de um evento de agenda → rateio inicial da live.
 *
 * Núcleo puro: não conhece Fastify, reply nem request. Quem chama é quem abre a live —
 * agenda_autostart.js, POST /v1/lives e POST /v1/lives/manual — e os três precisam do
 * MESMO critério de principal e de percentual, senão a mesma live fecha com dois números
 * dependendo de por onde abriu. Mesma razão de live-rateio.js ser escritor único do
 * rateio pós-live: aqui é o escritor único do rateio PLANEJADO.
 */

import { normalizarRateio } from './live-rateio.js'

/**
 * Colapsa turnos por apresentadora e devolve papel + percentual planejado.
 *
 * NAO devolve gmv nem segundos de proposito. Ambos sao os PRIMEIROS degraus do
 * COALESCE dos rollups (src/lib/performance-rollups.js:224-232 e :240-249):
 *  - gravar gmv_rateado = 0 zeraria o GMV de todo mundo no ranking (0 nao e NULL);
 *  - gravar segundos_rateio = tempo PLANEJADO congelaria as horas no palpite —
 *    uma live agendada 14-18 que roda ate 19h reportaria 4h para sempre, e horas
 *    alimenta GMV/h, meta e ranking.
 * Com os dois NULL, a cascata cai em `gmv_live * percentual/100` e
 * `duracao_real * percentual/100`: divide certo e se autocorrige ao encerrar.
 */
export function calcularRateioPlanejado(turnos) {
  const porPessoa = new Map()
  for (const t of turnos ?? []) {
    const id = t?.apresentadora_id
    if (!id) continue
    const ini = new Date(t.data_inicio).getTime()
    const fim = new Date(t.data_fim).getTime()
    if (!Number.isFinite(ini) || !Number.isFinite(fim) || fim <= ini) continue
    const atual = porPessoa.get(id) ?? { apresentadora_id: id, segundos: 0, inicio: ini }
    atual.segundos += Math.round((fim - ini) / 1000)
    atual.inicio = Math.min(atual.inicio, ini)
    porPessoa.set(id, atual)
  }

  // Ordem determinista: quem comeca antes; empate por uuid. O seed grava nesta ordem.
  const linhas = [...porPessoa.values()].sort(
    (a, b) => a.inicio - b.inicio || (a.apresentadora_id < b.apresentadora_id ? -1 : 1),
  )
  if (linhas.length === 0) return []
  // Uma apresentadora so: percentual null mantem o INSERT identico ao de hoje.
  if (linhas.length === 1) return [{ apresentadora_id: linhas[0].apresentadora_id, papel: 'principal', percentual: null }]

  // segundosLive = SOMA dos turnos, nao a duracao do evento: turno sobreposto
  // (co-apresentacao) ou cobertura parcial fariam a tolerancia de 60s de
  // normalizarRateio recusar um plano legitimo. O que importa aqui sao as fracoes.
  const total = linhas.reduce((acc, l) => acc + l.segundos, 0)
  const rateio = normalizarRateio(
    linhas.map((l) => ({ apresentadora_id: l.apresentadora_id, segundos: l.segundos })),
    { gmvLive: 0, segundosLive: total },
  )

  let principal = 0
  for (let i = 1; i < linhas.length; i++) if (linhas[i].segundos > linhas[principal].segundos) principal = i
  return rateio.map((r, i) => ({
    apresentadora_id: r.apresentadora_id,
    papel: i === principal ? 'principal' : 'apoio',
    percentual: r.percentual,
  }))
}

/**
 * Semeia live_apresentadoras_v2 a partir dos turnos do evento.
 * Devolve o numero de linhas escritas (0 quando nao havia com que semear).
 *
 * NUNCA lanca por causa da leitura dos turnos: e chamado dentro da transacao do
 * agenda_autostart (src/jobs/agenda_autostart.js:97-233), onde uma excecao aborta a
 * abertura da live inteira e reverte cabine + evento. Qualquer falha cai no insert de hoje.
 *
 * `apresentadoraConfirmadaId` (opcional) e a apresentadora que o operador declarou no
 * FECHAMENTO — ver o bloco que a usa mais abaixo.
 */
export async function seedRateioPlanejado(db, { tenantId, liveId, agendaEventoId, apresentadoraFallbackId, apresentadoraConfirmadaId, log }) {
  let linhas = []
  if (agendaEventoId) {
    // SAVEPOINT, e nao so try/catch: os tres chamadores rodam DENTRO de uma transacao
    // (agenda_autostart.js:98, lives.js:368 e lives.js:798). No Postgres qualquer erro
    // dentro de um bloco de transacao poe a sessao em estado abortado, e toda query
    // seguinte falha com 25P02 ate um ROLLBACK — entao um catch nu aqui nao salvaria
    // ninguem: o INSERT de fallback logo abaixo estouraria e derrubaria a abertura da
    // live inteira, exatamente o que este seed promete nunca fazer. Mesmo padrao de
    // "best effort dentro de transacao" ja usado em billing_engine.js e analytics.js.
    //
    // O SAVEPOINT so falha fora de transacao (25P01); nesse caso nao ha o que desfazer e
    // a leitura segue sem ele.
    const comSavepoint = await db.query('SAVEPOINT agenda_turnos_seed').then(() => true, () => false)
    try {
      const q = await db.query(
        `SELECT apresentadora_id, data_inicio, data_fim
           FROM agenda_evento_apresentadoras
          WHERE agenda_evento_id = $1::uuid AND tenant_id = $2::uuid
          ORDER BY data_inicio ASC, apresentadora_id ASC`,
        [agendaEventoId, tenantId],
      )
      linhas = calcularRateioPlanejado(q.rows)
      if (comSavepoint) await db.query('RELEASE SAVEPOINT agenda_turnos_seed')
    } catch (err) {
      if (comSavepoint) await db.query('ROLLBACK TO SAVEPOINT agenda_turnos_seed').catch(() => {})
      log?.warn?.({ err, agendaEventoId }, '[agenda-turnos] falha ao ler turnos — caindo no insert simples')
      linhas = []
    }
  }

  // Fechamento manual: o operador declara quem REALMENTE apresentou, e essa informacao e
  // mais nova que o plano. Se ela nao esta entre os turnos, o plano virou ficcao — manter
  // o rateio planejado daria 100% do GMV e da comissao para quem nao apresentou (os
  // percentuais planejados ja somam 1.0, entao commission-engine.js:148-152 deixa quem
  // sobra com R$ 0,00). Quando ela esta no plano, o plano vale: um campo escalar so nomeia
  // a principal, nao desfaz o revezamento.
  if (apresentadoraConfirmadaId && linhas.length > 0 && !linhas.some((l) => l.apresentadora_id === apresentadoraConfirmadaId)) {
    log?.warn?.(
      { agendaEventoId, apresentadoraConfirmadaId },
      '[agenda-turnos] apresentadora informada no fechamento nao esta nos turnos — rateio planejado descartado',
    )
    linhas = []
  }

  // Caminho de hoje, byte a byte (3 parametros). test/lives_start.test.js:132 fixa
  // exatamente este INSERT — nao trocar por versao com papel: o DEFAULT ja e 'principal'.
  if (linhas.length <= 1) {
    const id = linhas[0]?.apresentadora_id ?? apresentadoraFallbackId
    if (!id) return 0
    await db.query(
      `INSERT INTO live_apresentadoras_v2 (tenant_id, live_id, apresentadora_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (live_id, apresentadora_id) DO NOTHING`,
      [tenantId, liveId, id],
    )
    return 1
  }

  for (const l of linhas) {
    await db.query(
      `INSERT INTO live_apresentadoras_v2
         (tenant_id, live_id, apresentadora_id, papel, percentual_rateio)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
       ON CONFLICT (live_id, apresentadora_id) DO NOTHING`,
      [tenantId, liveId, l.apresentadora_id, l.papel, l.percentual],
    )
  }
  return linhas.length
}
