import { defineConfig } from '@playwright/test';

// npm run test:browser: browser correctness only, no timing.
const port = 4187;

export default defineConfig({
  testDir: 'test/browser',
  testMatch: /.*\.pw\.ts/,
  outputDir: 'work/playwright',
  retries: 0,
  timeout: 120_000,
  use: { baseURL: `http://127.0.0.1:${String(port)}` },
  webServer: {
    command: `node test/browser/server.mjs ${String(port)}`,
    url: `http://127.0.0.1:${String(port)}/test/browser/page/probe.html`,
    reuseExistingServer: false,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
