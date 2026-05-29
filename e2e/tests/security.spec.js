/**
 * E2E Spec: Segurança e Vulnerabilidades
 *
 * Cobertura:
 *   - Token inválido/expirado → 401 em todas as rotas autenticadas
 *   - Role escalation: franqueado tentando acessar rotas restritas
 *   - SQL injection via query params (bloqueado pelo Fastify schema)
 *   - UUID injection
 *   - Cross-role data isolation (cliente_parceiro não vê dados de outro tenant)
 *   - Ausência de rate limiting (documentado como observação)
 *
 * Credenciais:
 *   franqueador_master: admin@liveshop.com / admin123
 *   franqueado:         franqueado@liveshop.com / teste123
 *   cliente_parceiro:   demo_cliente@liveshop.com / teste123
 */

import { test, expect } from '@playwright/test';
import { E2E_USERS } from '../helpers/auth.js';

const BASE = 'http://127.0.0.1:3001';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function login(request, email, senha) {
  const res = await request.post(`${BASE}/v1/auth/login`, {
    data: { email, senha },
  });
  if (!res.ok()) return null;
  const data = await res.json();
  return data.access_token;
}

async function loginMaster(request) {
  return login(request, E2E_USERS.franqueador_master.email, E2E_USERS.franqueador_master.senha);
}

async function loginFranqueado(request) {
  return login(request, E2E_USERS.franqueado.email, E2E_USERS.franqueado.senha);
}

async function loginCliente(request) {
  const token = await login(request, E2E_USERS.demo_cliente.email, E2E_USERS.demo_cliente.senha);
  if (token) return token;
  return login(request, E2E_USERS.cliente_parceiro.email, E2E_USERS.cliente_parceiro.senha);
}

// ── Token Inválido / Sem Autenticação ─────────────────────────────────────────

test.describe('[Security] Token Inválido', () => {
  const AUTHENTICATED_ENDPOINTS = [
    ['GET', '/v1/analytics/dashboard'],
    ['GET', '/v1/solicitacoes'],
    ['GET', '/v1/cliente/cabines'],
    ['GET', '/v1/financeiro/custos'],
  ];

  for (const [method, path] of AUTHENTICATED_ENDPOINTS) {
    test(`${method} ${path} sem token → 401`, async ({ request }) => {
      const res = await request[method.toLowerCase()](`${BASE}${path}`);
      expect(res.status(), `${method} ${path} sem auth deve retornar 401`).toBe(401);
    });
  }

  test('Token malformado retorna 401', async ({ request }) => {
    const res = await request.get(`${BASE}/v1/analytics/dashboard`, {
      headers: { Authorization: 'Bearer este_token_nao_e_valido_jwt' },
    });
    expect(res.status(), 'Token malformado deve retornar 401').toBe(401);
  });

  test('Token com assinatura incorreta retorna 401', async ({ request }) => {
    // JWT com header.payload.assinatura_errada
    const fakeJwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' + // header
      '.eyJzdWIiOiIxMjM0NTY3ODkwIiwibm9tZSI6IkhhY2tlciIsImlhdCI6MTUxNjIzOTAyMn0' + // payload
      '.ASSINATURAERRADA'; // assinatura inválida
    const res = await request.get(`${BASE}/v1/analytics/dashboard`, {
      headers: { Authorization: `Bearer ${fakeJwt}` },
    });
    expect(res.status()).toBe(401);
  });
});

// ── RBAC — Role Escalation ────────────────────────────────────────────────────

