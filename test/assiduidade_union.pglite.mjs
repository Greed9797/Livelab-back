// Integração SQL isolada: executa a rota de assiduidade contra PostgreSQL em memória.
// Rode com PGLITE_MODULE apontando para uma instalação descartável de @electric-sql/pglite.
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import { analyticsRoutes } from '../src/routes/analytics.js'
import { activeLiveSql } from '../src/lib/live-merge-sql.js'
import { apresentadoraHorasPresencaSql } from '../src/lib/metric-sql.js'

const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')
const db = new PGlite()

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant = id(1)
const ana = id(2)
const bia = id(3)
const anaUser = id(4)
const biaUser = id(5)
const originAna = id(10)
const originBia = id(11)
const destination = id(12)
const union = id(13)
const agenda = id(30)
const coAgenda = id(31)
const coLive = id(14)

await db.exec(`
  SET TIME ZONE 'UTC';
  CREATE TABLE apresentadoras (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid,
    nome text NOT NULL, ativo boolean NOT NULL DEFAULT true,
    arquivada boolean NOT NULL DEFAULT false, data_inicio date,
    data_fim date, criado_em timestamptz NOT NULL
  );
  CREATE TABLE lives (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, apresentador_id uuid,
    agenda_evento_id uuid, status text NOT NULL,
    iniciado_em timestamptz NOT NULL, encerrado_em timestamptz,
    previsto_fim timestamptz, uniao_destino_id uuid,
    uniao_id uuid, uniao_desfeita_em timestamptz
  );
  CREATE TABLE live_apresentadoras_v2 (
    live_id uuid NOT NULL, tenant_id uuid NOT NULL,
    apresentadora_id uuid NOT NULL, segundos_rateio integer,
    percentual_rateio numeric, gmv_rateado numeric
  );
  CREATE TABLE live_apresentadores (
    live_id uuid NOT NULL, apresentador_id uuid NOT NULL
  );
  CREATE TABLE agenda_eventos (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, apresentadora_id uuid
  );
  CREATE TABLE agenda_evento_apresentadoras (
    agenda_evento_id uuid, tenant_id uuid, apresentadora_id uuid,
    data_inicio timestamptz, data_fim timestamptz
  );
  SELECT set_config('app.tenant_id', '${tenant}', false);
`)

await db.query(`
  INSERT INTO agenda_eventos(id, tenant_id, apresentadora_id)
  VALUES ($1, $3, $2), ($4, $3, $2)
`, [agenda, ana, tenant, coAgenda])

// O primeiro evento tem revezamento sequencial: Ana fica 12h–15h UTC e Bia
// 15h–18h UTC. O segundo evento verifica coapresentação: ambas ficam juntas
// durante cinco horas. Os turnos são a fonte de tempo quando segundos_rateio
// não foram persistidos.
await db.query(`
  INSERT INTO agenda_evento_apresentadoras(
    agenda_evento_id, tenant_id, apresentadora_id, data_inicio, data_fim
  ) VALUES
    ($1, $3, $4, '2025-09-15T12:00:00Z', '2025-09-15T15:00:00Z'),
    ($1, $3, $5, '2025-09-15T15:00:00Z', '2025-09-15T18:00:00Z'),
    ($2, $3, $4, '2025-09-16T12:00:00Z', '2025-09-16T17:00:00Z'),
    ($2, $3, $5, '2025-09-16T12:00:00Z', '2025-09-16T17:00:00Z')
`, [agenda, coAgenda, tenant, ana, bia])

await db.query(`
  INSERT INTO apresentadoras(id, tenant_id, user_id, nome, data_inicio, criado_em)
  VALUES ($1, $3, $4, 'Ana', '2020-01-01', '2020-01-01T00:00:00Z'),
         ($2, $3, $5, 'Bia', '2020-01-01', '2020-01-01T00:00:00Z')
`, [ana, bia, tenant, anaUser, biaUser])

// Dois trechos sequenciais de 3h e o destino consolidado de 6h. O GMV é zero de
// propósito: presença vem do tempo rateado, sem depender de venda.
await db.query(`
  INSERT INTO lives(
    id, tenant_id, apresentador_id, agenda_evento_id, status, iniciado_em, encerrado_em,
    uniao_destino_id, uniao_id, uniao_desfeita_em
  ) VALUES
    ($1, $4, $5, $8, 'encerrada', '2025-09-15T12:00:00Z', '2025-09-15T15:00:00Z', $3, NULL, NULL),
    ($2, $4, $6, $8, 'encerrada', '2025-09-15T15:00:00Z', '2025-09-15T18:00:00Z', $3, NULL, NULL),
    ($3, $4, NULL, $8, 'encerrada', '2025-09-15T12:00:00Z', '2025-09-15T18:00:00Z', NULL, $7, NULL)
`, [originAna, originBia, destination, tenant, anaUser, biaUser, union, agenda])

