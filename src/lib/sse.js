/**
 * Espera o cliente encerrar uma conexão SSE.
 *
 * A armadilha que isto existe para fechar: entre o `await` de validação da rota e o
 * registro do `once('close')` existe uma janela. Se o navegador aborta dentro dela — o
 * que acontece o tempo todo quando o usuário troca de tela — o evento 'close' JÁ passou,
 * e um `once('close')` registrado depois nunca dispara. A Promise fica pendente para
 * sempre, e com ela o listener do emitter, o setInterval do heartbeat e todo o closure
 * do handler.
 *
 * Não é vazamento teórico: `tiktok-connector-manager.js` chama `setMaxListeners(0)` no
 * emitter, o que desliga o único alarme nativo do Node para acúmulo de listener. O
 * processo cresce em silêncio até o container estourar memória e o Railway matá-lo —
 * derrubando todos os usuários de uma vez.
 *
 * `destroyed` e não `aborted`: `request.aborted` está deprecado no Node moderno.
 */
export function esperarDesconexao(request) {
  return new Promise((resolve) => {
    if (request.raw.destroyed) return resolve()
    // resolve() envolvido: passar `resolve` direto faria a Promise resolver COM o Error
    // do evento 'error'. Ninguém usa esse valor hoje, mas "esperou desconectar" que
    // devolve um Error é uma armadilha para o próximo que escrever `if (await ...)`.
    request.raw.once('close', () => resolve())
    request.raw.once('error', () => resolve())
  })
}
