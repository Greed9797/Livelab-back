import { test, expect } from '@playwright/test';
import { E2E_USERS } from '../helpers/auth.js';

const API = 'http://127.0.0.1:3001';

/**
 * Helper: faz login via API e retorna o access_token.
 * Retorna null se o usuário não tiver credenciais configuradas.
 */
async function loginAs(request, userKey) {
  const user = E2E_USERS[userKey];
  if (!user) return null;
  const res = await request.post(`${API}/v1/auth/login`, {
    data: { email: user.email, senha: user.senha },
  });
  if (!res.ok()) return null;
  const body = await res.json();
  return body.access_token ?? null;
}

test.describe('Roles e Permissões — acesso a endpoints financeiros', () => {

  // ─── cliente_parceiro não acessa /v1/financeiro/resumo ────────────────────
  test('cliente_parceiro não acessa /v1/financeiro/resumo — espera 403', async ({ request }) => {
    const token = await loginAs(request, 'cliente_parceiro');

    // cliente_parceiro está em E2E_USERS mas não em READ_FINANCEIRO
    // (READ_FINANCEIRO = ADMIN + financeiro + financeiro_readonly + auditor)
    const res = await request.get(`${API}/v1/financeiro/resumo`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status()).toBe(403);
  });

  // ─── operacional não acessa /v1/financeiro/resumo ─────────────────────────
  test('operacional não acessa /v1/financeiro/resumo — espera 403', async ({ request }) => {
    // Não há usuário 'operacional' nos E2E_USERS do seed padrão.
    // Se o seed não incluir esse papel, o teste é pulado com comentário.
    const OPERACIONAL_EMAIL = 'operacional@liveshop.com';
    const OPERACIONAL_SENHA = 'teste123';

    const loginRes = await request.post(`${API}/v1/auth/login`, {
      data: { email: OPERACIONAL_EMAIL, senha: OPERACIONAL_SENHA },
    });

    if (!loginRes.ok()) {
      test.skip(true, 'Usuário operacional não existe no seed — precisa de dados de seed');
      return;
    }

    const { access_token: token } = await loginRes.json();

    const res = await request.get(`${API}/v1/financeiro/resumo`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    // 'operacional' não está em READ_FINANCEIRO (apenas ADMIN + papéis financeiros)
    expect(res.status()).toBe(403);
  });

  // ─── franqueador_master acessa /v1/financeiro/franqueadora ────────────────
  test('franqueador_master acessa /v1/financeiro/franqueadora com 200', async ({ request }) => {
    const token = await loginAs(request, 'franqueador_master');

    const res = await request.get(`${API}/v1/financeiro/franqueadora`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();
    // Resposta deve ter a estrutura definida na rota
    expect(body).toHaveProperty('franqueados');
    expect(body).toHaveProperty('periodo');
    expect(Array.isArray(body.franqueados)).toBe(true);
  });

  // ─── franqueado não acessa /v1/financeiro/franqueadora ────────────────────
  test('franqueado não acessa /v1/financeiro/franqueadora — espera 403', async ({ request }) => {
    const token = await loginAs(request, 'franqueado');

    // requirePapel(['franqueador_master']) — franqueado não está na lista
    const res = await request.get(`${API}/v1/financeiro/franqueadora`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status()).toBe(403);
  });

  // ─── apresentador não acessa /v1/financeiro/resumo ────────────────────────
  test('apresentador não acessa /v1/financeiro/resumo — espera 403', async ({ request }) => {
    const token = await loginAs(request, 'apresentador');

    if (!token) {
      test.skip(true, 'Usuário apresentador não existe no seed — precisa de dados de seed');
      return;
    }

    const res = await request.get(`${API}/v1/financeiro/resumo`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    // 'apresentador' não está em READ_FINANCEIRO
    expect(res.status()).toBe(403);
  });

  // ─── franqueado acessa /v1/financeiro/resumo (papel ADMIN) ────────────────
  test('franqueado acessa /v1/financeiro/resumo — papel dentro de ADMIN', async ({ request }) => {
    const token = await loginAs(request, 'franqueado');

    const res = await request.get(`${API}/v1/financeiro/resumo`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    // franqueado está em ADMIN → READ_FINANCEIRO → deve retornar 200
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('fat_bruto');
    expect(body).toHaveProperty('fat_liquido');
  });

  // ─── request sem token retorna 401 em rotas protegidas ────────────────────
  test('request sem token retorna 401 em /v1/financeiro/resumo', async ({ request }) => {
    const res = await request.get(`${API}/v1/financeiro/resumo`);
    expect(res.status()).toBe(401);
  });

  test('request sem token retorna 401 em /v1/financeiro/franqueadora', async ({ request }) => {
    const res = await request.get(`${API}/v1/financeiro/franqueadora`);
    expect(res.status()).toBe(401);
  });

});
