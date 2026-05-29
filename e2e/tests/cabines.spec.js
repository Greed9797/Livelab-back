import { test, expect } from '@playwright/test';
import { waitForFlutter } from '../helpers/auth.js';

test.describe('Cabines', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForFlutter(page);
  });

  test('tela de cabines carrega via navegação', async ({ page }) => {
    // Nav items: role=button, textContent matches label (no aria-label)
    await page.getByRole('button', { name: 'Cabines' }).first().click();
    await page.waitForTimeout(3000);
    // Semantics nodes still present = Flutter rendered cabines screen
    const semCount = await page.evaluate(
      () => document.querySelectorAll('flt-semantics').length
    );
    expect(semCount).toBeGreaterThan(5);
  });

  test('API cabines retorna lista', async ({ request }) => {
    const loginRes = await request.post('http://127.0.0.1:3001/v1/auth/login', {
      data: { email: 'franqueado@liveshop.com', senha: 'teste123' },
    });
    const { access_token } = await loginRes.json();

    const res = await request.get('http://127.0.0.1:3001/v1/cabines', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});
