import { test, expect } from '@playwright/test';
import { E2E_USERS } from '../helpers/auth.js';

const API = 'http://127.0.0.1:3001';

/**
 * Helper: faz login via API e retorna o access_token.
 */
async function loginAs(request, userKey) {
  const user = E2E_USERS[userKey];
  const res = await request.post(`${API}/v1/auth/login`, {
    data: { email: user.email, senha: user.senha },
  });
  expect(res.ok(), `Login falhou para ${userKey}: ${res.status()}`).toBeTruthy();
  const body = await res.json();
  return body.access_token;
}

/**
 * Helper: retorna a primeira cabine disponível para o tenant do franqueado.
 * Retorna null se não houver nenhuma.
 */
async function getPrimeiraCabineDisponivel(request, token) {
  const res = await request.get(`${API}/v1/cabines`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok()) return null;
  const cabines = await res.json();
  return cabines.find((c) => c.status === 'disponivel') ?? null;
}

/**
 * Helper: retorna a primeira live encerrada do tenant.
 * Retorna null se não houver nenhuma.
 */
async function getPrimeiraLiveEncerrada(request, token) {
  const res = await request.get(`${API}/v1/lives?status=encerrada`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok()) return null;
  const lives = await res.json();
  return Array.isArray(lives) ? (lives[0] ?? null) : null;
}

test.describe('Live Restructure — fluxos críticos da branch', () => {

  // ─── POST /v1/lives — afiliado não requer cliente_id ──────────────────────
  test('POST /v1/lives — afiliado não requer cliente_id', async ({ request }) => {
    const token = await loginAs(request, 'franqueado');
    const cabine = await getPrimeiraCabineDisponivel(request, token);

    if (!cabine) {
      test.skip(true, 'Sem cabine disponível — precisa de dados de seed');
      return;
    }

    const res = await request.post(`${API}/v1/lives`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        cabine_id: cabine.id,
        tipo: 'afiliado',
        // cliente_id intencionalmente omitido
      },
    });

    // Deve ser 201 Created; jamais 422 CLIENTE_REQUIRED para tipo='afiliado'
    expect(
      res.status(),
      `Esperado 201 para afiliado sem cliente_id, recebido ${res.status()}`,
    ).toBe(201);

    const body = await res.json();
    expect(body).toHaveProperty('id');
    expect(body.tipo).toBe('afiliado');

    // Cleanup: encerrar a live para não deixar cabine travada
    await request.patch(`${API}/v1/lives/${body.id}/encerrar`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { fat_gerado: 0, status_publicacao: 'rascunho', origem_dados: 'manual' },
    });
  });

  // ─── POST /v1/lives — cliente inadimplente bloqueado ──────────────────────
  test('POST /v1/lives — cliente inadimplente bloqueado com 403 CLIENTE_INADIMPLENTE', async ({ request }) => {
    const token = await loginAs(request, 'franqueado');
    const cabine = await getPrimeiraCabineDisponivel(request, token);

    if (!cabine) {
      test.skip(true, 'Sem cabine disponível — precisa de dados de seed');
      return;
    }

    // Busca um cliente com status='inadimplente' no tenant
    // A rota de clientes existe e retorna array de clientes
    const clientesRes = await request.get(`${API}/v1/clientes`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    let inadimplenteId = null;
    if (clientesRes.ok()) {
      const clientes = await clientesRes.json();
      const inadimplente = Array.isArray(clientes)
        ? clientes.find((c) => c.status === 'inadimplente')
        : null;
      inadimplenteId = inadimplente?.id ?? null;
    }

    if (!inadimplenteId) {
      test.skip(true, 'Sem cliente inadimplente no seed — precisa de dados de seed');
      return;
    }

    const res = await request.post(`${API}/v1/lives`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        cabine_id: cabine.id,
        tipo: 'cliente',
        cliente_id: inadimplenteId,
      },
    });

    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('CLIENTE_INADIMPLENTE');
  });

  // ─── GET /v1/lives — cliente_parceiro vê apenas publicado ─────────────────
  test('GET /v1/lives — cliente_parceiro vê apenas lives com status_publicacao=publicado', async ({ request }) => {
    const token = await loginAs(request, 'cliente_parceiro');

    const res = await request.get(`${API}/v1/lives`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.ok()).toBeTruthy();
    const lives = await res.json();
    expect(Array.isArray(lives)).toBe(true);

    // Todas as lives retornadas devem ter status_publicacao = 'publicado'
    for (const live of lives) {
      expect(live.status_publicacao).toBe('publicado');
    }
  });

  // ─── PATCH /v1/lives/:id/publicar — franqueado pode publicar ──────────────
  test('PATCH /v1/lives/:id/publicar — franqueado publica live encerrada com sucesso', async ({ request }) => {
    const token = await loginAs(request, 'franqueado');
    const live = await getPrimeiraLiveEncerrada(request, token);

    if (!live) {
      test.skip(true, 'Sem live encerrada no banco — precisa de dados de seed');
      return;
    }

    const res = await request.patch(`${API}/v1/lives/${live.id}/publicar`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { status_publicacao: 'publicado' },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status_publicacao).toBe('publicado');
    expect(body.id).toBe(live.id);
  });

  // ─── GET /v1/public/ranking — sem autenticação ────────────────────────────
  test('GET /v1/public/ranking — acessível sem autenticação e exclui master tenant', async ({ request }) => {
    // Sem Authorization header
    const res = await request.get(`${API}/v1/public/ranking`);

    expect(res.status()).toBe(200);
    const body = await res.json();

    // O ranking deve ser um objeto com propriedade que lista os franqueados
    // (mapNetworkRanking retorna array diretamente ou objeto com clientes/franqueados)
    expect(body).toBeDefined();

    // Master tenant ID jamais deve aparecer no ranking público
    const MASTER_TENANT_ID = '00000000-0000-0000-0000-000000000001';
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain(MASTER_TENANT_ID);
  });

  // ─── PATCH /v1/cabines/:id/reservar — sem contrato_id ────────────────────
  test('PATCH /v1/cabines/:id/reservar — aceita reserva sem contrato_id no body', async ({ request }) => {
    const token = await loginAs(request, 'franqueado');
    const cabine = await getPrimeiraCabineDisponivel(request, token);

    if (!cabine) {
      test.skip(true, 'Sem cabine disponível — precisa de dados de seed');
      return;
    }

    // Reserva sem contrato_id (apenas status disponível é aceito)
    const res = await request.patch(`${API}/v1/cabines/${cabine.id}/reservar`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        // contrato_id intencionalmente omitido — reserva sem vínculo contratual
      },
    });

    // Deve retornar 200 — reserva sem contrato é permitida
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('ok');
    expect(body.ok).toBe(true);
  });

  // ─── POST /v1/lives — tipo='cliente' sem cliente_id retorna 409 CLIENTE_REQUIRED
  test('POST /v1/lives — tipo cliente sem cliente_id retorna CLIENTE_REQUIRED', async ({ request }) => {
    const token = await loginAs(request, 'franqueado');
    const cabine = await getPrimeiraCabineDisponivel(request, token);

    if (!cabine) {
      test.skip(true, 'Sem cabine disponível — precisa de dados de seed');
      return;
    }

    const res = await request.post(`${API}/v1/lives`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        cabine_id: cabine.id,
        tipo: 'cliente',
        // cliente_id omitido
      },
    });

    // Deve retornar 409 com code CLIENTE_REQUIRED
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('CLIENTE_REQUIRED');
  });

});
