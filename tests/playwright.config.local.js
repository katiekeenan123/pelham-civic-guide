// Local variant of playwright.config.js.
//
// The default config runs the suite against the LIVE deployed site, which
// means `npm test` cannot tell you anything about uncommitted work - it will
// happily pass while your working tree is broken, and fail on a deploy
// problem that has nothing to do with your edits. This config points at a
// local static server instead, so `npm run test:local` exercises the
// index.html actually on disk.
//
// Scope: UI tests only. ai.spec.js calls /api/ask, which is a Netlify
// function that does not exist in front of a static server; including it here
// would produce guaranteed failures that mean nothing. Run `npm run test:ai`
// against the deployed site for that half.

const path = require('path');
const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.PORT) || 8080;
const BASE_URL = 'http://127.0.0.1:' + PORT;

module.exports = defineConfig({
  testDir: '.',
  testMatch: 'ui.spec.js',

  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],

  // No live LLM round-trip here, so the ceiling can be much lower than the
  // deployed config's 90s. A local page that takes 30s has a real problem.
  timeout: 30_000,
  expect: { timeout: 5_000 },

  webServer: {
    command: 'node tests/static-server.js',
    url: BASE_URL + '/index.html',
    cwd: path.resolve(__dirname, '..'),
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: 20_000,
  },

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Match the deployed config: wide enough for the one-row nav bar.
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
