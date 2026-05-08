import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/routes/**/*.js', 'src/plugins/**/*.js', 'src/services/**/*.js'],
      exclude: [
        'src/**/__tests__/**',
        'src/**/*.test.js',
      ],
      // Baseline atual: ~21% (62 testes cobrem fluxos críticos isolados).
      // Threshold pinned em 20% — alarm de REGRESSÃO, não meta.
      // Aumentar gradualmente conforme novos testes (alvo Wave 2: 50%).
      thresholds: {
        lines:    20,
        branches: 15,
        functions: 20,
        statements: 20,
      },
    },
  },
})
