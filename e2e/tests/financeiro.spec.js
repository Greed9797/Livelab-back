import { test, expect } from '@playwright/test';
import { waitForFlutter } from '../helpers/auth.js';

test.describe('Financeiro', () => {
  let accessToken;

  test.beforeAll(async ({ request }) => {
    const res = await request.post('http://127.0.0.1:3001/v1/auth/login', {
      data: { email: 'franqueado@liveshop.com', senha: 'teste123' },
    });
    const body = await res.json();
    accessToken = body.access_token;
  });

  test('tela financeiro carrega via navegação', async ({ page }) => {
    await page.goto('/');
    await waitForFlutter(page);
    // Nav items: role=button, textContent matches label (no aria-label)
    await page.getByRole('button', { name: 'Financeiro' }).first().click();
    await page.waitForTimeout(3000);
    // At least some semantics nodes = Flutter still rendering
    const semCount = await page.evaluate(
      () => document.querySelectorAll('flt-semantics').length
    );
    expect(semCount).toBeGreaterThan(5);
  });

  test('POST custos retorna 201 (fix RLS validado)', async ({ request }) => {
    const res = await request.post('http://127.0.0.1:3001/v1/financeiro/custos', {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: {
        descricao: 'Custo E2E Teste',
        valor: 500,
        tipo: 'outros',
        competencia: '2026-04-01',
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty('id');
    expect(body.descricao).toBe('Custo E2E Teste');
    expect(body.valor).toBe(500);
  });

  test('GET custos lista o custo criado', async ({ request }) => {
    const res = await request.get('http://127.0.0.1:3001/v1/financeiro/custos?mes=2026-04', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const custo = body.find(c => c.descricao === 'Custo E2E Teste');
    expect(custo).toBeDefined();
  });
});
