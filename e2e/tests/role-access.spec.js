import { test, expect } from '@playwright/test';
import { E2E_USERS } from '../helpers/auth.js';

test.describe('Controle de Acesso por Papel (RBAC)', () => {
  test('cliente_parceiro não acessa rota de franqueado', async ({ request }) => {
    // Login as cliente_parceiro
    const loginRes = await request.post('http://127.0.0.1:3001/v1/auth/login', {
      data: { email: E2E_USERS.cliente_parceiro.email, senha: E2E_USERS.cliente_parceiro.senha },
    });
    expect(loginRes.ok()).toBeTruthy();
    const { access_token } = await loginRes.json();

    // Try to access cabines (franqueado/franqueador_master only)
    const res = await request.get('http://127.0.0.1:3001/v1/cabines', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    // Should be 403 (forbidden) for cliente_parceiro
    expect(res.status()).toBe(403);
  });

  test('franqueado não acessa rota de franqueador_master', async ({ request }) => {
    const loginRes = await request.post('http://127.0.0.1:3001/v1/auth/login', {
      data: { email: E2E_USERS.franqueado.email, senha: E2E_USERS.franqueado.senha },
    });
    const { access_token } = await loginRes.json();

    // GET /v1/franqueado/unidades requires franqueador_master
    const res = await request.get('http://127.0.0.1:3001/v1/franqueado/unidades', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(res.status()).toBe(403);
  });

  test('sem token retorna 401', async ({ request }) => {
    const res = await request.get('http://127.0.0.1:3001/v1/financeiro/resumo');
    expect(res.status()).toBe(401);
  });

  test('token inválido retorna 401', async ({ request }) => {
    const res = await request.get('http://127.0.0.1:3001/v1/financeiro/resumo', {
      headers: { Authorization: 'Bearer token-invalido-aqui' },
    });
    expect(res.status()).toBe(401);
  });
});
