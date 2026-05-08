/**
 * E2E Auth Helpers
 *
 * Flutter Web (CanvasKit) rendering notes:
 *
 * - FlutterSecureStorage web uses AES-GCM encrypted localStorage — plaintext injection
 *   does NOT work. Session must be established via the real login UI.
 *
 * - Accessibility tree is opt-in: Flutter renders a hidden <flt-semantics-placeholder>
 *   button; clicking it (via JS dispatchEvent) enables <flt-semantics> nodes.
 *
 * - Login form fields are interactive flt-semantics nodes without role attributes.
 *   We detect them relative to the ENTRAR button position.
 *
 * - After login the Flutter SPA navigates internally (no page reload).
 *   waitForFlutter handles networkidle + 4s for the new screen to settle.
 */

/**
 * Enable Flutter accessibility tree on the current page.
 * Must be called before any flt-semantics interaction.
 */
async function enableA11y(page) {
  await page.evaluate(() => {
    const placeholder = document.querySelector('flt-semantics-placeholder');
    if (placeholder) {
      placeholder.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  });
  // Wait for semantics tree to build
  await page.waitForTimeout(1500);
}

/**
 * Log in by filling the visible Flutter login form.
 * Works regardless of FlutterSecureStorage encryption because it drives the real UI.
 *
 * Precondition: page must already be on the app URL (login screen visible).
 */
export async function loginViaAPI(page, email, senha) {
  // 1. Enable accessibility so we can interact with flt-semantics nodes
  await enableA11y(page);

  // 2. Locate ENTRAR button as a positional anchor
  const formPos = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('flt-semantics'));
    const entrar = nodes.find(
      n => n.getAttribute('role') === 'button' && n.textContent?.trim() === 'ENTRAR'
    );
    if (!entrar) return null;

    const m = entrar.style.transform.match(/matrix\(1,\s*0,\s*0,\s*1,\s*([\d.]+),\s*([\d.]+)\)/);
    if (!m) return null;
    const ex = parseFloat(m[1]);
    const ey = parseFloat(m[2]);
    const ew = parseFloat(entrar.style.width) || 338;
    const eh = parseFloat(entrar.style.height) || 32;
    const cx = ex + ew / 2; // horizontal center of form

    // Email field is ~136px above ENTRAR top; password ~72px above ENTRAR top
    return {
      emailX: cx,
      emailY: ey - 112,       // center of email input
      passwordX: cx,
      passwordY: ey - 48,     // center of password input
      entrarX: cx,
      entrarY: ey + eh / 2,   // center of ENTRAR button
    };
  });

  if (!formPos) {
    throw new Error(`loginViaAPI: login form (ENTRAR button) not found for ${email}`);
  }

  // 3. Click email field and type
  await page.mouse.click(formPos.emailX, formPos.emailY);
  await page.waitForTimeout(500);
  await page.keyboard.type(email, { delay: 20 });

  // 4. Tab to password field and type
  await page.keyboard.press('Tab');
  await page.waitForTimeout(300);
  await page.keyboard.type(senha, { delay: 20 });

  // 5. Submit form
  await page.mouse.click(formPos.entrarX, formPos.entrarY);

  // 6. Wait for the dashboard to load (networkidle = API calls settled)
  await page.waitForLoadState('networkidle', { timeout: 20000 });
  await page.waitForTimeout(4000);
}

export async function waitForFlutter(page) {
  // Wait for Flutter to finish rendering — 53+ semantics nodes = dashboard ready
  // The URL change alone is not enough; wait for network to settle + semantics to build
  await page.waitForLoadState('networkidle', { timeout: 20000 });
  await page.waitForTimeout(4000);
}

export const E2E_USERS = {
  franqueado: {
    email: 'franqueado@liveshop.com',
    senha: 'teste123',
    role: 'franqueado',
  },
  cliente_parceiro: {
    email: 'cliente@liveshop.com',
    senha: 'teste123',
    role: 'cliente_parceiro',
  },
  // demo_cliente is seeded by seed_demo_data.js — use as primary for booking tests
  demo_cliente: {
    email: 'demo_cliente@liveshop.com',
    senha: 'teste123',
    role: 'cliente_parceiro',
  },
  franqueador_master: {
    email: 'admin@liveshop.com',
    senha: 'admin123',
    role: 'franqueador_master',
  },
  apresentador: {
    email: 'apresentador@liveshop.com',
    senha: 'teste123',
    role: 'apresentador',
  },
};