await db.query(`
  INSERT INTO lives(
    id, tenant_id, agenda_evento_id, status, iniciado_em, encerrado_em
  ) VALUES ($1, $2, $3, 'encerrada', '2025-09-16T12:00:00Z', '2025-09-16T17:00:00Z')
`, [coLive, tenant, coAgenda])

await db.query(`
  INSERT INTO live_apresentadoras_v2(live_id, tenant_id, apresentadora_id, segundos_rateio, percentual_rateio, gmv_rateado)
  VALUES ($1, $4, $5, NULL, 100, 0),
         ($2, $4, $6, NULL, 100, 0),
         ($3, $4, $5, NULL, 50, 0),
         ($3, $4, $6, NULL, 50, 0),
         ($7, $4, $5, NULL, 50, 0),
         ($7, $4, $6, NULL, 50, 0)
`, [originAna, originBia, destination, tenant, ana, bia, coLive])

const app = Fastify({ logger: false })
app.decorate('authenticate', async (request) => {
  request.user = { tenant_id: tenant, sub: id(20), papel: 'franqueado' }
})
app.decorate('requirePapel', (roles) => async (request, reply) => {
  if (!roles.includes(request.user.papel)) return reply.code(403).send({ error: 'Forbidden' })
})
app.decorate('withTenant', async (_tenantId, callback) => callback(db))
await app.register(analyticsRoutes)

const routeHours = async (day = '2025-09-15') => {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/analytics/assiduidade?inicio=${day}&fim=${day}`,
  })
  assert.equal(response.statusCode, 200, response.body)
  return Object.fromEntries(response.json().apresentadoras.map((presenter) => [presenter.nome, presenter.resumo.horas_total]))
}

const directHours = async (day, guard) => {
  const { rows } = await db.query(`
    SELECT lav.apresentadora_id,
           SUM(${apresentadoraHorasPresencaSql({ live: 'l', rateio: 'lav', turno: 'turno' })}) AS horas
      FROM lives l
      JOIN live_apresentadoras_v2 lav ON lav.live_id = l.id AND lav.tenant_id = l.tenant_id
      LEFT JOIN LATERAL (
        SELECT SUM(EXTRACT(EPOCH FROM (aea.data_fim - aea.data_inicio))) / 3600.0 AS horas_turno
          FROM agenda_evento_apresentadoras aea
         WHERE aea.agenda_evento_id = l.agenda_evento_id
           AND aea.tenant_id = l.tenant_id
           AND aea.apresentadora_id = lav.apresentadora_id
      ) turno ON true
     WHERE l.tenant_id = $1::uuid
       AND l.status = 'encerrada'
       AND l.iniciado_em >= ($2::timestamp) AT TIME ZONE 'America/Sao_Paulo'
       AND l.iniciado_em < (($2::timestamp) + INTERVAL '1 day') AT TIME ZONE 'America/Sao_Paulo'
       ${guard}
     GROUP BY lav.apresentadora_id
     ORDER BY lav.apresentadora_id
  `, [tenant, day])
  return rows.map((row) => Number(row.horas))
}

// Antes da reversão, a leitura legada soma origem + destino (6h por pessoa),
// enquanto o filtro canônico e a rota devem enxergar só o destino ativo (3h).
assert.deepEqual(await directHours('2025-09-15', ''), [6, 6])
assert.deepEqual(await directHours('2025-09-15', `AND ${activeLiveSql('l')}`), [3, 3])
assert.deepEqual(await routeHours(), { Ana: 3, Bia: 3 })

// A reversão reativa as origens e marca o destino como desfeito. O mesmo filtro
// precisa então trocar a fonte sem manter o destino histórico na soma.
await db.query(
  `UPDATE lives
      SET uniao_destino_id = NULL
    WHERE tenant_id = $1 AND id IN ($2, $3)`,
  [tenant, originAna, originBia],
)
await db.query(
  `UPDATE lives SET uniao_desfeita_em = '2025-09-16T00:00:00Z' WHERE tenant_id = $1 AND id = $2`,
  [tenant, destination],
)

assert.deepEqual(await directHours('2025-09-15', ''), [6, 6])
assert.deepEqual(await directHours('2025-09-15', `AND ${activeLiveSql('l')}`), [3, 3])
assert.deepEqual(await routeHours(), { Ana: 3, Bia: 3 })

// Turnos sobrepostos dão a cada apresentadora o evento inteiro. O rateio continua
// 50/50 e o GMV continua zero; a presença usa o calendário físico do turno.
assert.deepEqual(await directHours('2025-09-16', `AND ${activeLiveSql('l')}`), [5, 5])
assert.deepEqual(await routeHours('2025-09-16'), { Ana: 5, Bia: 5 })

console.log(JSON.stringify({
  verified: true,
  merged: { legacy_hours: [6, 6], active_hours: [3, 3] },
  reversed: { legacy_hours: [6, 6], active_hours: [3, 3] },
  zeroGmv: true,
  revezamento: true,
}))

await app.close()
await db.close()
