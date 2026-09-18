import { defineConfig, devices } from '@playwright/test';

// End-to-end against the production bundle (`vite preview` of dist/). The `live:` specs read Arc mainnet through the
// public RPC and skip themselves if it is unreachable; nothing here needs a wallet or a key.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // the public RPC rate-limits bursts; one browser at a time keeps the live reads honest
  reporter: process.env.CI ? 'html' : 'list',
  use: {
    baseURL: 'http://localhost:4173/',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173/',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
