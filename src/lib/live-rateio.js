/**
 * Rateio de uma live entre apresentadoras — escritor único.
 *
 * Vivia dentro de src/routes/analytics.js, alcançável só pelo import do TikTok. Saiu para cá
 * quando a edição da live passou a poder dividir uma live "em sequência de apresentadoras":
 * duas rotas gravando dinheiro com regras próprias é como o mesmo mês fecha com dois números.
 * Nada aqui mudou de comportamento na mudança de arquivo.
 */

/** Uma linha de rateio está no formato novo quando traz R$ ou tempo em vez de porcentagem. */
export function rateioAbsoluto(item) {
  return item?.gmv != null || item?.segundos != null
}

function round2(value) {
  return parseFloat(Number(value ?? 0).toFixed(2))
}

/** GMV oficial e duração da live — o que o rateio informado precisa fechar. */
export async function liveTotals(db, tenantId, liveId) {
  const q = await db.query(
    // Mesmo COALESCE de liveGmvSql (src/lib/metric-sql.js): o rateio tem que fechar contra o
    // GMV que os dashboards e a comissão enxergam, não contra outra coluna.
    `SELECT COALESCE(ads_gmv, manual_gmv, fat_gerado, 0)::numeric AS gmv,
            CASE WHEN encerrado_em IS NOT NULL
                 THEN ROUND(EXTRACT(EPOCH FROM (encerrado_em - iniciado_em)))::int
                 END AS segundos
       FROM lives WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [liveId, tenantId],
  )
  const row = q.rows[0]
  if (!row) throw new Error('Live nao encontrada para aplicar o rateio')
  return { gmvLive: round2(row.gmv ?? 0), segundosLive: row.segundos ?? null }
}

const formatBRL = (value) => Number(value).toFixed(2).replace('.', ',')
const formatHoras = (segundos) => `${Math.floor(segundos / 3600)}h${String(Math.round((segundos % 3600) / 60)).padStart(2, '0')}`

/**
 * Normaliza o rateio para { gmv, segundos, percentual } por apresentadora, validando contra os
 * totais da live. Aceita dois formatos:
 *  - absoluto (preferido): R$ e segundos digitados na revisão. A soma tem que bater com a live.
 *  - percentual (legado): percentuais que somam 100; R$ e segundos são derivados.
 * O percentual é sempre gravado junto porque parte do sistema ainda lê essa coluna.
 */
export function normalizarRateio(lista, { gmvLive, segundosLive }) {
  // Esta função grava dinheiro e é chamada também fora da rota (testes, scripts), então não
  // pode depender do Zod para barrar entrada torta.
  for (const item of lista) {
    for (const campo of ['gmv', 'segundos', 'percentual']) {
      const valor = item[campo]
      if (valor == null) continue
      if (!Number.isFinite(Number(valor))) throw new Error(`Valor invalido em ${campo} do rateio`)
      if (Number(valor) < 0) throw new Error(`Rateio nao aceita ${campo} negativo`)
    }
  }

  const usaAbsoluto = lista.some(rateioAbsoluto)
  // Metade por valor e metade por porcentagem daria a quem só mandou percentual um GMV zero.
  if (usaAbsoluto && !lista.every(rateioAbsoluto)) {
    throw new Error('Informe R$ e tempo para todas as apresentadoras, ou percentual para todas')
  }

  if (!usaAbsoluto) {
    const somaCentesimos = lista.reduce((acc, item) => acc + Math.round(Number(item.percentual ?? 0) * 100), 0)
    if (somaCentesimos !== 10000) {
      throw new Error(`Rateio das apresentadoras soma ${somaCentesimos / 100}% (precisa somar 100%)`)
    }
    return lista.map((item) => {
      const percentual = Number(item.percentual)
      return {
        apresentadora_id: item.apresentadora_id,
        percentual,
        gmv: round2(gmvLive * percentual / 100),
        segundos: segundosLive == null ? null : Math.round(segundosLive * percentual / 100),
      }
    })
  }

  const somaGmv = round2(lista.reduce((acc, item) => acc + Number(item.gmv ?? 0), 0))
  if (Math.abs(somaGmv - gmvLive) > 0.01) {
    throw new Error(`GMV do rateio soma R$ ${formatBRL(somaGmv)} e a live tem R$ ${formatBRL(gmvLive)}`)
  }

  // Tempo só é cobrado quando dá para cobrar: live ainda em andamento não tem duração fechada.
  const todosComTempo = lista.every((item) => item.segundos != null)
  if (todosComTempo && segundosLive != null) {
    const somaSegundos = lista.reduce((acc, item) => acc + Number(item.segundos), 0)
    // 60s de folga absorve o arredondamento de minuto da UI; não é margem de negócio.
    if (Math.abs(somaSegundos - segundosLive) > 60) {
      throw new Error(`Tempo do rateio soma ${formatHoras(somaSegundos)} e a live durou ${formatHoras(segundosLive)}`)
    }
  }

  return distribuirPercentuais(lista, { gmvLive, segundosLive })
}

/**
 * Deriva o percentual a partir dos valores absolutos, garantindo soma exata de 10000 centésimos
 * (percentual_rateio é NUMERIC(5,2)). A sobra do arredondamento vai para a maior linha — mesmo
 * critério do "distribuir igual" da tela. Live sem GMV rateia por tempo; sem tempo, divide igual.
 */
function distribuirPercentuais(lista, { gmvLive, segundosLive }) {
  const totalTempo = lista.reduce((acc, item) => acc + Number(item.segundos ?? 0), 0)
  const base = gmvLive > 0
    ? lista.map((item) => Number(item.gmv ?? 0) / gmvLive)
    : totalTempo > 0
      ? lista.map((item) => Number(item.segundos ?? 0) / totalTempo)
      : lista.map(() => 1 / lista.length)

  // O épsilon corrige o binário, não a conta: 0.4 * 10000 dá 3999.9999999999995 e o floor cru
  // devolveria 39.99% + 60.01% para uma divisão que é exatamente 40/60.
  const centesimos = base.map((fracao) => Math.floor(fracao * 10000 + 1e-6))
  const sobra = 10000 - centesimos.reduce((acc, value) => acc + value, 0)
  if (sobra !== 0) {
    const maior = centesimos.indexOf(Math.max(...centesimos))
    centesimos[maior] += sobra
  }

  return lista.map((item, index) => ({
    apresentadora_id: item.apresentadora_id,
    percentual: centesimos[index] / 100,
    gmv: round2(item.gmv ?? 0),
    segundos: item.segundos == null ? null : Math.round(Number(item.segundos)),
  }))
}

/**
 * Rateio da live entre apresentadoras. Substitui o conjunto anterior para que reimportar não
 * acumule linhas. `lives.apresentador_id` (users.id, legado) segue a apresentadora principal.
 */
export async function applyApresentadorasToLive(db, { tenantId, liveId, apresentadoras, duracaoPlanilha }) {
  const lista = Array.isArray(apresentadoras) ? apresentadoras.filter((item) => item?.apresentadora_id) : []
  if (lista.length === 0) return

  const totais = await liveTotals(db, tenantId, liveId)
  // A duração da planilha manda quando existe: numa linha 'vincular' o iniciado_em da live
  // cadastrada não é sobrescrito, então encerrado_em - iniciado_em pode não bater com o que a
  // tela mostrou ao dividir. Validar contra outro total do que o usuário viu seria recusar
  // um rateio correto.
  const rateio = normalizarRateio(lista, {
    ...totais,
    segundosLive: duracaoPlanilha ?? totais.segundosLive,
  })

  await db.query(
    'DELETE FROM live_apresentadoras_v2 WHERE tenant_id = $1::uuid AND live_id = $2::uuid',
    [tenantId, liveId],
  )
  // Principal = quem trouxe mais GMV; empate (ou live zerada) desempata por tempo.
  const principal = rateio.reduce((a, b) => {
    if (b.gmv !== a.gmv) return b.gmv > a.gmv ? b : a
    return Number(b.segundos ?? 0) > Number(a.segundos ?? 0) ? b : a
  })
  for (const item of rateio) {
    await db.query(
      `INSERT INTO live_apresentadoras_v2
         (tenant_id, live_id, apresentadora_id, papel, percentual_rateio, gmv_rateado, segundos_rateio)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)`,
      [
        tenantId,
        liveId,
        item.apresentadora_id,
        item.apresentadora_id === principal.apresentadora_id ? 'principal' : 'apoio',
        item.percentual,
        item.gmv,
        item.segundos,
      ],
    )
  }

  await db.query(
    `UPDATE lives
        SET apresentador_id = (SELECT user_id FROM apresentadoras WHERE id = $3::uuid AND tenant_id = $1::uuid)
      WHERE id = $2::uuid AND tenant_id = $1::uuid`,
    [tenantId, liveId, principal.apresentadora_id],
  )

  // calcularComissoesDaLive só faz upsert de quem está no rateio atual: sem esta limpeza, uma
  // apresentadora retirada continuaria com a venda antiga somando nos relatórios.
  // Linhas já aprovadas são imutáveis por regra de negócio e ficam.
  await db.query(
    `DELETE FROM vendas_atribuidas
      WHERE tenant_id = $1::uuid
        AND origem = 'live'
        AND origem_id = $2::uuid
        AND COALESCE(status_aprovacao, '') <> 'aprovada'
        AND (apresentadora_id IS NULL OR apresentadora_id <> ALL($3::uuid[]))`,
    [tenantId, liveId, lista.map((item) => item.apresentadora_id)],
  )
}
