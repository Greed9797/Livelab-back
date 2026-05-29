import { test, expect } from '@playwright/test';
import { waitForFlutter, E2E_USERS } from '../helpers/auth.js';

test.describe('Autenticação', () => {
  test('health check do backend responde ok', async ({ request }) => {
    const res = await request.get('http://127.0.0.1:3001/health');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('login via API retorna tokens válidos', async ({ request }) => {
    const res = await request.post('http://127.0.0.1:3001/v1/auth/login', {
      data: { email: E2E_USERS.franqueado.email, senha: E2E_USERS.franqueado.senha },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('access_token');
    expect(body).toHaveProperty('refresh_token');
    expect(body.user).toMatchObject({
      email: E2E_USERS.franqueado.email,
      papel: 'franqueado',
    });
  });

  test('login com credenciais inválidas retorna 401', async ({ request }) => {
    const res = await request.post('http://127.0.0.1:3001/v1/auth/login', {
      data: { email: E2E_USERS.franqueado.email, senha: 'senhaerrada' },
    });
    expect(res.status()).toBe(401);
  });

  test('E2E bootstrap auto-login carrega dashboard completo', async ({ page }) => {
    // In E2E build (dart-define=E2E_TESTING=true), bootstrapE2EAuth auto-logs in
    // so the app starts directly on the dashboard — login form never appears.
    // This test verifies the auto-login path works end-to-end.
    await page.goto('/');
    await waitForFlutter(page);

    // Dashboard fully rendered: 53 flt-semantics nodes confirmed in discovery
    const semCount = await page.evaluate(
      () => document.querySelectorAll('flt-semantics').length
    );
    expect(semCount).toBeGreaterThan(10);

    // Nav items present as role=button with textContent
    const hasNavItem = await page.evaluate(() =>
      Array.from(document.querySelectorAll('flt-semantics[role="button"]'))
        .some(n => (n.textContent || '').trim() === 'Financeiro')
    );
    expect(hasNavItem).toBe(true);
  });
});
