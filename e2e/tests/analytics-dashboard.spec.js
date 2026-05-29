/**
 * E2E Spec: Analytics Dashboard
 *
 * Cenário B: Franqueador acessa Analytics, valida KPIs, interage com filtros
 *
 * Endpoint: GET /v1/analytics/dashboard
 * RBAC: franqueador_master + franqueado (cliente_parceiro → 403)
 *
 * Response shape:
 *   {
 *     kpis: { faturamento_total, total_vendas, ticket_medio },
 *     faturamento_mensal: [{ mes, gmv }],
 *     vendas_mensal: [{ mes, total_vendas }],
 *     horas_live_por_dia: [{ dia, horas }],
 *     ranking_apresentadores: [{ apresentador_id, apresentador_nome, total_lives, gmv_total }]
 *   }
 *
 * Credenciais:
 *   franqueador_master: admin@liveshop.com / admin123
 *   franqueado:         franqueado@liveshop.com / teste123
 *   cliente_parceiro:   demo_cliente@liveshop.com / teste123
 */

import { test, expect } from '@playwright/test';
import { loginViaAPI, waitForFlutter, E2E_USERS } from '../helpers/auth.js';
import {
  clickSidebarItem,
  hasSemanticsNode,
  countSemanticsNodes,
  waitForScreenWithNodes,
  hasErrorState,
  getAllSemanticsText,
} from '../helpers/flutter.js';

// ── Helpers de token ──────────────────────────────────────────────────────────

async function getMasterToken(request) {
  const res = await request.post('http://127.0.0.1:3001/v1/auth/login', {
    data: { email: E2E_USERS.franqueador_master.email, senha: E2E_USERS.franqueador_master.senha },
  });
  expect(res.ok(), `Login master falhou: ${await res.text()}`).toBeTruthy();
  const data = await res.json();
  return data.access_token;
}

async function getFranqueadoToken(request) {
  const res = await request.post('http://127.0.0.1:3001/v1/auth/login', {
    data: { email: E2E_USERS.franqueado.email, senha: E2E_USERS.franqueado.senha },
  });
  const data = await res.json();
  return data.access_token;
}

async function getClienteToken(request) {
  let res = await request.post('http://127.0.0.1:3001/v1/auth/login', {
    data: { email: E2E_USERS.demo_cliente.email, senha: E2E_USERS.demo_cliente.senha },
  });
  if (!res.ok()) {
    res = await request.post('http://127.0.0.1:3001/v1/auth/login', {
      data: { email: E2E_USERS.cliente_parceiro.email, senha: E2E_USERS.cliente_parceiro.senha },
    });
  }
  const data = await res.json();
  return data.access_token;
}

// ── Testes API (sem UI) ───────────────────────────────────────────────────────

