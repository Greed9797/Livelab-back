import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: 'http://localhost:8080',
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      // Backend API server (este repo)
      command: 'node src/server.js',
      cwd: '..', // path relativo a e2e/
      port: 3001,
      reuseExistingServer: true,
      timeout: 30000,
    },
    {
      // Flutter web build — clone Playground (ativo).
      // Pré-requisito: rodar `flutter build web --release` antes do `npm run e2e`.
      // Override via env: E2E_FRONTEND_DIR.
      command: 'npx serve build/web -l 8080 -s',
      cwd: process.env.E2E_FRONTEND_DIR ?? '/Users/vitormiguelgoedertdaluz/Documents/Playground/-liveshop_saas-frontend-',
      port: 8080,
      reuseExistingServer: true,
      timeout: 15000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        // SwiftShader (software WebGL) — required for CanvasKit in headless mode.
        // Without this, WebGL context is lost and Flutter crashes mid-render.
        launchOptions: {
          args: [
            '--use-gl=swiftshader',
            '--disable-gpu-sandbox',
            '--enable-webgl',
            '--ignore-gpu-blocklist',
          ],
        },
      },
    },
  ],
});
