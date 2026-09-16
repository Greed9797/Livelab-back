import { describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

const ids = {
  tenant: '11111111-1111-4111-8111-111111111111',
  cliente: '22222222-2222-4222-8222-222222222222',
  marca: '33333333-3333-4333-8333-333333333333',
  live: '44444444-4444-4444-8444-444444444444',
}

const gateway = vi.hoisted(() => ({ charges: 0 }))
vi.mock('../src/services/appmax.js', () => ({
  buscarOuCriarCustomer: vi.fn(async () => 'customer-1'),
  gerarIdempotencyKey: vi.fn(() => 'pglite-cycle-key'),
  criarCobranca: vi.fn(async () => {
    gateway.charges += 1
    return { id: 'gateway-1', invoiceUrl: 'https://gateway.test/boleto' }
  }),
}))

import { runBillingTick, startBillingEngine } from '../src/jobs/billing_engine.js'

function poolFor(db) {
  const client = {
    query: (sql, params) => db.query(sql, params),
    release: vi.fn(),
  }
  return {
    connect: vi.fn(async () => client),
    query: (sql, params) => db.query(sql, params),
  }
}

describe('billing: recuperação pós-gateway com transação SQL real', () => {
  it('volta ao savepoint, preserva o boleto e não cobra novamente no retry', async () => {
    const db = new PGlite()
    try {
      await db.exec(`
        CREATE TABLE tenants (id uuid PRIMARY KEY, gateway_api_key text);
        CREATE TABLE clientes (
          id uuid PRIMARY KEY, nome text, cpf text, cnpj text, email text,
          celular text, gateway_customer_id text
        );
        CREATE TABLE marcas (
          id uuid PRIMARY KEY, tenant_id uuid, cliente_id uuid, status text DEFAULT 'ativa'
        );
        CREATE TABLE lives (
          id uuid PRIMARY KEY, tenant_id uuid, cliente_id uuid, marca_id uuid,
          status text, iniciado_em timestamptz, encerrado_em timestamptz,
          fat_gerado numeric, ads_gmv numeric, manual_gmv numeric,
          comissao_calculada numeric, faturado_em timestamptz, boleto_id uuid,
          uniao_destino_id uuid, uniao_desfeita_em timestamptz
        );
        CREATE TABLE video_registros (id uuid PRIMARY KEY, tenant_id uuid);
        CREATE TABLE vendas_atribuidas (
          id uuid PRIMARY KEY, tenant_id uuid, origem text, origem_id uuid,
          marca_id uuid, data date, gmv numeric, comissao_franquia numeric,
          status_aprovacao text
        );
        CREATE TABLE marca_condicoes_comerciais (
          id uuid PRIMARY KEY, tenant_id uuid, marca_id uuid, inicio_vigencia date,
          fixo_mensal numeric, comissao_franquia_pct numeric, tipo_cobranca text,
          origem text, fixo_confirmado boolean, comissao_confirmada boolean,
          cancelled_at timestamptz
        );
        CREATE TABLE boletos (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid,
          cliente_id uuid, contrato_id uuid, tipo text, valor numeric,
          status text, vencimento date, competencia date,
          gerado_automaticamente boolean, idempotency_key text UNIQUE,
          gateway_id text, gateway_url text, gateway_pix_copia_cola text,
          gateway_provider text
        );
        INSERT INTO tenants VALUES ('${ids.tenant}', 'configured');
        INSERT INTO clientes VALUES ('${ids.cliente}', 'Cliente', NULL, NULL, 'cliente@test', NULL, 'customer-1');
        INSERT INTO marcas VALUES ('${ids.marca}', '${ids.tenant}', '${ids.cliente}', 'ativa');
        INSERT INTO lives (
          id, tenant_id, cliente_id, marca_id, status, iniciado_em, encerrado_em,
          fat_gerado, ads_gmv, manual_gmv, comissao_calculada, faturado_em,
          boleto_id, uniao_destino_id, uniao_desfeita_em
        ) VALUES (
          '${ids.live}', '${ids.tenant}', '${ids.cliente}', '${ids.marca}', 'encerrada',
          '2026-09-10T10:00:00Z', '2026-09-10T11:00:00Z', 1000, NULL, NULL,
          100, NULL, NULL, NULL, NULL
        );
        CREATE SEQUENCE fail_gateway_once;
        CREATE FUNCTION fail_first_gateway_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF nextval('fail_gateway_once') = 1 THEN
            RAISE EXCEPTION 'simulated local failure after gateway confirmation';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER fail_first_gateway_update
          BEFORE UPDATE OF gateway_id ON boletos
          FOR EACH ROW EXECUTE FUNCTION fail_first_gateway_update();
      `)

      gateway.charges = 0
      const pool = poolFor(db)
      await startBillingEngine(pool)

      await runBillingTick(pool, { hoje: new Date('2026-09-16T15:00:00-03:00') })

      const first = await db.query(`
        SELECT id, gateway_id, gateway_url, to_char(competencia, 'YYYY-MM-DD') AS competencia FROM boletos
        WHERE idempotency_key = 'pglite-cycle-key'
      `)
      const liveAfterFirst = await db.query(`SELECT faturado_em, boleto_id FROM lives WHERE id = $1`, [ids.live])
      expect(first.rows).toEqual([{
        id: expect.any(String),
        gateway_id: 'gateway-1',
        gateway_url: 'https://gateway.test/boleto',
        competencia: '2026-09-01',
      }])
      expect(liveAfterFirst.rows[0].boleto_id).toBe(first.rows[0].id)
      expect(liveAfterFirst.rows[0].faturado_em).not.toBeNull()

      // O fato de a primeira UPDATE ter abortado é real: sem ROLLBACK TO
      // SAVEPOINT a conexão ficaria em 25P02 e o COMMIT não seria possível.
      // O segundo ciclo lê a linha persistida e não chama o gateway.
      await runBillingTick(pool, { hoje: new Date('2026-09-16T15:00:00-03:00') })
      expect(gateway.charges).toBe(1)
    } finally {
      await db.close()
    }
  })
})
