/**
 * Monitor de 30 minutos: bate no /home/dashboard no mesmo ritmo do app (30s) e registra
 * TODO ciclo em que algum número diverge do banco. Se o sintoma "abre e está zerado" voltar,
 * fica gravado com o horário e o valor exato.
 */
const pg = require('pg')
const { createHmac } = require('node:crypto')
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const sign = (p, s) => {
  const h = b64({ alg: 'HS256', typ: 'JWT' }), n = Math.floor(Date.now() / 1000)
  const b = b64({ ...p, iat: n, exp: n + 14400 })
  return `${h}.${b}.${createHmac('sha256', s).update(`${h}.${b}`).digest('base64url')}`
}
const A = '394b446a-bdae-4234-aac5-72021e6f15aa'
const DUR = Number(process.env.MON_MS ?? 1_800_000)

;(async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  const u = (await c.query(`SELECT id,tenant_id,papel FROM users WHERE tenant_id=$1::uuid AND papel='franqueado' LIMIT 1`, [A])).rows[0]
  await c.end()
  const tok = sign({ sub: u.id, tenant_id: u.tenant_id, papel: u.papel }, process.env.JWT_SECRET)

  // referência do banco, relida a cada ciclo (o dado muda: lives entram e saem)
  const doBanco = async () => {
    const cc = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await cc.connect()
    const r = await cc.query(`SELECT
        COALESCE(SUM(COALESCE(ads_gmv,manual_gmv,fat_gerado,0)),0)::numeric(14,2)::text gmv,
        count(*)::int lives
      FROM lives WHERE tenant_id=$1::uuid AND status='encerrada'
        AND iniciado_em >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')`, [A])
    await cc.end()
    return r.rows[0]
  }

  const inicio = Date.now()
  let ciclos = 0, divergencias = 0, erros = 0
  const registro = []
  console.log(`monitor de ${Math.round(DUR / 60000)} min · ciclo a cada 30s\n`)

  while (Date.now() - inicio < DUR) {
    const min = ((Date.now() - inicio) / 60000).toFixed(1)
    try {
      const r = await fetch('http://127.0.0.1:3001/v1/home/dashboard', { headers: { Authorization: `Bearer ${tok}` } })
      const j = await r.json().catch(() => ({}))
      ciclos += 1
      if (r.status !== 200) {
        erros += 1
        registro.push(`${min}min HTTP ${r.status}`)
        console.log(`  ${min}min · HTTP ${r.status}  <<< ERRO`)
      } else {
        const esperado = await doBanco()
        const gmv = Number(j.gmv_mes ?? -1)
        const horas = Number(j.horas_live_mes ?? -1)
        const lives = Number(j.lives_mes ?? -1)
        const serie = (j.gmv_diario_mes || []).reduce((a, d) => a + Number(d.gmv || 0), 0)
        const bate = Math.abs(gmv - Number(esperado.gmv)) < 0.05 && lives === esperado.lives && horas > 0
        if (!bate) {
          divergencias += 1
          registro.push(`${min}min gmv=${gmv} (banco ${esperado.gmv}) lives=${lives} (banco ${esperado.lives}) horas=${horas}`)
          console.log(`  ${min}min · gmv=${gmv} horas=${horas} lives=${lives}  <<< DIVERGIU (banco: ${esperado.gmv} / ${esperado.lives})`)
        } else if (ciclos % 6 === 1) {
          console.log(`  ${min}min · gmv=${gmv} horas=${horas} lives=${lives} série=${serie.toFixed(2)} ok`)
        }
      }
    } catch (e) {
      erros += 1
      registro.push(`${min}min exceção ${e.message.slice(0, 50)}`)
      console.log(`  ${min}min · exceção: ${e.message.slice(0, 50)}  <<< ERRO`)
    }
    await new Promise((s) => setTimeout(s, 30000))
  }

  console.log(`\n${ciclos} ciclos em ${Math.round((Date.now() - inicio) / 60000)} min`)
  console.log(`erros HTTP: ${erros} · ciclos com número divergente: ${divergencias}`)
  if (registro.length) { console.log('ocorrências:'); registro.slice(0, 20).forEach((r) => console.log('  ' + r)) }
  console.log(erros === 0 && divergencias === 0 ? '\n30 MIN LIMPOS' : '\nOCORREU')
})()