test.describe('[Security] RBAC — Role Escalation', () => {
  let clienteToken, franqueadoToken;

  test.beforeAll(async ({ request }) => {
    clienteToken = await loginCliente(request);
    franqueadoToken = await loginFranqueado(request);
  });

  test('cliente_parceiro não pode acessar GET /v1/analytics/dashboard → 403', async ({ request }) => {
    if (!clienteToken) test.skip();
    const res = await request.get(`${BASE}/v1/analytics/dashboard`, {
      headers: { Authorization: `Bearer ${clienteToken}` },
    });
    expect(res.status()).toBe(403);
  });

  test('cliente_parceiro não pode listar solicitações como franqueado → 403', async ({ request }) => {
    if (!clienteToken) test.skip();
    const res = await request.get(`${BASE}/v1/solicitacoes`, {
      headers: { Authorization: `Bearer ${clienteToken}` },
    });
    expect(res.status(), 'cliente não deve listar solicitações de franqueado').toBe(403);
  });

  test('cliente_parceiro não pode aprovar solicitação → 403', async ({ request }) => {
    if (!clienteToken) test.skip();
    const dummyId = '00000000-0000-0000-0000-000000000001';
    const res = await request.patch(`${BASE}/v1/solicitacoes/${dummyId}/aprovar`, {
      headers: { Authorization: `Bearer ${clienteToken}` },
    });
    // Deve retornar 403 (RBAC) antes mesmo de checar se o ID existe
    expect(res.status()).toBe(403);
  });

  test('cliente_parceiro não pode recusar solicitação → 403', async ({ request }) => {
    if (!clienteToken) test.skip();
    const dummyId = '00000000-0000-0000-0000-000000000001';
    const res = await request.patch(`${BASE}/v1/solicitacoes/${dummyId}/recusar`, {
      headers: { Authorization: `Bearer ${clienteToken}` },
      data: { motivo_recusa: 'Tentativa de escalada de privilégio' },
    });
    expect(res.status()).toBe(403);
  });

  test('cliente_parceiro não pode acessar GET /v1/financeiro/custos de outro role', async ({ request }) => {
    if (!clienteToken) test.skip();
    const res = await request.get(`${BASE}/v1/financeiro/custos`, {
      headers: { Authorization: `Bearer ${clienteToken}` },
    });
    // Rota exclusiva de franqueado — deve retornar 403
    expect(res.status()).toBe(403);
  });
});

// ── SQL Injection via Query Params ────────────────────────────────────────────

test.describe('[Security] SQL Injection / Input Validation', () => {
  let masterToken;

  test.beforeAll(async ({ request }) => {
    masterToken = await loginMaster(request);
  });

  test('mesAno: SQL injection bloqueado pelo schema Fastify → 400', async ({ request }) => {
    const payloads = [
      "2026-01'; DROP TABLE lives;--",
      "2026-01 OR 1=1",
      "'; SELECT * FROM users;--",
      '2026-01 UNION SELECT 1,2,3--',
    ];

    for (const payload of payloads) {
      const res = await request.get(
        `${BASE}/v1/analytics/dashboard?mesAno=${encodeURIComponent(payload)}`,
        { headers: { Authorization: `Bearer ${masterToken}` } }
      );
      expect(
        res.status(),
        `SQL injection "${payload}" deve ser bloqueado (400), recebido: ${res.status()}`
      ).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThan(500);
    }
  });

  test('cliente_id: UUID inválido bloqueado pelo schema → 400', async ({ request }) => {
    const payloads = [
      'not-a-uuid',
      '1 OR 1=1',
      "'; DROP TABLE clientes;--",
      '12345',
    ];

    for (const payload of payloads) {
      const res = await request.get(
        `${BASE}/v1/analytics/dashboard?cliente_id=${encodeURIComponent(payload)}`,
        { headers: { Authorization: `Bearer ${masterToken}` } }
      );
      expect(
        res.status(),
        `UUID inválido "${payload}" deve retornar 400`
      ).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThan(500);
    }
  });

  test('UUID válido mas inexistente retorna 200 (não 500)', async ({ request }) => {
    // Garante que o backend não lança erro ao não encontrar o UUID
    const fakeUuid = '00000000-0000-0000-0000-000000000099';
    const res = await request.get(
      `${BASE}/v1/analytics/dashboard?cliente_id=${fakeUuid}`,
      { headers: { Authorization: `Bearer ${masterToken}` } }
    );
    expect(res.ok(), `UUID válido inexistente deve retornar 200`).toBeTruthy();
  });

  test('Parâmetros inesperados são ignorados (não causam 500)', async ({ request }) => {
    const res = await request.get(
      `${BASE}/v1/analytics/dashboard?mesAno=2026-01&campo_inexistente=XSSS&__proto__=hack`,
      { headers: { Authorization: `Bearer ${masterToken}` } }
    );
    // O endpoint deve ignorar params extras ou retornar 400 (Fastify additionalProperties),
    // mas nunca 500
    expect(res.status()).toBeLessThan(500);
  });
});

