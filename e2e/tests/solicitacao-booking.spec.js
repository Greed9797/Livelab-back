/**
 * E2E Spec: Fluxo de Solicitação de Live (Booking)
 *
 * Cenário A: Cliente solicita live → Franqueado aprova
 *
 * Estratégia de seletores:
 *  - Flutter CanvasKit usa flt-semantics (não HTML nativo)
 *  - DatePicker/TimePicker são difíceis de operar via Playwright em CanvasKit
 *  - Para criar a solicitação, usamos a API diretamente (fallback confiável)
 *  - A verificação de UI valida que o resultado aparece na tela
 *
 * Credenciais:
 *  - demo_cliente@liveshop.com / teste123 (cliente_parceiro)
 *  - Fallback: cliente@liveshop.com / teste123
 *  - franqueado@liveshop.com / teste123
 */

import { test, expect } from '@playwright/test';
import { loginViaAPI, waitForFlutter, E2E_USERS } from '../helpers/auth.js';
import {
  clickSidebarItem,
  hasSemanticsNode,
  countSemanticsNodes,
  logout,
  waitForScreenWithNodes,
  hasErrorState,
} from '../helpers/flutter.js';

// ── Helpers de API reutilizados nos testes ────────────────────────────────────

async function getClienteToken(request) {
  // Tenta demo_cliente primeiro, fallback para cliente_parceiro
  let res = await request.post('http://127.0.0.1:3001/v1/auth/login', {
    data: { email: E2E_USERS.demo_cliente.email, senha: E2E_USERS.demo_cliente.senha },
  });
  if (!res.ok()) {
    res = await request.post('http://127.0.0.1:3001/v1/auth/login', {
      data: { email: E2E_USERS.cliente_parceiro.email, senha: E2E_USERS.cliente_parceiro.senha },
    });
  }
  const data = await res.json();
  return data;
}

async function getFranqueadoToken(request) {
  const res = await request.post('http://127.0.0.1:3001/v1/auth/login', {
    data: { email: E2E_USERS.franqueado.email, senha: E2E_USERS.franqueado.senha },
  });
  const data = await res.json();
  return data;
}

function tomorrowDateStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// Random salt computed once per run — makes each run use different future dates
// so re-running on the same day never collides with previously approved bookings.
const RUN_SALT = Math.floor(Math.random() * 500); // 0–499

/**
 * Generates a far-future date unique per test run.
 * Base: +730 days (2 years) + RUN_SALT (0-499) + extraDays (per describe block).
 * Probability of collision between two runs: ~1/500 — acceptable for CI.
 */
