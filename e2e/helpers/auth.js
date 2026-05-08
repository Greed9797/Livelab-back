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
 * Polling até semantics tree estar populada com pelo menos 1 botão.
 * Substitui waitForTimeout fixo (que falhava em swiftshader heavy).
 */
async function enableA11y(page) {
  // 1. Click placeholder (idempotente — múltiplos clicks ok)
  await page.evaluate(() => {
    const placeholder = document.querySelector('flt-semantics-placeholder');
    if (placeholder) {
      placeholder.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  });

  // 2. Polling: aguardar pelo menos 1 flt-semantics button aparecer (max 10s)
  await page.waitForFunction(
    () => {
      const nodes = document.querySelectorAll('flt-semantics[role="button"]');
      return nodes.length > 0;
    },
    { timeout: 10000, polling: 200 },
  ).catch(() => {
    // Re-click placeholder e tentar de novo (semantics pode ter sido limpo)
    return page.evaluate(() => {
      const ph = document.querySelector('flt-semantics-placeholder');
      if (ph) ph.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  });
}

/**
 * Acha botão ENTRAR no semantics tree. Retorna posição ou null.
 */
async function findEntrarButton(page) {
  return page.evaluate(() => {
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
    const cx = ex + ew / 2;

    return {
      emailX: cx,
      emailY: ey - 112,
      passwordX: cx,
      passwordY: ey - 48,
      entrarX: cx,
      entrarY: ey + eh / 2,
    };
  });
}

/**
 * Login via UI — drive form real do Flutter Web.
 * Tem retry interno (3×) caso semantics tree ainda não esteja pronto.
 */
export async function loginViaAPI(page, email, senha) {
  let formPos = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await enableA11y(page);

    // Polling explícito até ENTRAR aparecer (max 8s por tentativa)
    try {
      await page.waitForFunction(
        () => {
          const nodes = Array.from(document.querySelectorAll('flt-semantics'));
          return nodes.some(
            n => n.getAttribute('role') === 'button' && n.textContent?.trim() === 'ENTRAR',
          );
        },
        { timeout: 8000, polling: 250 },
      );
    } catch (_) {
      // Timeout — retry
    }

    formPos = await findEntrarButton(page);
    if (formPos) break;

    // Não achou — re-disparar placeholder e tentar de novo
    await page.waitForTimeout(500);
  }

  if (!formPos) {
    // Última chance: dump DOM pra debug
    const debug = await page.evaluate(() => {
      return {
        url: location.href,
        flt_semantics_count: document.querySelectorAll('flt-semantics').length,
        flt_buttons: Array.from(document.querySelectorAll('flt-semantics[role="button"]'))
          .map(n => n.textContent?.trim())
          .filter(Boolean)
          .slice(0, 10),
        has_placeholder: !!document.querySelector('flt-semantics-placeholder'),
      };
    });
    throw new Error(
      `loginViaAPI: ENTRAR não achado para ${email} após 3 tentativas. ` +
      `DOM debug: ${JSON.stringify(debug)}`,
    );
  }

  // 3. Click email + type
  await page.mouse.click(formPos.emailX, formPos.emailY);
  await page.waitForTimeout(500);
  await page.keyboard.type(email, { delay: 20 });

  // 4. Tab + senha
  await page.keyboard.press('Tab');
  await page.waitForTimeout(300);
  await page.keyboard.type(senha, { delay: 20 });

  // 5. Submit
  await page.mouse.click(formPos.entrarX, formPos.entrarY);

  // 6. Aguarda dashboard carregar
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
