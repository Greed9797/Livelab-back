/**
 * Flutter CanvasKit Navigation Helpers
 *
 * Flutter Web with CanvasKit renders everything to <canvas>.
 * The accessibility tree is exposed via <flt-semantics> custom elements.
 * All interaction happens through these nodes — no native HTML form elements.
 *
 * Patterns confirmed in existing tests:
 *   - Nav items: flt-semantics[role="button"] with textContent matching the label
 *   - page.getByRole('button', { name: 'Label' }).first().click()
 *   - countSemanticsNodes() > 10 = full screen rendered
 */

/**
 * Click a sidebar navigation item by its visible label.
 * Waits 3s after click for Flutter to re-render the new screen.
 */
export async function clickSidebarItem(page, label) {
  // Flutter CanvasKit: dispatchEvent does NOT trigger Flutter's navigation handler.
  // Must use page.mouse.click() with real viewport coordinates from getBoundingClientRect().
  const pos = await page.evaluate((label) => {
    const btn = Array.from(document.querySelectorAll('flt-semantics[role="button"]'))
      .find(n => (n.textContent || '').trim().includes(label));
    if (!btn) return null;
    const rect = btn.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, label);

  if (pos) {
    await page.mouse.click(pos.x, pos.y);
  } else {
    // Fallback to Playwright getByRole
    await page.getByRole('button', { name: label }).first().click();
  }
  await page.waitForTimeout(3000);
}

/**
 * Check if a flt-semantics node with the given role and partial text exists.
 */
export async function hasSemanticsNode(page, role, text) {
  // Ensure accessibility is enabled before checking
  await page.evaluate(() => {
    const placeholder = document.querySelector('flt-semantics-placeholder');
    if (placeholder) placeholder.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForTimeout(500);

  return page.evaluate(({ role, text }) => {
    return Array.from(document.querySelectorAll(`flt-semantics[role="${role}"]`))
      .some(n => (n.textContent || '').trim().includes(text));
  }, { role, text });
}

/**
 * Return the number of flt-semantics nodes currently in the DOM.
 * A count > 10 generally means a full-featured screen has rendered.
 * Enables accessibility tree first if not already enabled.
 */
export async function countSemanticsNodes(page) {
  // Enable accessibility if placeholder still exists
  await page.evaluate(() => {
    const p = document.querySelector('flt-semantics-placeholder');
    if (p) p.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  return page.evaluate(() => document.querySelectorAll('flt-semantics').length);
}

/**
 * Get all visible text content from flt-semantics nodes.
 * Useful for debugging what Flutter has rendered.
 */
export async function getAllSemanticsText(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('flt-semantics'))
      .map(n => (n.textContent || '').trim())
      .filter(Boolean);
  });
}

/**
 * Simulate logout by clearing FlutterSecureStorage tokens from localStorage.
 * Reloads the page, which returns the app to the login screen (no tokens).
 */
export async function logout(page) {
  await page.evaluate(() => {
    localStorage.removeItem('FlutterSecureStorage.access_token');
    localStorage.removeItem('FlutterSecureStorage.refresh_token');
    localStorage.removeItem('FlutterSecureStorage.auth_user');
  });
  await page.reload();
  await page.waitForLoadState('networkidle', { timeout: 20000 });
  await page.waitForTimeout(3000);
}

/**
 * Wait for Flutter to render a screen that has at least `minNodes` flt-semantics nodes.
 * Polls up to `maxWaitMs` milliseconds.
 */
export async function waitForScreenWithNodes(page, minNodes = 10, maxWaitMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const count = await countSemanticsNodes(page);
    if (count >= minNodes) return count;
    await page.waitForTimeout(500);
  }
  const finalCount = await countSemanticsNodes(page);
  if (finalCount < minNodes) {
    throw new Error(`Timeout: esperado ${minNodes} semantics nodes, encontrado ${finalCount}`);
  }
  return finalCount;
}

/**
 * Check if the screen shows an error state (common Flutter error texts).
 */
export async function hasErrorState(page) {
  return page.evaluate(() => {
    const texts = Array.from(document.querySelectorAll('flt-semantics'))
      .map(n => (n.textContent || '').toLowerCase().trim());
    const errorPatterns = ['erro ao carregar', 'error', 'exception', 'não autenticado'];
    return texts.some(t => errorPatterns.some(p => t.includes(p)));
  });
}
