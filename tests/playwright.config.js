// Playwright configuration for the Pelham Civic Guide test suite.
//
// The suite runs against the LIVE deployed site — there is no local server to
// start. `npm run test:ui` exercises the rendered page; `npm run test:ai` calls
// the live `/api/ask` serverless function (which talks to Anthropic), so those
// tests are slower and get a generous timeout.

const { defineConfig, devices } = require('@playwright/test');

const BASE_URL =
  process.env.PELHAM_BASE_URL || 'https://pelhamengagementproject.netlify.app';

module.exports = defineConfig({
  // Config lives in tests/, so "." is the tests/ directory itself.
  testDir: '.',
  testMatch: '*.spec.js',

  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list']],

  // AI tests wait on a live LLM round-trip; keep the ceiling high.
  timeout: 90_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    extraHTTPHeaders: { 'Content-Type': 'application/json' },
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Wide enough that the full one-row nav bar lays out without clipping.
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
