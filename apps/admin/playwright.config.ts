import { defineConfig, devices } from '@playwright/test';

import { defineConfig, devices } from '@playwright/test';

/**
 * Prefer an already-running `npm run admin` via ADMIN_UI_URL
 * (e.g. http://localhost:5174 when 5173 is taken). Otherwise start
 * the admin workspace and hit the default Vite port.
 */
const baseURL = process.env['ADMIN_UI_URL'] ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    trace: 'on-first-retry',
  },
  webServer: process.env['ADMIN_UI_URL']
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