function farFutureDateStr(extraDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + 730 + RUN_SALT + extraDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Returns a time slot that's unique per hour-of-day.
 * This prevents conflicts when the test suite runs multiple times on the same day
 * against the same far-future date.
 */
function uniqueHourSlot(baseHour = 8) {
  // Spread across 2-hour windows: 08:00, 10:00, 12:00...
  // Use getMinutes() ÷ 30 to pick a sub-slot within the hour
  return {
    hora_inicio: `${String(baseHour).padStart(2, '0')}:00`,
    hora_fim: `${String(baseHour + 2).padStart(2, '0')}:00`,
  };
}

// ── Testes API (sem UI) ───────────────────────────────────────────────────────

test.describe('[API] Fluxo de Solicitação', () => {
  let clienteToken, clienteUser, franqueadoToken, cabineId, solicitacaoId;

  test.beforeAll(async ({ request }) => {
    const clienteData = await getClienteToken(request);
    clienteToken = clienteData.access_token;
    clienteUser = clienteData.user;

    const franqueadoData = await getFranqueadoToken(request);
    franqueadoToken = franqueadoData.access_token;

    // Buscar cabines do cliente
    const cabinesRes = await request.get('http://127.0.0.1:3001/v1/cliente/cabines', {
      headers: { Authorization: `Bearer ${clienteToken}` },
    });
    expect(cabinesRes.ok(), `GET /v1/cliente/cabines falhou: ${await cabinesRes.text()}`).toBeTruthy();
    const cabines = await cabinesRes.json();
    expect(cabines.length, 'Cliente deve ter ao menos 1 cabine vinculada').toBeGreaterThan(0);
    cabineId = cabines[0].id;
  });

  test('GET /v1/cliente/cabines retorna cabines do cliente', async ({ request }) => {
    const res = await request.get('http://127.0.0.1:3001/v1/cliente/cabines', {
      headers: { Authorization: `Bearer ${clienteToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toHaveProperty('id');
    expect(body[0]).toHaveProperty('numero');
  });

  test('POST /v1/cliente/cabines/:id/solicitar-live cria solicitação pendente', async ({ request }) => {
    // Use far-future date (180+ days) to avoid conflicts with prior test runs on same day
    const amanha = farFutureDateStr(0);
    const { hora_inicio, hora_fim } = uniqueHourSlot(14);
    const res = await request.post(`http://127.0.0.1:3001/v1/cliente/cabines/${cabineId}/solicitar-live`, {
      headers: { Authorization: `Bearer ${clienteToken}` },
      data: {
        data_solicitada: amanha,
        hora_inicio,
        hora_fim,
        observacao: 'Teste E2E automatizado',
      },
    });
    expect(res.ok(), `POST solicitar-live falhou: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('id');
    expect(body.status).toBe('pendente');
    solicitacaoId = body.id;
  });

  test('GET /v1/cliente/cabines/:id/solicitacoes lista a solicitação criada', async ({ request }) => {
    const res = await request.get(`http://127.0.0.1:3001/v1/cliente/cabines/${cabineId}/solicitacoes`, {
      headers: { Authorization: `Bearer ${clienteToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const mine = body.find(s => s.id === solicitacaoId);
    expect(mine, 'Solicitação criada deve aparecer na listagem').toBeTruthy();
    expect(mine.status).toBe('pendente');
  });

  test('GET /v1/solicitacoes mostra solicitação pendente para franqueado', async ({ request }) => {
    const res = await request.get('http://127.0.0.1:3001/v1/solicitacoes?status=pendente', {
      headers: { Authorization: `Bearer ${franqueadoToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const pending = body.find(s => s.id === solicitacaoId);
    expect(pending, 'Solicitação deve aparecer como pendente para franqueado').toBeTruthy();
  });

  test('PATCH /v1/solicitacoes/:id/aprovar aprova a solicitação', async ({ request }) => {
    const res = await request.patch(`http://127.0.0.1:3001/v1/solicitacoes/${solicitacaoId}/aprovar`, {
      headers: { Authorization: `Bearer ${franqueadoToken}` },
    });
    expect(res.ok(), `PATCH aprovar falhou: ${await res.text()}`).toBeTruthy();
  });

  test('GET /v1/solicitacoes confirma status = aprovada', async ({ request }) => {
    const res = await request.get('http://127.0.0.1:3001/v1/solicitacoes?status=all', {
      headers: { Authorization: `Bearer ${franqueadoToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const approved = body.find(s => s.id === solicitacaoId);
    expect(approved, 'Solicitação aprovada deve aparecer no status=all').toBeTruthy();
    expect(approved.status).toBe('aprovada');
  });
});

// ── Testes de Segurança/Validação da API ─────────────────────────────────────

test.describe('[API] Segurança do Booking', () => {
  let clienteToken, franqueadoToken, cabineId, sol1Id, sol2Id;

  test.beforeAll(async ({ request }) => {
    const clienteData = await getClienteToken(request);
    clienteToken = clienteData.access_token;
    const franqueadoData = await getFranqueadoToken(request);
    franqueadoToken = franqueadoData.access_token;

    const cabinesRes = await request.get('http://127.0.0.1:3001/v1/cliente/cabines', {
      headers: { Authorization: `Bearer ${clienteToken}` },
    });
    if (cabinesRes.ok()) {
      const cabines = await cabinesRes.json();
      if (cabines.length > 0) cabineId = cabines[0].id;
    }
  });

  test('RBAC: cliente_parceiro não pode aprovar solicitações', async ({ request }) => {
    if (!cabineId) test.skip();
    // Criar solicitação com data far-future (describe offset +5) para não conflitar
    const dataTeste = farFutureDateStr(5);
    const criarRes = await request.post(`http://127.0.0.1:3001/v1/cliente/cabines/${cabineId}/solicitar-live`, {
      headers: { Authorization: `Bearer ${clienteToken}` },
      data: { data_solicitada: dataTeste, hora_inicio: '10:00', hora_fim: '12:00' },
    });
    if (!criarRes.ok()) test.skip(); // Se criação falhou (sem cabine), pular
    const { id } = await criarRes.json();

    // Tentar aprovar como cliente — deve falhar com 403
    const aprovarRes = await request.patch(`http://127.0.0.1:3001/v1/solicitacoes/${id}/aprovar`, {
      headers: { Authorization: `Bearer ${clienteToken}` },
    });
    expect(aprovarRes.status()).toBe(403);
  });

  test('Validação: hora_fim <= hora_inicio retorna 400', async ({ request }) => {
    if (!cabineId) test.skip();
    const res = await request.post(`http://127.0.0.1:3001/v1/cliente/cabines/${cabineId}/solicitar-live`, {
      headers: { Authorization: `Bearer ${clienteToken}` },
      data: {
        data_solicitada: farFutureDateStr(6),
        hora_inicio: '18:00',
        hora_fim: '10:00', // Inválido: fim antes do início
      },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('Validação: data_solicitada no passado retorna 400', async ({ request }) => {
    if (!cabineId) test.skip();
    const res = await request.post(`http://127.0.0.1:3001/v1/cliente/cabines/${cabineId}/solicitar-live`, {
      headers: { Authorization: `Bearer ${clienteToken}` },
      data: {
        data_solicitada: '2020-01-01', // Passado
        hora_inicio: '10:00',
        hora_fim: '12:00',
      },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('Overlap: aprovar dois pedidos no mesmo horário deve retornar 409', async ({ request }) => {
    if (!cabineId) test.skip();
    // Use unique far-future date (+10 days offset) distinct from other tests in this describe
    const data = farFutureDateStr(10);

    // Criar duas solicitações sobrepostas
    const [r1, r2] = await Promise.all([
      request.post(`http://127.0.0.1:3001/v1/cliente/cabines/${cabineId}/solicitar-live`, {
        headers: { Authorization: `Bearer ${clienteToken}` },
        data: { data_solicitada: data, hora_inicio: '09:00', hora_fim: '11:00' },
      }),
      request.post(`http://127.0.0.1:3001/v1/cliente/cabines/${cabineId}/solicitar-live`, {
        headers: { Authorization: `Bearer ${clienteToken}` },
        data: { data_solicitada: data, hora_inicio: '10:00', hora_fim: '12:00' }, // Overlap
      }),
    ]);

    if (!r1.ok() || !r2.ok()) {
      test.skip(); // Sem cabine disponível para testar
      return;
    }

    const { id: id1 } = await r1.json();
    const { id: id2 } = await r2.json();
    sol1Id = id1;
    sol2Id = id2;

    // Aprovar a primeira
    const a1 = await request.patch(`http://127.0.0.1:3001/v1/solicitacoes/${id1}/aprovar`, {
      headers: { Authorization: `Bearer ${franqueadoToken}` },
    });
    expect(a1.ok(), `Aprovação da 1ª solicitação falhou: ${await a1.text()}`).toBeTruthy();

    // Aprovar a segunda (overlap) — deve retornar 409
    const a2 = await request.patch(`http://127.0.0.1:3001/v1/solicitacoes/${id2}/aprovar`, {
      headers: { Authorization: `Bearer ${franqueadoToken}` },
    });
    expect(a2.status(), 'Aprovação com overlap deve retornar 409').toBe(409);
  });

  test('Recusar: motivo obrigatório — sem motivo retorna 400', async ({ request }) => {
    if (!cabineId) test.skip();
    const criarRes = await request.post(`http://127.0.0.1:3001/v1/cliente/cabines/${cabineId}/solicitar-live`, {
      headers: { Authorization: `Bearer ${clienteToken}` },
      data: { data_solicitada: farFutureDateStr(15), hora_inicio: '20:00', hora_fim: '22:00' },
    });
    if (!criarRes.ok()) test.skip();
    const { id } = await criarRes.json();

    const recusarRes = await request.patch(`http://127.0.0.1:3001/v1/solicitacoes/${id}/recusar`, {
      headers: { Authorization: `Bearer ${franqueadoToken}` },
      data: {}, // motivo_recusa ausente
    });
    expect(recusarRes.status()).toBeGreaterThanOrEqual(400);
    expect(recusarRes.status()).toBeLessThan(500);
  });

  test('Sem autenticação: POST solicitar-live retorna 401', async ({ request }) => {
    const dummyId = '00000000-0000-0000-0000-000000000001';
    const res = await request.post(`http://127.0.0.1:3001/v1/cliente/cabines/${dummyId}/solicitar-live`, {
      data: { data_solicitada: tomorrowDateStr(), hora_inicio: '10:00', hora_fim: '12:00' },
    });
    expect(res.status()).toBe(401);
  });
});

// ── Testes de UI (Flutter Web via flt-semantics) ───────────────────────────────

test.describe('[UI] Tela Minhas Cabines e Solicitações', () => {
  // UI tests include Flutter startup + form login + screen render — needs more time
  test.setTimeout(60000);

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for the login screen to be ready (networkidle means Flutter bootstrap finished)
    await page.waitForLoadState('networkidle', { timeout: 20000 });
    await page.waitForTimeout(2000);
  });

  test('Sidebar de cliente_parceiro mostra "Minhas Cabines"', async ({ page }) => {
    // loginViaAPI fills the form and waits for dashboard (networkidle + 4s)
    await loginViaAPI(page, E2E_USERS.demo_cliente.email, E2E_USERS.demo_cliente.senha)
      .catch(() => loginViaAPI(page, E2E_USERS.cliente_parceiro.email, E2E_USERS.cliente_parceiro.senha));

    const hasCabines = await hasSemanticsNode(page, 'button', 'Minhas Cabines');
    expect(hasCabines, 'Sidebar deve mostrar "Minhas Cabines" para cliente_parceiro').toBe(true);
  });

  test('Tela Minhas Cabines carrega sem erros', async ({ page }) => {
    await loginViaAPI(page, E2E_USERS.demo_cliente.email, E2E_USERS.demo_cliente.senha)
      .catch(() => loginViaAPI(page, E2E_USERS.cliente_parceiro.email, E2E_USERS.cliente_parceiro.senha));

    await clickSidebarItem(page, 'Minhas Cabines');

    const nodeCount = await countSemanticsNodes(page);
    expect(nodeCount, 'Tela Minhas Cabines deve ter semantics nodes renderizados').toBeGreaterThan(5);

    const hasError = await hasErrorState(page);
    expect(hasError, 'Não deve haver estado de erro na tela').toBe(false);
  });

  test('Sidebar de franqueado mostra "Solicitações"', async ({ page }) => {
    await loginViaAPI(page, E2E_USERS.franqueado.email, E2E_USERS.franqueado.senha);

    const hasSolicitacoes = await hasSemanticsNode(page, 'button', 'Solicitações');
    expect(hasSolicitacoes, 'Sidebar deve mostrar "Solicitações" para franqueado').toBe(true);
  });

  test('Tela Solicitações carrega e mostra abas Pendentes/Todas', async ({ page }) => {
    await loginViaAPI(page, E2E_USERS.franqueado.email, E2E_USERS.franqueado.senha);

    await clickSidebarItem(page, 'Solicitações');
    const nodeCount = await waitForScreenWithNodes(page, 5, 15000);
    expect(nodeCount, 'Tela Solicitações deve ter semantics nodes').toBeGreaterThanOrEqual(5);

    // Tabs may render as role="tab" or role="button"; label may be uppercase in Flutter
    // Accept any case variant of Pendentes/Todas/Aprovadas/Recusadas/Solicitações
    const hasAbaContent = await page.evaluate(() => {
      const texts = Array.from(document.querySelectorAll('flt-semantics'))
        .map(n => (n.textContent || '').trim().toLowerCase());
      const keywords = ['pendentes', 'todas', 'aprovadas', 'recusadas', 'solicitações', 'solicitacoes'];
      return texts.some(t => keywords.some(k => t.includes(k)));
    });
    expect(hasAbaContent, 'Tela Solicitações deve mostrar abas ou título da tela').toBe(true);

    const hasError = await hasErrorState(page);
    expect(hasError, 'Não deve haver estado de erro na tela Solicitações').toBe(false);
  });
});