test.describe('[API] Analytics Dashboard', () => {
  let masterToken, franqueadoToken, clienteToken;

  test.beforeAll(async ({ request }) => {
    masterToken = await getMasterToken(request);
    franqueadoToken = await getFranqueadoToken(request);
    clienteToken = await getClienteToken(request);
  });

  test('GET /v1/analytics/dashboard retorna 200 com shape correto (master)', async ({ request }) => {
    const res = await request.get('http://127.0.0.1:3001/v1/analytics/dashboard', {
      headers: { Authorization: `Bearer ${masterToken}` },
    });
    expect(res.ok(), `GET analytics/dashboard falhou: ${await res.text()}`).toBeTruthy();
    const body = await res.json();

    // Shape: kpis
    expect(body).toHaveProperty('kpis');
    expect(body.kpis).toHaveProperty('faturamento_total');
    expect(body.kpis).toHaveProperty('total_vendas');
    expect(body.kpis).toHaveProperty('ticket_medio');
    expect(typeof body.kpis.faturamento_total).toBe('number');
    expect(typeof body.kpis.total_vendas).toBe('number');
    expect(typeof body.kpis.ticket_medio).toBe('number');

    // Shape: arrays
    expect(Array.isArray(body.faturamento_mensal)).toBe(true);
    expect(Array.isArray(body.vendas_mensal)).toBe(true);
    expect(Array.isArray(body.horas_live_por_dia)).toBe(true);
    expect(Array.isArray(body.ranking_apresentadores)).toBe(true);
  });

  test('GET /v1/analytics/dashboard retorna 200 para franqueado', async ({ request }) => {
    const res = await request.get('http://127.0.0.1:3001/v1/analytics/dashboard', {
      headers: { Authorization: `Bearer ${franqueadoToken}` },
    });
    expect(res.ok(), `franqueado deve acessar dashboard: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('kpis');
  });

  test('GET /v1/analytics/dashboard com filtro mesAno válido retorna 200', async ({ request }) => {
    const res = await request.get('http://127.0.0.1:3001/v1/analytics/dashboard?mesAno=2025-12', {
      headers: { Authorization: `Bearer ${masterToken}` },
    });
    expect(res.ok(), `GET com mesAno falhou: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('kpis');
  });

  test('ticket_medio é 0 (não NaN/Infinity) quando total_vendas = 0', async ({ request }) => {
    // Mês muito antigo sem dados reais
    const res = await request.get('http://127.0.0.1:3001/v1/analytics/dashboard?mesAno=2000-01', {
      headers: { Authorization: `Bearer ${masterToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    expect(body.kpis.total_vendas).toBe(0);
    expect(body.kpis.ticket_medio).toBe(0);
    expect(Number.isFinite(body.kpis.ticket_medio)).toBe(true);
    expect(Number.isNaN(body.kpis.ticket_medio)).toBe(false);
  });

  test('faturamento_mensal items têm propriedades mes e gmv', async ({ request }) => {
    const res = await request.get('http://127.0.0.1:3001/v1/analytics/dashboard', {
      headers: { Authorization: `Bearer ${masterToken}` },
    });
    const body = await res.json();
    if (body.faturamento_mensal.length > 0) {
      const item = body.faturamento_mensal[0];
      expect(item).toHaveProperty('mes');
      expect(item).toHaveProperty('gmv');
      expect(typeof item.mes).toBe('string');
      expect(typeof item.gmv).toBe('number');
      // Formato YYYY-MM
      expect(item.mes).toMatch(/^\d{4}-\d{2}$/);
    }
  });

  test('ranking_apresentadores items têm shape correto', async ({ request }) => {
    const res = await request.get('http://127.0.0.1:3001/v1/analytics/dashboard', {
      headers: { Authorization: `Bearer ${masterToken}` },
    });
    const body = await res.json();
    if (body.ranking_apresentadores.length > 0) {
      const item = body.ranking_apresentadores[0];
      expect(item).toHaveProperty('apresentador_id');
      expect(item).toHaveProperty('apresentador_nome');
      expect(item).toHaveProperty('total_lives');
      expect(item).toHaveProperty('gmv_total');
      expect(typeof item.total_lives).toBe('number');
      expect(typeof item.gmv_total).toBe('number');
    }
  });
});

// ── Testes API — Segurança/Validação ─────────────────────────────────────────

test.describe('[API] Segurança Analytics', () => {
  let masterToken, clienteToken;

  test.beforeAll(async ({ request }) => {
    masterToken = await getMasterToken(request);
    clienteToken = await getClienteToken(request);
  });

  test('RBAC: cliente_parceiro recebe 403 ao acessar analytics', async ({ request }) => {
    const res = await request.get('http://127.0.0.1:3001/v1/analytics/dashboard', {
      headers: { Authorization: `Bearer ${clienteToken}` },
    });
    expect(res.status(), 'cliente_parceiro não pode acessar analytics → 403').toBe(403);
  });

  test('Sem autenticação: GET analytics/dashboard retorna 401', async ({ request }) => {
    const res = await request.get('http://127.0.0.1:3001/v1/analytics/dashboard');
    expect(res.status()).toBe(401);
  });

  test('Validação: mesAno com formato inválido retorna 400', async ({ request }) => {
    const res = await request.get('http://127.0.0.1:3001/v1/analytics/dashboard?mesAno=invalid', {
      headers: { Authorization: `Bearer ${masterToken}` },
    });
    expect(res.status(), 'mesAno inválido deve retornar 400').toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('Validação: mesAno com formato errado (YYYY-MM-DD) retorna 400', async ({ request }) => {
    const res = await request.get('http://127.0.0.1:3001/v1/analytics/dashboard?mesAno=2025-12-01', {
      headers: { Authorization: `Bearer ${masterToken}` },
    });
    // Schema espera YYYY-MM, não YYYY-MM-DD
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('Validação: cliente_id com formato não-UUID retorna 400', async ({ request }) => {
    const res = await request.get('http://127.0.0.1:3001/v1/analytics/dashboard?cliente_id=not-a-uuid', {
      headers: { Authorization: `Bearer ${masterToken}` },
    });
    expect(res.status(), 'cliente_id não-UUID deve retornar 400').toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('Injeção: mesAno com SQL injection é rejeitado pelo schema', async ({ request }) => {
    // Fastify schema (pattern '^\\d{4}-\\d{2}$') deve bloquear isso com 400
    const malicious = "2026-01'; DROP TABLE lives;--";
    const res = await request.get(
      `http://127.0.0.1:3001/v1/analytics/dashboard?mesAno=${encodeURIComponent(malicious)}`,
      { headers: { Authorization: `Bearer ${masterToken}` } }
    );
    expect(res.status(), 'SQL injection via mesAno deve ser bloqueado (400)').toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });

  test('Filtro por cliente_id UUID válido retorna 200', async ({ request }) => {
    // Mesmo que o cliente_id não exista, deve retornar 200 com arrays vazios
    const fakeUuid = '00000000-0000-0000-0000-000000000001';
    const res = await request.get(
      `http://127.0.0.1:3001/v1/analytics/dashboard?cliente_id=${fakeUuid}`,
      { headers: { Authorization: `Bearer ${masterToken}` } }
    );
    expect(res.ok(), `cliente_id UUID válido mas inexistente deve retornar 200: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('kpis');
    expect(body.kpis.faturamento_total).toBe(0);
    expect(body.kpis.total_vendas).toBe(0);
    expect(body.kpis.ticket_medio).toBe(0);
  });
});

// ── Testes de UI (Flutter Web via flt-semantics) ──────────────────────────────

test.describe('[UI] Tela Analytics Dashboard', () => {
  // UI tests include Flutter startup + form login + screen render — needs more time
  test.setTimeout(60000);

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 20000 });
    await page.waitForTimeout(2000);
  });

  test('Sidebar de franqueador_master mostra "Analytics"', async ({ page }) => {
    // loginViaAPI already waits for networkidle + 4s after form submit
    await loginViaAPI(page, E2E_USERS.franqueador_master.email, E2E_USERS.franqueador_master.senha);

    const hasAnalytics = await hasSemanticsNode(page, 'button', 'Analytics');
    expect(hasAnalytics, 'Sidebar deve mostrar "Analytics" para franqueador_master').toBe(true);
  });

  test('Tela Analytics carrega com mais de 10 semantics nodes', async ({ page }) => {
    await loginViaAPI(page, E2E_USERS.franqueador_master.email, E2E_USERS.franqueador_master.senha);

    await clickSidebarItem(page, 'Analytics');
    const nodeCount = await waitForScreenWithNodes(page, 10, 15000);
    expect(nodeCount, 'Tela Analytics deve ter ≥ 10 semantics nodes').toBeGreaterThanOrEqual(10);
  });

  test('Tela Analytics não exibe estado de erro', async ({ page }) => {
    await loginViaAPI(page, E2E_USERS.franqueador_master.email, E2E_USERS.franqueador_master.senha);

    await clickSidebarItem(page, 'Analytics');
    await waitForScreenWithNodes(page, 10, 15000);

    const hasError = await hasErrorState(page);
    expect(hasError, 'Tela Analytics não deve ter estado de erro').toBe(false);
  });

  test('Tela Analytics exibe ao menos um valor monetário (R$)', async ({ page }) => {
    await loginViaAPI(page, E2E_USERS.franqueador_master.email, E2E_USERS.franqueador_master.senha);

    await clickSidebarItem(page, 'Analytics');
    await waitForScreenWithNodes(page, 10, 15000);

    const texts = await getAllSemanticsText(page);
    const hasMoneyValue = texts.some(t =>
      t.includes('R$') || t.toLowerCase().includes('faturamento') ||
      t.toLowerCase().includes('ticket') || t.toLowerCase().includes('vendas')
    );
    expect(hasMoneyValue, 'Tela Analytics deve exibir KPI financeiro ou label monetário').toBe(true);
  });

  test('franqueado consegue acessar Analytics via sidebar', async ({ page }) => {
    await loginViaAPI(page, E2E_USERS.franqueado.email, E2E_USERS.franqueado.senha);

    const hasAnalytics = await hasSemanticsNode(page, 'button', 'Analytics');
    expect(hasAnalytics, 'Franqueado também deve ver "Analytics" no sidebar').toBe(true);

    await clickSidebarItem(page, 'Analytics');
    await waitForScreenWithNodes(page, 5, 15000);

    const hasError = await hasErrorState(page);
    expect(hasError, 'franqueado não deve ver erro ao acessar Analytics').toBe(false);
  });
});