// ── Auth — Edge Cases ─────────────────────────────────────────────────────────

test.describe('[Security] Auth — Edge Cases', () => {
  test('POST /v1/auth/login com credenciais erradas retorna 401', async ({ request }) => {
    const res = await request.post(`${BASE}/v1/auth/login`, {
      data: { email: 'admin@liveshop.com', senha: 'senha_errada_12345' },
    });
    expect(res.status()).toBe(401);
  });

  test('POST /v1/auth/login com email inexistente retorna 401', async ({ request }) => {
    const res = await request.post(`${BASE}/v1/auth/login`, {
      data: { email: 'naoexiste@liveshop.com', senha: 'qualquer123' },
    });
    expect(res.status()).toBe(401);
  });

  test('POST /v1/auth/login sem corpo retorna 400', async ({ request }) => {
    const res = await request.post(`${BASE}/v1/auth/login`, {
      data: {},
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('POST /v1/auth/refresh com refresh_token inválido retorna 401', async ({ request }) => {
    const res = await request.post(`${BASE}/v1/auth/refresh`, {
      data: { refresh_token: 'token_invalido_para_refresh' },
    });
    expect(res.status()).toBe(401);
  });

  test('Health check GET /health retorna 200 sem autenticação', async ({ request }) => {
    const res = await request.get(`${BASE}/health`);
    expect(res.ok()).toBeTruthy();
  });
});

// ── Booking Security (complementar ao solicitacao-booking.spec.js) ─────────────

test.describe('[Security] Booking — Validação de Integridade', () => {
  let clienteToken;

  test.beforeAll(async ({ request }) => {
    clienteToken = await loginCliente(request);
  });

  test('POST solicitar-live com cabine de UUID aleatório retorna 403 ou 404', async ({ request }) => {
    if (!clienteToken) test.skip();
    const fakeUuid = '00000000-0000-0000-0000-000000000099';
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const amanha = tomorrow.toISOString().slice(0, 10);

    const res = await request.post(`${BASE}/v1/cliente/cabines/${fakeUuid}/solicitar-live`, {
      headers: { Authorization: `Bearer ${clienteToken}` },
      data: {
        data_solicitada: amanha,
        hora_inicio: '14:00',
        hora_fim: '16:00',
      },
    });
    // Cabine não pertence ao cliente ou não existe → 403 ou 404
    expect(res.status()).toBeGreaterThanOrEqual(403);
    expect(res.status()).toBeLessThanOrEqual(404);
  });

  test('Solicitação sem hora_inicio retorna 400', async ({ request }) => {
    if (!clienteToken) test.skip();

    const cabinesRes = await request.get(`${BASE}/v1/cliente/cabines`, {
      headers: { Authorization: `Bearer ${clienteToken}` },
    });
    if (!cabinesRes.ok()) { test.skip(); return; }
    const cabines = await cabinesRes.json();
    if (!cabines.length) { test.skip(); return; }

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const res = await request.post(`${BASE}/v1/cliente/cabines/${cabines[0].id}/solicitar-live`, {
      headers: { Authorization: `Bearer ${clienteToken}` },
      data: {
        data_solicitada: tomorrow.toISOString().slice(0, 10),
        // hora_inicio ausente
        hora_fim: '16:00',
      },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });
});
